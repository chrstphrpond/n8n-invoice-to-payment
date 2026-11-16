// Void and refund: only valid state transitions. The lifecycle stored on the invoice is issued -> sent, and
// issued or sent -> void while nothing has been paid. Paid states are derived from rows (payments.js); a refund
// is allowed up to what was paid minus what was already refunded.
//
// Both writes carry the money guard (payments.js): a void is applied only while the invoice's money_seq is the one
// read before deciding, and so is a refund row. A run that loses decides again from fresh rows, so two refunds
// read against the same "before" state cannot both go out, and a void cannot pass a payment it did not see.
// The processor is called only after the refund row won.

const INVOICE_TRANSITIONS = { issued: ['sent', 'void'], sent: ['void'], void: [] };

function canTransition(from, to) {
  return Object.prototype.hasOwnProperty.call(INVOICE_TRANSITIONS, from) && INVOICE_TRANSITIONS[from].includes(to);
}

function refusal(route, httpStatus, body) {
  return { route, http_status: httpStatus, answer: body, req: null };
}

// event: { event_id, data: { invoice_number, reason? } }.
// Returns { route: void | void_replay | not_found | invalid_transition, ... }.
function decideVoid(event, invoice, payments) {
  const number = event.data.invoice_number;
  if (!invoice) return refusal('not_found', 404, { status: 'unknown_invoice', event_id: event.event_id, invoice_number: number });
  const base = { event_id: event.event_id, invoice_number: number, invoice_id: invoice.id };
  // The same void event again (a replay after a failed run): already applied, nothing is written.
  if (invoice.status === 'void' && invoice.void_event_id === event.event_id) return { route: 'void_replay', http_status: 200, answer: { status: 'voided', ...base, changed: false }, req: null };
  const money = invoiceMoney(invoice, payments, []);
  if (money.paid_minor > 0) return refusal('invalid_transition', 409, { status: 'invalid_transition', ...base, from: money.state, to: 'void', message: 'the invoice has payments; refund them first' });
  if (!canTransition(invoice.status, 'void')) return refusal('invalid_transition', 409, { status: 'invalid_transition', ...base, from: invoice.status, to: 'void', message: 'a ' + invoice.status + ' invoice cannot be voided' });
  return {
    route: 'void', http_status: 200, answer: { status: 'voided', ...base },
    req: { body: { expect: { status: ['issued', 'sent'] }, set: { status: 'void', void_event_id: event.event_id, void_reason: event.data.reason || null }, guard: { column: 'money_seq', expect: moneySeqOf(invoice) } } },
  };
}

// event: { event_id, data: { invoice_number, amount_minor, currency, reason? } }; nowMs for the resend window.
// Returns { route: refund | refund_resume | refund_replay | not_found | invalid_transition | refund_refused, ... }.
// refund_resume: this event's refund row exists but the processor's answer was never recorded (the run died);
// the processor is called again with the same key. refund_replay: it was recorded; nothing is sent again.
function decideRefund(event, invoice, payments, refunds, nowMs) {
  const data = event.data;
  if (!invoice) return refusal('not_found', 404, { status: 'unknown_invoice', event_id: event.event_id, invoice_number: data.invoice_number });
  const base = { event_id: event.event_id, invoice_number: data.invoice_number, invoice_id: invoice.id };
  const own = (refunds || []).find(row => row.event_id === event.event_id);
  const others = (refunds || []).filter(row => row.event_id !== event.event_id);
  const money = invoiceMoney(invoice, payments, others);
  const refundable = money.paid_minor - money.refunded_minor;
  const answer = { status: 'refunded', ...base, amount_minor: data.amount_minor, currency: data.currency };
  if (own) {
    const result = { http_status: 200, replay: true, own_refund: own, refundable_after_minor: refundable - own.amount_minor, answer, req: null };
    if (own.processor_refund_id) return { route: 'refund_replay', ...result };
    if (!withinResendWindow(own.created_at, nowMs)) throw new Error('Refund ' + own.id + ' on ' + own.invoice_number + ' (' + own.invoice_id + ') was stored at ' + own.created_at + ' and the processor\'s answer was never recorded. That is past the 23-hour resend window, so a second send could refund twice; not resent. Check the processor for metadata.refund_id ' + own.id + '.');
    return { route: 'refund_resume', ...result };
  }
  if (invoice.status === 'void') return refusal('invalid_transition', 409, { status: 'invalid_transition', ...base, from: 'void', to: 'refunded', message: 'a void invoice cannot be refunded' });
  if (data.currency !== invoice.currency) return refusal('refund_refused', 422, { status: 'refund_refused', reason: 'currency_mismatch', ...base, message: 'the invoice is in ' + invoice.currency });
  if (money.paid_minor === 0) return refusal('invalid_transition', 409, { status: 'invalid_transition', ...base, from: money.state, to: 'refunded', message: 'nothing has been paid on this invoice' });
  if (data.amount_minor > refundable) return refusal('refund_refused', 422, { status: 'refund_refused', reason: 'refund_exceeds_paid', ...base, requested_minor: data.amount_minor, refundable_minor: refundable });
  return {
    route: 'refund', http_status: 200, replay: false, refundable_after_minor: refundable - data.amount_minor, answer,
    req: { body: { ...refundRow(event, invoice), guard: moneyGuard(invoice) } },
  };
}

function refundRow(event, invoice) {
  return { row: { event_id: event.event_id, invoice_id: invoice.id, invoice_number: invoice.number, amount_minor: event.data.amount_minor, currency: event.data.currency, reason: event.data.reason || null, status: 'approved' } };
}

function processorRefundBody(refund) {
  return { payment_reference: refund.invoice_number, amount: refund.amount_minor, currency: refund.currency, metadata: { refund_id: refund.id, invoice_id: refund.invoice_id } };
}
