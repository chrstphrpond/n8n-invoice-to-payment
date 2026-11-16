// "CRIT · Match payments": signed payment.received events from the payment processor. The payment is matched to
// an invoice by its reference, recorded with the decision, a receipt goes out on full payment, and anything
// ambiguous goes to the review queue and the billing channel.
import { ENV, Flow, at, httpNode, ifNode, respondNode, switchNode } from '../../../_shared/lib/flow.mjs';
import { CONFIG_NAME, DATA, SETTINGS, TIMEZONE, addIntake, bearer, code, dataUrl, findRows, guardedKey, intakeNotes } from './common.mjs';

export const ID = 'critPaymentMatch';
export const NAME = 'CRIT · Match payments';
export const FILE = 'match-payments.json';
export const PATH = 'crit/invoices/payment-events';

const NOTES = {
  ...intakeNotes({ webhook: 'Receive payment event', path: PATH, secret: 'PAYMENTS_WEBHOOK_SECRET', scope: 'payment_event', accepted: 'payment.received', label: 'payment event' }),
  'Respond 202 accepted': 'Answers the processor now (202) so it does not redeliver while the payment is matched; the run continues.',
  'Fetch billing config': `Data service config "${CONFIG_NAME}": currencies for the amounts in the review text.`,
  'Find invoice by reference': 'Data service invoices whose number is the payment reference, read first: its money_seq guards the write. Read again after a guard conflict.',
  'Find payments for reference': 'Data service payments already recorded with this reference: the state before this one, and this event\'s own row on a replay.',
  'Find refunds for invoice': 'Data service refunds on that invoice (a payment after a refund is a review).',
  'Decide payment match': 'exact, partial, completes, overpaid, already_paid, wrong_currency, unknown_reference, invoice_void or after_refund, from the rows before this payment. A replay reads the decision back from its own row; the same processor payment under a new event id is a duplicate. At most 5 passes.',
  'Route payment match': 'record, replay (its row is already stored: go on from it), or duplicate (nothing stored).',
  'Store payment row': 'Data service payments (unique event id and processor payment id) with the decision, only while the invoice money_seq is the one read (guard). Idempotency-Key per event and money_seq. Critical.',
  'Route on payment write': 'stored goes on; a guard conflict (another payment, a refund or a void landed first) reads the invoice again and decides again.',
  'Read payment row': 'Keeps the stored payment (or, on a replay, the row found); receipt and review flags from the decision.',
  'Route on receipt': 'A receipt goes out when this payment brings the invoice to paid in full (exact, completes, overpaid).',
  'Find client for receipt': 'Data service clients: the invoice\'s client, for the receipt address.',
  'Prepare receipt email': 'The Resend-shaped receipt: amount, date, reference, invoice number. A replay more than 23 hours after the payment row was stored stops the run instead (no second receipt).',
  'Send receipt email': 'Transactional email API POST /emails with Idempotency-Key per event: one receipt per payment event, also after a timeout.',
  'Prepare receipt record': 'The receipt email id and the update that records it on the invoice.',
  'Record receipt on invoice': 'Data service update on the invoice: receipt_email_id and paid_at, only while no receipt is recorded.',
  'Check receipt recorded': 'Checks the update answered with the invoice.',
  'Route on review': 'Over-payments, wrong currency, unknown reference, void invoice and payment after refund go to review. Nothing is guessed.',
  'Prepare review item': 'The review row: kind, ids and amounts. No client name, email or line text.',
  'Store review item': 'Data service review_items (unique per event and kind). Idempotency-Key per event and node.',
  'Prepare review alert': 'Slack text for the billing review channel: ids and amounts only.',
  'Post review alert': 'chat.postMessage to REVIEW_SLACK_CHANNEL. Non-critical: a failed alert is noted, the review item is already stored.',
  'Check review alert': 'Notes whether the alert went out.',
  'Prepare done mark': 'The ledger result: payment id, invoice id, match, receipt and review ids.',
  'Mark event done': 'Data service ledger: this event is done with its outcome, so a redelivery answers duplicate. Non-critical.',
  'Summarize run': 'The run\'s final item: event, match, ids. No client data.',
};

