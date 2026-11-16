// Invoice planning: business checks before a number is taken, the row that is stored, and where a delivery
// stands. A number is allocated only after every check has passed, so a refused request never leaves a gap.

function sequenceNameFor(issueDate) {
  return 'invoice-' + issueDate.slice(0, 4);
}

// config.number_prefix "CRIT-", number_digits 4: year 2026, value 7 -> "CRIT-2026-0007".
function formatInvoiceNumber(config, issueDate, value) {
  return config.number_prefix + issueDate.slice(0, 4) + '-' + String(value).padStart(config.number_digits, '0');
}

function issueDateOf(event, timezone) {
  return event.data.issue_date || localDate(Date.parse(event.created_at), timezone);
}

// existing: the invoice already stored for this request event (a replay), or null.
// Returns { route: accept | reject, has_invoice, invoice | draft, reasons }.
function planInvoice(event, config, clients, existing) {
  if (existing) return { route: 'accept', has_invoice: true, invoice: existing, draft: null, reasons: [] };
  const data = event.data;
  const reasons = [];
  const client = (clients || []).find(candidate => candidate.client_id === data.client_id) || null;
  if (!client) reasons.push({ code: 'unknown_client', message: 'client ' + data.client_id + ' is not in the client list' });
  else if (client.status !== 'active') reasons.push({ code: 'client_inactive', message: 'client ' + data.client_id + ' is not active' });
  else if (client.currency !== data.currency) reasons.push({ code: 'currency_mismatch', message: 'client ' + data.client_id + ' is billed in ' + client.currency + ', not ' + data.currency });
  if (minorUnitsOf(config, data.currency) === null) reasons.push({ code: 'unsupported_currency', message: data.currency + ' is not a configured currency' });
  const issueDate = issueDateOf(event, config.timezone);
  if (data.due_date < issueDate) reasons.push({ code: 'due_before_issue', message: 'the due date ' + data.due_date + ' is before the issue date ' + issueDate });
  if (data.line_items.length > config.max_line_items) reasons.push({ code: 'too_many_lines', message: 'more than ' + config.max_line_items + ' line items' });
  const computed = computeTotals(data.line_items, config.tax_rates);
  for (const error of computed.errors) reasons.push({ code: 'totals_invalid', message: error });
  if (reasons.length) return { route: 'reject', has_invoice: false, invoice: null, draft: null, reasons };
  return {
    route: 'accept', has_invoice: false, invoice: null, reasons: [],
    draft: { client_id: data.client_id, currency: data.currency, issue_date: issueDate, due_date: data.due_date, po_number: data.po_number || null, sequence: sequenceNameFor(issueDate), ...computed.totals },
  };
}

// Built only from the event, the config and the allocated number: a replay sends the same bytes.
function invoiceRow(eventId, draft, number, sequenceValue) {
  return {
    row: {
      request_event_id: eventId, number, sequence: draft.sequence, sequence_value: sequenceValue, client_id: draft.client_id,
      currency: draft.currency, issue_date: draft.issue_date, due_date: draft.due_date, po_number: draft.po_number,
      line_items: draft.lines, tax_lines: draft.tax_lines, subtotal_minor: draft.subtotal_minor, tax_minor: draft.tax_minor,
      total_minor: draft.total_minor, status: 'issued', money_seq: 0,
    },
  };
}

function pdfKeyFor(invoice) {
  return 'invoices/' + invoice.issue_date.slice(0, 4) + '/' + invoice.number + '.pdf';
}

// Where a delivery stands, from the stored invoice: stop (voided meanwhile), done (sent), email (PDF stored, not
// sent), render (nothing yet).
function deliveryStep(invoice) {
  if (invoice.status === 'void') return 'stop';
  if (invoice.status === 'sent' || invoice.email_id) return 'done';
  if (invoice.pdf_sha256) return 'email';
  return 'render';
}

// Before the email step: "Record email start" stamps email_started_at (the data service's clock, kept from the
// first attempt) right before the send. A replay that finds the stamp but no email_id cannot know whether the email
// went out. Inside the resend window the same Idempotency-Key makes a resend safe; after it, the run stops with the
// invoice id so a person checks the email provider's log instead of a second email reaching the client.
function emailResendBlock(invoice, nowMs) {
  if (deliveryStep(invoice) !== 'email' || !invoice.email_started_at || withinResendWindow(invoice.email_started_at, nowMs)) return null;
  return 'Invoice ' + invoice.number + ' (' + invoice.id + '): an email send started at ' + invoice.email_started_at + ' has no recorded answer and is past the 23-hour resend window; not resent. Check the email provider\'s log for this invoice, then record email_id or void it.';
}

function pdfRequestBody(html, invoice) {
  return { html, filename: invoice.number + '.pdf', options: { format: 'A4', margin_mm: 16, print_background: true } };
}

// What leaves the data service in ledger results, alerts and summaries: ids and amounts, no contact data or line text.
function invoiceSummary(invoice) {
  return { invoice_id: invoice.id, number: invoice.number, total_minor: invoice.total_minor, currency: invoice.currency, status: invoice.status };
}

// The PDF bytes as received from the renderer: a PDF signature, a size limit, the SHA-256.
function inspectPdf(buffer, maxBytes) {
  if (!buffer || !buffer.length) return { ok: false, error: 'the renderer returned no bytes' };
  if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') return { ok: false, error: 'the renderer did not return a PDF' };
  if (buffer.length > maxBytes) return { ok: false, error: 'the PDF is ' + buffer.length + ' bytes, over the ' + maxBytes + ' limit' };
  return { ok: true, error: null, size: buffer.length, sha256: require('crypto').createHash('sha256').update(buffer).digest('hex') };
}
