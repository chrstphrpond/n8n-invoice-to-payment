// Reminders and the watchdog. The clock is a parameter: the schedule passes "now", a signed sweep request may
// pass as_of when INVOICE_CLOCK_OVERRIDE is "allow" (tests and replays), and nothing else reads the time.

// requested: data.as_of from a sweep request or null. Returns { ms, overridden }.
function resolveAsOf(requested, overrideSetting, nowMs) {
  if (requested && overrideSetting === 'allow') return { ms: Date.parse(requested), overridden: true };
  return { ms: nowMs, overridden: false };
}

// Invoices that were delivered and are past their due date on asOfDate (YYYY-MM-DD).
function pickOverdue(invoices, asOfDate) {
  return (invoices || []).filter(invoice => invoice.status === 'sent' && invoice.due_date < asOfDate);
}

// For each overdue invoice: the highest reminder step reached (steps: days after the due date, from config).
// It is sent only if neither it nor a later step was sent before; earlier steps that were missed are not sent late.
// Paid, over-paid and refunded invoices get nothing. Returns { candidates, skipped }.
function planReminders(input) {
  const steps = [...input.steps].sort((a, b) => a - b);
  const candidates = [];
  const skipped = [];
  for (const invoice of pickOverdue(input.invoices, input.asOfDate)) {
    const money = invoiceMoney(invoice, input.payments, input.refunds);
    const skip = reason => skipped.push({ invoice_id: invoice.id, number: invoice.number, reason });
    if (money.state === 'paid' || money.state === 'overpaid') { skip('paid'); continue; }
    if (money.state === 'refunded' || money.state === 'partially_refunded') { skip('refunded'); continue; }
    const daysOverdue = daysBetween(invoice.due_date, input.asOfDate);
    const reached = steps.filter(step => step <= daysOverdue);
    if (!reached.length) { skip('no_step_reached'); continue; }
    const top = reached[reached.length - 1];
    const sent = (input.reminders || []).filter(row => row.invoice_id === invoice.id).map(row => row.step_days);
    if (sent.some(step => step >= top)) { skip('step_already_sent'); continue; }
    const client = (input.clients || []).find(row => row.client_id === invoice.client_id);
    if (!client || !client.email) { skip('client_missing'); continue; }
    candidates.push({
      invoice_id: invoice.id, number: invoice.number, step_days: top, days_overdue: daysOverdue, balance_minor: money.balance_minor,
      currency: invoice.currency, missed_steps: reached.filter(step => step < top && !sent.includes(step)),
    });
  }
  return { candidates, skipped };
}

function reminderKey(candidate) {
  return candidate.invoice_id + ':d' + candidate.step_days;
}

function reminderRow(candidate, emailId, asOfDate) {
  return { row: { invoice_id: candidate.invoice_id, invoice_number: candidate.number, step_days: candidate.step_days, as_of: asOfDate, days_overdue: candidate.days_overdue, balance_minor: candidate.balance_minor, currency: candidate.currency, email_id: emailId, status: 'sent' } };
}

function reminderReviewRow(candidate, config) {
  return {
    row: {
      source_event_id: 'reminder:' + reminderKey(candidate), kind: 'reminder_state_unknown', invoice_id: candidate.invoice_id, invoice_number: candidate.number, payment_id: null,
      amount_minor: candidate.balance_minor, currency: candidate.currency,
      detail: 'Billing review: ' + REVIEW_TEXT.reminder_state_unknown + '. Invoice ' + candidate.number + ' (' + candidate.invoice_id + '), step ' + candidate.step_days + ' days, open ' + moneyIn(config, candidate.balance_minor, candidate.currency) + '.',
    },
  };
}

function ageMinutes(createdAt, nowMs) {
  return Math.floor((nowMs - Date.parse(createdAt)) / 60000);
}

// Invoices still "issued" (numbered, not delivered) after stuckAfterMinutes, and invoice numbers taken from the
// sequence with no invoice row after the same time (a gap in the making).
function findStuck(invoices, numbers, nowMs, stuckAfterMinutes) {
  const old = row => row.created_at && ageMinutes(row.created_at, nowMs) >= stuckAfterMinutes;
  const stuckInvoices = (invoices || []).filter(row => row.status === 'issued' && old(row))
    .map(row => ({ kind: 'invoice', ref: row.id, invoice_id: row.id, number: row.number, age_minutes: ageMinutes(row.created_at, nowMs), pdf_stored: Boolean(row.pdf_sha256) }));
  const used = new Set((invoices || []).map(row => row.request_event_id));
  const orphanNumbers = (numbers || []).filter(row => !used.has(row.key) && old(row))
    .map(row => ({ kind: 'number', ref: row.id, sequence: row.sequence, value: row.value, age_minutes: ageMinutes(row.created_at, nowMs) }));
  return { stuck_invoices: stuckInvoices, orphan_numbers: orphanNumbers };
}

function watchdogAlert(channel, findings, stuckAfterMinutes) {
  const lines = ['Invoice watchdog:'];
  if (findings.stuck_invoices.length) {
    lines.push(findings.stuck_invoices.length + ' invoice(s) not delivered after ' + stuckAfterMinutes + ' minutes:');
    for (const item of findings.stuck_invoices) lines.push('- ' + item.number + ' (' + item.invoice_id + '), issued ' + item.age_minutes + ' min ago, PDF ' + (item.pdf_stored ? 'stored' : 'not stored'));
  }
  if (findings.orphan_numbers.length) {
    lines.push(findings.orphan_numbers.length + ' invoice number(s) taken with no invoice row:');
    for (const item of findings.orphan_numbers) lines.push('- ' + item.sequence + ' #' + item.value + ' (' + item.ref + '), taken ' + item.age_minutes + ' min ago');
  }
  return { channel, text: lines.join('\n'), unfurl_links: false };
}
