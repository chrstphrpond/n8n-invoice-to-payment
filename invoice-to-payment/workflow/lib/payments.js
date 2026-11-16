// Payments: the money state of an invoice is derived from the append-only payment and refund rows, never kept
// as a running total that two runs could both update. A payment is matched against the payments that were
// recorded before it; once its row is stored, a replay reads the decision back from that row.
//
// Two runs must never both decide against the same "before" state. Every write that changes an invoice's money
// state (a payment row, a refund row, a void) therefore carries a guard: the invoice's money_seq as read before the
// decision. The data service applies the write only while money_seq still has that value and moves it on by one in
// the same step; a run that loses gets outcome conflict, reads the invoice and its rows again and decides again.
// The invoice must be read before its payment and refund rows, so a row written after that read always shows up as
// a moved money_seq. A conflict means another write won, so the retries are bounded by the writers on the invoice;
// MONEY_ATTEMPTS only stops a run that would loop on a fault.

const MONEY_ATTEMPTS = 5;
// The email API and the payment processor keep an Idempotency-Key for 24 hours. A send whose answer was lost is
// resent with the same key only while it is safely inside that window; after it, a person decides.
const RESEND_WINDOW_MS = 23 * 60 * 60 * 1000;

function moneySeqOf(invoice) {
  if (!invoice || !Number.isSafeInteger(invoice.money_seq) || invoice.money_seq < 0) throw new Error('Invoice ' + (invoice && invoice.id) + ' has no money_seq; the guarded write cannot be built');
  return invoice.money_seq;
}

// The guard for a row written beside the invoice (payments, refunds).
function moneyGuard(invoice) {
  return invoice ? { table: 'invoices', id: invoice.id, column: 'money_seq', expect: moneySeqOf(invoice) } : null;
}

// Part of the guarded write's Idempotency-Key: a new decision after a conflict is a new request, never the old key
// with a different body.
function guardTag(guard) {
  return guard ? 'seq' + guard.expect : 'unguarded';
}

// runIndex: n8n's $runIndex of the deciding node (0 on the first pass, 1 after one conflict, ...).
function moneyAttempt(runIndex, what) {
  if (!Number.isSafeInteger(runIndex) || runIndex < 0) throw new Error('No run index for ' + what);
  const attempt = runIndex + 1;
  if (attempt > MONEY_ATTEMPTS) throw new Error(what + ': the invoice changed under this run ' + MONEY_ATTEMPTS + ' times in a row; stopped instead of deciding again');
  return attempt;
}

// since: when the send could first have happened (a stamp or a row's created_at, set by the data service).
function withinResendWindow(since, nowMs) {
  const at = Date.parse(since);
  return Number.isFinite(at) && nowMs - at < RESEND_WINDOW_MS;
}

const RECEIPT_MATCHES = ['exact', 'completes', 'overpaid'];
const REVIEW_MATCHES = ['overpaid', 'already_paid', 'wrong_currency', 'unknown_reference', 'invoice_void', 'after_refund'];

function sumMinor(rows) {
  return rows.reduce((sum, row) => sum + row.amount_minor, 0);
}

// payments, refunds: rows (any invoice); only this invoice's counted payments and its refunds are used.
function invoiceMoney(invoice, payments, refunds) {
  const counted = (payments || []).filter(row => row.invoice_id === invoice.id && row.counted === true);
  const refundRows = (refunds || []).filter(row => row.invoice_id === invoice.id && row.status !== 'refused');
  const paid = sumMinor(counted);
  const refunded = sumMinor(refundRows);
  let state;
  if (invoice.status === 'void') state = 'void';
  else if (refunded > 0) state = refunded >= paid ? 'refunded' : 'partially_refunded';
  else if (paid === 0) state = 'unpaid';
  else if (paid < invoice.total_minor) state = 'partially_paid';
  else if (paid === invoice.total_minor) state = 'paid';
  else state = 'overpaid';
  return { paid_minor: paid, refunded_minor: refunded, balance_minor: invoice.total_minor - paid, state };
}

// A replay: the run that stored this row died later. The row is not written again; the run goes on from it.
function matchFromRow(row) {
  return {
    route: 'replay', replay: true, row, match: row.match, counted: row.counted, invoice_id: row.invoice_id, invoice_number: row.invoice_number,
    excess_minor: row.excess_minor, paid_after_minor: row.paid_after_minor,
    send_receipt: RECEIPT_MATCHES.includes(row.match), review: REVIEW_MATCHES.includes(row.match) ? row.match : null,
  };
}