const fromClaim = path => `$('Read claim result').first().json.${path}`;

export function build() {
  const f = new Flow({ id: ID, name: NAME, timezone: TIMEZONE, notes: NOTES, settings: SETTINGS });
  f.sticky('Read me', [
    `## ${NAME}`,
    'Signed **payment.received** events from the payment processor (payment id, reference, amount in minor units, currency, time). The reference is the invoice number. The money state of an invoice is derived from the payment and refund rows, never kept as a running total.',
    '**Receipt** on full payment. **Review queue and alert** (REVIEW_SLACK_CHANNEL) for over-payment, payment on a paid or void invoice, wrong currency, unknown reference and payment after a refund.',
    '**State** in the data service: the event ledger, payments (with the decision), review items, dead letters. **Retries**: 3 retries 5 s apart; writes send Idempotency-Key = payment-event:<id>:<node name> and X-Run-Id. Required steps that fail go to "CRIT · Alert on errors".',
  ].join('\n\n'), [170, -420], 2580, 400, 4);
  f.section('1. Intake and trust', 'Signature first (401), then the shape (400 and a dead letter), then one ledger claim per event id (409 in flight, 200 duplicate). Claimed: 202 now.', [0, 0], [9, 2]);
  f.section('2. Match and record', 'Invoice by reference, the payments and refunds before this one, one decision, stored with the payment only while the invoice money_seq is unchanged; a run that loses reads again and decides again. A replay reads its own row back.', [0, 4], [8, 4]);
  f.section('3. Receipt', 'Only when this payment completes the invoice. One receipt per event, keyed; recorded on the invoice.', [0, 7], [6, 7]);
  f.section('4. Review', 'Anything ambiguous: a review item and an alert with ids and amounts.', [0, 10], [5, 10]);
  f.section('5. Finish', 'Ledger done with the outcome; a summary item with ids only.', [0, 13], [2, 13]);

  // --- 1. intake and trust
  const routeOnClaim = addIntake(f, { webhook: 'Receive payment event', path: PATH, secretEnv: 'PAYMENTS_WEBHOOK_SECRET', typesConst: 'PAYMENT_EVENT_TYPES', scope: 'payment_event', idemPrefix: 'payment-event', source: 'payment-webhook', workflow: 'match-payments' });
  f.add(respondNode('Respond 202 accepted', at(9, 0), "JSON.stringify({ status: 'accepted', event_id: $json.event_id })", 202));
  f.connect(routeOnClaim, 'Respond 202 accepted', 0);
  f.connect('Respond 202 accepted', 'Fetch billing config');

  // --- 2. match and record
  f.add(httpNode('Fetch billing config', at(0, 4), { url: dataUrl(`/v1/config/${CONFIG_NAME}`), headers: DATA }));
  f.add(findRows('Find invoice by reference', at(1, 4), 'invoices', 'number', fromClaim('data.reference')));
  f.add(findRows('Find payments for reference', at(2, 4), 'payments', 'reference', fromClaim('data.reference')));
  f.add(findRows('Find refunds for invoice', at(3, 4), 'refunds', 'invoice_number', fromClaim('data.reference')));
  f.add(code('Decide payment match', at(4, 4), `
const config = checkedConfig($('Fetch billing config').first().json);
const invoice = rowsOf($('Find invoice by reference').first().json, 'invoice')[0] || null;
const payments = rowsOf($('Find payments for reference').first().json, 'payment');
const refunds = rowsOf(response, 'refund');
ctx.attempt = moneyAttempt($runIndex, 'Decide payment match for ' + ctx.data.reference);
const match = matchPayment(ctx.event_id, ctx.data, invoice, payments, refunds);
ctx.config = config;
ctx.invoice = invoice ? invoiceRef(invoice) : null;
ctx.match = match;
if (match.route === 'record') {
  const guard = moneyGuard(invoice);
  ctx.guard_tag = guardTag(guard);
  ctx.req = { body: { ...paymentRow(ctx.event_id, ctx.data, match), guard } };
} else if (match.route === 'duplicate') ctx.outcome = 'duplicate_payment';
return [{ json: ctx }];`, { from: ['Read claim result'] }));
  f.add(switchNode('Route payment match', at(5, 4), '$json.match.route', ['record', 'replay', 'duplicate']));
  f.add(guardedKey(httpNode('Store payment row', at(6, 4), { method: 'POST', url: dataUrl('/v1/rows/payments/guarded'), headers: DATA, write: true })));
  f.add(ifNode('Route on payment write', at(7, 4), "$json.outcome !== 'conflict'"));
  f.add(code('Read payment row', at(8, 4), `
ctx.payment = ctx.match.route === 'replay' ? ctx.match.row : rowOf(response, 'payment');
delete ctx.req;
ctx.send_receipt = ctx.match.send_receipt === true && ctx.invoice !== null;
ctx.needs_review = Boolean(ctx.match.review);
return [{ json: ctx }];`, { from: ['Decide payment match'] }));
  f.chain('Fetch billing config', 'Find invoice by reference', 'Find payments for reference', 'Find refunds for invoice', 'Decide payment match', 'Route payment match');
  f.connect('Route payment match', 'Store payment row', 0);
  f.connect('Route payment match', 'Read payment row', 1);
  f.connect('Route payment match', 'Prepare done mark', 2);
  f.chain('Store payment row', 'Route on payment write');
  f.connect('Route on payment write', 'Read payment row', 0);
  f.connect('Route on payment write', 'Find invoice by reference', 1);
  f.chain('Read payment row', 'Route on receipt');

  // --- 3. receipt
  f.add(ifNode('Route on receipt', at(0, 7), '$json.send_receipt'));
  f.add(findRows('Find client for receipt', at(1, 7), 'clients', 'client_id', '$json.invoice.client_id'));
  f.add(code('Prepare receipt email', at(2, 7), `
const blocked = receiptResendBlock(ctx.payment, Date.now());
if (blocked) throw new Error(blocked);
const client = rowsOf(response, 'client')[0];
if (!client || !client.email) throw new Error('The client of ' + ctx.invoice.number + ' has no email address');
ctx.req = { body: receiptEmailBody(ctx.invoice, client, ctx.payment, ctx.config, $env.EMAIL_FROM) };
return [{ json: ctx }];`, { from: ['Read payment row'] }));
  f.add(httpNode('Send receipt email', at(3, 7), { method: 'POST', url: `${ENV('EMAIL_BASE_URL')}/emails`, headers: bearer('EMAIL_API_KEY'), write: true, timeout: '={{ Number($env.EMAIL_TIMEOUT_MS) || 15000 }}' }));
  f.add(code('Prepare receipt record', at(4, 7), `
if (!response || typeof response.id !== 'string') throw new Error('The email API did not return an email id');
ctx.receipt_email_id = response.id;
ctx.req = { body: { expect: { receipt_email_id: null }, set: { receipt_email_id: response.id, paid_at: ctx.payment.received_at } } };
return [{ json: ctx }];`, { from: ['Prepare receipt email'] }));
  f.add(httpNode('Record receipt on invoice', at(5, 7), { method: 'PATCH', url: `${dataUrl('/v1/rows/invoices/')}{{ $json.invoice.id }}`, headers: DATA, write: true }));
  f.add(code('Check receipt recorded', at(6, 7), `
rowOf(response, 'invoice');
delete ctx.req;
ctx.receipt_recorded = true;
return [{ json: ctx }];`, { from: ['Prepare receipt record'] }));
  f.connect('Route on receipt', 'Find client for receipt', 0);
  f.connect('Route on receipt', 'Route on review', 1);
  f.chain('Find client for receipt', 'Prepare receipt email', 'Send receipt email', 'Prepare receipt record', 'Record receipt on invoice', 'Check receipt recorded', 'Route on review');

  // --- 4. review
  f.add(ifNode('Route on review', at(0, 10), '$json.needs_review'));
  f.add(code('Prepare review item', at(1, 10), `
ctx.req = { body: paymentReview(ctx.match.review, ctx.payment, ctx.invoice, ctx.config) };
return [{ json: ctx }];`));
  f.add(httpNode('Store review item', at(2, 10), { method: 'POST', url: dataUrl('/v1/rows/review_items'), headers: DATA, write: true }));
  f.add(code('Prepare review alert', at(3, 10), `
ctx.review_item = rowOf(response, 'review item');
ctx.req = { body: reviewAlert($env.REVIEW_SLACK_CHANNEL, ctx.review_item) };
return [{ json: ctx }];`, { from: ['Prepare review item'] }));
  f.add(httpNode('Post review alert', at(4, 10), { method: 'POST', url: `${ENV('ALERTS_SLACK_BASE_URL')}/api/chat.postMessage`, headers: bearer('ALERTS_SLACK_TOKEN'), write: true, soft: true }));
  f.add(code('Check review alert', at(5, 10), `
const posted = httpOutcome(response);
delete ctx.req;
ctx.alert_posted = posted.ok;
ctx.alert_error = posted.error;
return [{ json: ctx }];`, { from: ['Prepare review alert'] }));
  f.connect('Route on review', 'Prepare review item', 0);
  f.connect('Route on review', 'Prepare done mark', 1);
  f.chain('Prepare review item', 'Store review item', 'Prepare review alert', 'Post review alert', 'Check review alert', 'Prepare done mark');
  f.connect('Post review alert', 'Check review alert', 1);

  // --- 5. finish
  f.add(code('Prepare done mark', at(0, 13), `
ctx.outcome = ctx.outcome || ctx.match.match;
ctx.req = { body: completeBody('payment_event', ctx.event_id, ctx.outcome, {
  payment_id: ctx.payment ? ctx.payment.id : null, invoice_id: ctx.invoice ? ctx.invoice.id : null, match: ctx.match.match,
  duplicate_of: ctx.match.duplicate_of || null, receipt_email_id: ctx.receipt_email_id || null, review_item_id: ctx.review_item ? ctx.review_item.id : null,
  alert_posted: ctx.alert_posted === undefined ? null : ctx.alert_posted,
}) };
return [{ json: ctx }];`, { from: ['Check review alert', 'Check receipt recorded', 'Read payment row', 'Decide payment match'] }));
  f.add(httpNode('Mark event done', at(1, 13), { method: 'POST', url: dataUrl('/v1/ledger/complete'), headers: DATA, runId: true, soft: true }));
  f.add(code('Summarize run', at(2, 13), `
const done = httpOutcome(response);
const warnings = [];
if (!done.ok) warnings.push('ledger_done_failed');
if (ctx.alert_posted === false) warnings.push('review_alert_failed');
return [{ json: { event_id: ctx.event_id, outcome: ctx.outcome, payment_id: ctx.payment ? ctx.payment.id : null, invoice_id: ctx.invoice ? ctx.invoice.id : null, receipt_email_id: ctx.receipt_email_id || null, review_item_id: ctx.review_item ? ctx.review_item.id : null, warnings } }];`, { from: ['Prepare done mark'] }));
  f.chain('Prepare done mark', 'Mark event done', 'Summarize run');
  f.connect('Mark event done', 'Summarize run', 1);
  return f.json();
}

export const ENTRY = { file: FILE, id: ID, name: NAME, webhooks: [{ method: 'POST', path: PATH }], readOnlyPostNodes: [] };