// data: the payment.received data; invoice: the invoice whose number is the reference, or null;
// rowsForReference: payment rows already stored with this reference; refunds: the invoice's refund rows.
function matchPayment(eventId, data, invoice, rowsForReference, refunds) {
  const rows = rowsForReference || [];
  const own = rows.find(row => row.event_id === eventId);
  if (own) return matchFromRow(own);
  const twin = rows.find(row => row.processor_payment_id === data.payment_id);
  if (twin) return { route: 'duplicate', replay: false, match: 'duplicate_payment', duplicate_of: twin.id, send_receipt: false, review: null };
  const result = (match, counted, extra) => ({
    route: 'record', replay: false, match, counted, invoice_id: invoice ? invoice.id : null, invoice_number: invoice ? invoice.number : null,
    excess_minor: 0, paid_after_minor: null, ...extra,
    send_receipt: RECEIPT_MATCHES.includes(match), review: REVIEW_MATCHES.includes(match) ? match : null,
  });
  if (!invoice) return result('unknown_reference', false);
  if (invoice.status === 'void') return result('invoice_void', false);
  if (data.currency !== invoice.currency) return result('wrong_currency', false);
  const before = invoiceMoney(invoice, rows, refunds);
  if (before.refunded_minor > 0) return result('after_refund', false);
  const after = before.paid_minor + data.amount_minor;
  if (before.paid_minor >= invoice.total_minor) return result('already_paid', true, { excess_minor: data.amount_minor, paid_after_minor: after });
  if (after < invoice.total_minor) return result('partial', true, { paid_after_minor: after });
  if (after === invoice.total_minor) return result(before.paid_minor === 0 ? 'exact' : 'completes', true, { paid_after_minor: after });
  return result('overpaid', true, { excess_minor: after - invoice.total_minor, paid_after_minor: after });
}

// The receipt is sent right after the payment row is stored, in the same run, so the row's created_at (the data
// service's clock) is never later than the first send. A replay past the resend window could send a second
// receipt; it stops with the ids instead.
function receiptResendBlock(payment, nowMs) {
  if (withinResendWindow(payment.created_at, nowMs)) return null;
  return 'Payment ' + payment.id + ' (event ' + payment.event_id + ', reference ' + payment.reference + ') was stored at ' + payment.created_at + ' and its receipt was not recorded; that is past the 23-hour resend window, so it is not resent. Check the email provider\'s log, then record receipt_email_id on the invoice.';
}

// The payment row: the facts from the processor plus the decision. Same event, same decision, same bytes.
function paymentRow(eventId, data, match) {
  return {
    row: {
      event_id: eventId, processor_payment_id: data.payment_id, reference: data.reference, invoice_id: match.invoice_id, invoice_number: match.invoice_number,
      amount_minor: data.amount_minor, currency: data.currency, received_at: data.received_at, match: match.match, counted: match.counted,
      excess_minor: match.excess_minor, paid_after_minor: match.paid_after_minor,
    },
  };
}

const REVIEW_TEXT = {
  overpaid: 'paid more than the invoice total',
  already_paid: 'paid on an invoice that was already paid in full',
  wrong_currency: 'paid in a different currency than the invoice',
  unknown_reference: 'the reference matches no invoice',
  invoice_void: 'paid on a void invoice',
  after_refund: 'paid on an invoice that has a refund',
  reminder_state_unknown: 'a reminder run stopped after claiming this step; whether the email went out is not known',
};

// A review item and its alert carry ids and amounts only: no client name, email or line text.
function paymentReview(kind, payment, invoice, config) {
  const amount = moneyIn(config, payment.amount_minor, payment.currency);
  const parts = ['Billing review: ' + REVIEW_TEXT[kind] + '.', 'Payment ' + payment.id + ' (processor ' + payment.processor_payment_id + ', reference ' + payment.reference + '): ' + amount + '.'];
  if (invoice) parts.push('Invoice ' + invoice.number + ' (' + invoice.id + '), total ' + moneyIn(config, invoice.total_minor, invoice.currency) + '.');
  if (payment.excess_minor > 0) parts.push('Excess ' + moneyIn(config, payment.excess_minor, payment.currency) + '.');
  return {
    row: { source_event_id: payment.event_id, kind, invoice_id: invoice ? invoice.id : null, invoice_number: invoice ? invoice.number : null, payment_id: payment.id, amount_minor: payment.amount_minor, currency: payment.currency, detail: parts.join(' ') },
  };
}

function reviewAlert(channel, reviewRowStored) {
  return { channel, text: reviewRowStored.detail + ' Review item ' + reviewRowStored.id + '.', unfurl_links: false };
}
