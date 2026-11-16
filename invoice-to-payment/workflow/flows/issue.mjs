// "CRIT · Issue invoices": signed billing events from the studio's own system. invoice.requested is numbered,
// rendered, stored and emailed; invoice.void_requested and refund.requested are checked against the invoice's
// state and answered at once.
import { ENV, Flow, at, httpNode, ifNode, respondNode, switchNode } from '../../../_shared/lib/flow.mjs';
import { CONFIG_NAME, DATA, SETTINGS, TIMEZONE, addIntake, bearer, binaryPutNode, bodyFrom, code, dataUrl, findRows, guardedKey, intakeNotes } from './common.mjs';

export const ID = 'critInvoiceIssue';
export const NAME = 'CRIT · Issue invoices';
export const FILE = 'issue-invoices.json';
export const PATH = 'crit/invoices/billing-events';
export const READ_ONLY_POST = ['Create invoice PDF'];

const NOTES = {
  ...intakeNotes({ webhook: 'Receive billing event', path: PATH, secret: 'BILLING_WEBHOOK_SECRET', scope: 'billing_event', accepted: 'invoice.requested, invoice.void_requested and refund.requested', label: 'billing event' }),
  'Route by event type': 'invoice.requested goes to numbering and delivery; void and refund requests to section 4.',
  'Fetch billing config': `Data service config "${CONFIG_NAME}": seller, currencies, tax rates, number format, limits.`,
  'Find client': 'Data service clients: the client named in the request (status, billing currency, email for delivery).',
  'Find invoice for event': 'Data service invoices by request_event_id: an invoice already made for this event means a replay; it is reused.',
  'Decide invoice plan': 'Client active, currency configured and the client\'s, due date not before issue date, totals and tax in integer minor units. A refusal takes no number.',
  'Route invoice plan': 'accept or reject.',
  'Respond 422 rejected': 'Answers 422 {status: rejected, reasons}. No number is taken; the ledger records the refusal.',
  'Respond 202 accepted': 'Answers the sender now (202) so it does not redeliver while the PDF is made and sent; the run continues.',
  'Route on existing invoice': 'A replay that already has its invoice row skips numbering.',
  'Claim invoice number': 'Data service sequence invoice-<year>: one value per event id, max + 1, gap-free. The same event always gets the same number back.',
  'Prepare invoice row': 'CRIT-<year>-<0000> and the invoice row from the event, the config and the number only, so a replay sends the same bytes.',
  'Store invoice row': 'Data service invoices (unique request_event_id and number), status issued. Idempotency-Key per event and node. Critical.',
  'Read stored invoice': 'Keeps the stored invoice for delivery.',
  'Check delivery progress': 'From the stored invoice: render (nothing yet), email (PDF stored, not sent), finish (already sent, or voided meanwhile). An email started more than 23 hours ago with no answer recorded stops the run (no second email).',
  'Route delivery step': 'render, email or finish.',
  'Create invoice PDF': 'Document rendering service: the CRIT HTML template in, PDF bytes out. Read-only. 3 retries 5 s apart.',
  'Hash invoice PDF': 'Checks the %PDF signature and size limit, SHA-256 of the bytes. The bytes go on as binary, never into a row.',
  'Store invoice PDF': 'Object storage PUT at a fixed key per invoice (invoices/<year>/<number>.pdf): a repeat overwrites the same object, never a second one.',
  'Prepare PDF record': 'Storage must confirm the same SHA-256; then the update that records the key and hash on the invoice.',
  'Record PDF on invoice': 'Data service update on the invoice: pdf_key, pdf_sha256, pdf_bytes, only while no PDF is recorded.',
  'Download stored PDF': 'Reads the stored object back, so the email attaches exactly what storage holds.',
  'Prepare invoice email': 'Checks the downloaded bytes against the recorded SHA-256, then the Resend-shaped email with the PDF attached.',
  'Record email start': 'Data service update on the invoice: stamps email_started_at with the service clock (kept from the first attempt) before the send, so a late replay knows an email may be out.',
  'Send invoice email': 'Transactional email API POST /emails with Idempotency-Key per event: a retry after a timeout gets the first answer, not a second email.',
  'Prepare delivery record': 'The email id, and the update issued -> sent.',
  'Record delivery': 'Data service update on the invoice: status sent and email_id, only from issued.',
  'Prepare delivered result': 'The ledger result: invoice id, number, total, email id, PDF hash. No client data.',
  'Find invoice to change': 'Data service invoices by the invoice number in the request, read first: its money_seq guards the write. Read again after a guard conflict.',
  'Find invoice payments': 'Data service payments recorded for that invoice number.',
  'Find invoice refunds': 'Data service refunds already made on that invoice.',
  'Decide change': 'Void: only issued or sent with nothing paid. Refund: only up to paid minus refunded, same currency, not on a void invoice. A replay of the same event goes on from its stored state. At most 5 passes.',
  'Route change decision': 'void, refund, void_replay, refund_resume, refund_replay, not_found, invalid_transition or refund_refused.',
  'Mark invoice void': 'Data service update: status void, only from issued or sent and only while money_seq is the one read (guard). Idempotency-Key per event and money_seq.',
  'Route on void write': 'changed goes on; a guard conflict (a payment or refund landed first) reads the invoice again and decides again.',
  'Prepare void result': 'Checks the invoice is now void and builds the answer.',
  'Respond 200 voided': 'Answers 200 {status: voided}.',
  'Store refund row': 'Data service refunds (unique event id), status approved, only while the invoice money_seq is the one read (guard). Idempotency-Key per event and money_seq.',
  'Route on refund write': 'stored goes on to the processor; a guard conflict (another refund, payment or void landed first) reads again and decides again.',
  'Prepare processor refund': 'The refund request for the payment processor: reference, amount, currency, refund id. Only after the refund row won.',
  'Send refund to processor': 'Payment processor POST /v1/refunds with Idempotency-Key per event: a retry never refunds twice.',
  'Prepare refund record': 'The processor\'s refund id and the update approved -> submitted.',
  'Record processor refund': 'Data service update on the refund: status submitted, processor_refund_id.',
  'Prepare refund result': 'The answer and the ledger result: refund id, processor id, amount.',
  'Respond 200 refunded': 'Answers 200 {status: refunded, refund_id, processor_refund_id}.',
  'Respond 404 unknown invoice': 'Answers 404 {status: unknown_invoice}.',
  'Respond 409 invalid transition': 'Answers 409 {status: invalid_transition, from, to}: for example a paid invoice cannot be voided.',
  'Respond 422 refund refused': 'Answers 422 {status: refund_refused, reason}: more than was paid, or another currency.',
  'Mark event done': 'Data service ledger: this event is done with its outcome, so a redelivery answers duplicate. Non-critical.',
  'Summarize run': 'The run\'s final item: event, outcome, invoice id and number. No client data.',
};

const storageUrl = key => `${ENV('STORAGE_BASE_URL')}/objects/${ENV('STORAGE_BUCKET')}/${key}`;
const fromClaim = path => `$('Read claim result').first().json.${path}`;

export function build() {
  const f = new Flow({ id: ID, name: NAME, timezone: TIMEZONE, notes: NOTES, settings: SETTINGS });
  f.readOnlyPostNodes = READ_ONLY_POST;
  f.sticky('Read me', [
    `## ${NAME}`,
    'Signed billing events from the studio\'s own system. **invoice.requested**: the client and the lines are checked, a gap-free number is taken, the totals and tax are computed in integer minor units, the CRIT invoice is rendered to PDF, stored, and emailed to the client. **invoice.void_requested** and **refund.requested** are checked against the invoice\'s state and answered at once (200, 404, 409 or 422).',
    `**Config**: env for endpoints and secrets (BILLING_WEBHOOK_SECRET, PDF_*, STORAGE_*, EMAIL_*, PAYMENTS_*, DATA_SERVICE_*). Business rules are the data service config "${CONFIG_NAME}".`,
    '**State** lives in the data service: the event ledger, the invoice-number sequence, invoices, refunds, dead letters. The PDF is in object storage; rows hold its key and SHA-256. **Retries**: 3 retries 5 s apart on every call; writes send Idempotency-Key = billing-event:<id>:<node name> and X-Run-Id. A required step that fails goes to "CRIT · Alert on errors", which hands the claim back so a redelivery picks up where the run stopped.',
  ].join('\n\n'), [170, -420], 3400, 400, 4);
  f.section('1. Intake and trust', 'Signature first (401), then the shape (400 and a dead letter), then one ledger claim per event id (409 in flight, 200 duplicate).', [0, 0], [9, 2]);
  f.section('2. Check and number', 'Business checks before any number is taken (422 on refusal). Then 202, and a gap-free number from the data service sequence. A replay reuses the invoice it already made.', [0, 4], [10, 5.2]);
  f.section('3. Render, store and send', 'One PDF per invoice at a fixed storage key, checked by SHA-256 on the way in and out; one email per event, keyed, its start stamped first. Each step is recorded on the invoice, so a replay resumes where the last run stopped.', [0, 8], [13, 8]);
  f.section('4. Void and refund', 'Only valid transitions: void while nothing is paid, refund up to what was paid. Each write is guarded by the invoice money_seq; a run that loses reads again and decides again. Answered at once.', [0, 11], [12, 13]);
  f.section('5. Finish', 'Ledger done with the outcome; a summary item with ids only.', [0, 15], [1, 15]);

  // --- 1. intake and trust
  const routeOnClaim = addIntake(f, { webhook: 'Receive billing event', path: PATH, secretEnv: 'BILLING_WEBHOOK_SECRET', typesConst: 'BILLING_EVENT_TYPES', scope: 'billing_event', idemPrefix: 'billing-event', source: 'billing-webhook', workflow: 'issue-invoices' });
  f.add(switchNode('Route by event type', at(9, 0), '$json.type', ['invoice.requested', 'invoice.void_requested', 'refund.requested']));
  f.connect(routeOnClaim, 'Route by event type', 0);
  f.connect('Route by event type', 'Fetch billing config', 0);
  f.connect('Route by event type', 'Find invoice to change', 1);
  f.connect('Route by event type', 'Find invoice to change', 2);

  // --- 2. check and number
  f.add(httpNode('Fetch billing config', at(0, 4), { url: dataUrl(`/v1/config/${CONFIG_NAME}`), headers: DATA }));
  f.add(findRows('Find client', at(1, 4), 'clients', 'client_id', fromClaim('data.client_id')));
  f.add(findRows('Find invoice for event', at(2, 4), 'invoices', 'request_event_id', fromClaim('event_id')));
  f.add(code('Decide invoice plan', at(3, 4), `
const config = checkedConfig($('Fetch billing config').first().json);
const clients = rowsOf($('Find client').first().json, 'client');
const existing = rowsOf(response, 'invoice')[0] || null;
const plan = planInvoice(ctx, config, clients, existing);
ctx.config = config;
ctx.client = clients[0] || null;
ctx.route = plan.route;
ctx.has_invoice = plan.has_invoice;
ctx.invoice = plan.invoice;
ctx.draft = plan.draft;
if (plan.route === 'reject') {
  ctx.outcome = 'rejected';
  ctx.answer = { status: 'rejected', event_id: ctx.event_id, reasons: plan.reasons };
  ctx.req = { body: completeBody('billing_event', ctx.event_id, 'rejected', { reasons: plan.reasons.map(reason => reason.code) }) };
} else if (!plan.has_invoice) {
  ctx.sequence = plan.draft.sequence;
  ctx.req = { body: { key: ctx.event_id } };
}
return [{ json: ctx }];`, { from: ['Read claim result'] }));
  f.add(switchNode('Route invoice plan', at(4, 4), '$json.route', ['accept', 'reject']));
  f.add(respondNode('Respond 422 rejected', at(4, 5.2), 'JSON.stringify($json.answer)', 422));
  f.add(respondNode('Respond 202 accepted', at(5, 4), "JSON.stringify({ status: 'accepted', event_id: $json.event_id })", 202));
  f.add(ifNode('Route on existing invoice', at(6, 4), '$json.has_invoice'));
  f.add(httpNode('Claim invoice number', at(7, 4), { method: 'POST', url: `${dataUrl('/v1/sequences/')}{{ $json.sequence }}/next`, headers: DATA, runId: true }));
  f.add(code('Prepare invoice row', at(8, 4), `
if (!response || !Number.isSafeInteger(response.value) || response.value < 1) throw new Error('The data service did not allocate an invoice number');
ctx.number = formatInvoiceNumber(ctx.config, ctx.draft.issue_date, response.value);
ctx.number_outcome = response.outcome;
ctx.req = { body: invoiceRow(ctx.event_id, ctx.draft, ctx.number, response.value) };
return [{ json: ctx }];`, { from: ['Decide invoice plan'] }));
  f.add(httpNode('Store invoice row', at(9, 4), { method: 'POST', url: dataUrl('/v1/rows/invoices'), headers: DATA, write: true }));
  f.add(code('Read stored invoice', at(10, 4), `
ctx.invoice = rowOf(response, 'invoice');
delete ctx.req;
delete ctx.draft;
return [{ json: ctx }];`, { from: ['Prepare invoice row'] }));
  f.chain('Fetch billing config', 'Find client', 'Find invoice for event', 'Decide invoice plan', 'Route invoice plan');
  f.connect('Route invoice plan', 'Respond 202 accepted', 0);
  f.connect('Route invoice plan', 'Respond 422 rejected', 1);
  f.connect('Respond 202 accepted', 'Route on existing invoice');
  f.connect('Route on existing invoice', 'Check delivery progress', 0);
  f.connect('Route on existing invoice', 'Claim invoice number', 1);
  f.chain('Claim invoice number', 'Prepare invoice row', 'Store invoice row', 'Read stored invoice', 'Check delivery progress');
  f.connect('Respond 422 rejected', 'Mark event done');

  // --- 3. render, store and send
  f.add(code('Check delivery progress', at(0, 8), `
const step = deliveryStep(ctx.invoice);
const blocked = emailResendBlock(ctx.invoice, Date.now());
if (blocked) throw new Error(blocked);
ctx.step = step;
ctx.step_route = step === 'render' || step === 'email' ? step : 'finish';
ctx.pdf_key = ctx.invoice.pdf_key || pdfKeyFor(ctx.invoice);
if (step === 'render') {
  if (!ctx.client) throw new Error('The client of ' + ctx.invoice.number + ' is missing');
  ctx.req = { body: pdfRequestBody(renderInvoiceHtml(ctx.invoice, ctx.client, ctx.config), ctx.invoice) };
}
if (ctx.step_route === 'finish') {
  ctx.outcome = step === 'done' ? 'already_delivered' : 'void_before_delivery';
  ctx.req = { body: completeBody('billing_event', ctx.event_id, ctx.outcome, invoiceSummary(ctx.invoice)) };
}
return [{ json: ctx }];`, { from: ['Read stored invoice', 'Decide invoice plan'] }));
  f.add(switchNode('Route delivery step', at(1, 8), '$json.step_route', ['render', 'email', 'finish']));
  f.add(httpNode('Create invoice PDF', at(2, 8), { method: 'POST', url: `${ENV('PDF_BASE_URL')}/v1/render`, headers: bearer('PDF_API_TOKEN'), responseFormat: 'file', timeout: 30000 }));
  f.add(code('Hash invoice PDF', at(3, 8), `
const binary = $input.first().binary;
const buffer = await this.helpers.getBinaryDataBuffer(0, 'data');
const pdf = inspectPdf(buffer, ctx.config.max_pdf_bytes);
if (!pdf.ok) throw new Error(pdf.error);
delete ctx.req;
ctx.pdf = { sha256: pdf.sha256, bytes: pdf.size };
return [{ json: ctx, binary }];`, { from: ['Check delivery progress'] }));
  f.add(binaryPutNode('Store invoice PDF', at(4, 8), { url: storageUrl('{{ $json.pdf_key }}'), headers: { ...bearer('STORAGE_TOKEN'), 'Content-Type': 'application/pdf' } }));
  f.add(code('Prepare PDF record', at(5, 8), `
if (!response || response.sha256 !== ctx.pdf.sha256) throw new Error('Storage did not confirm the PDF: SHA-256 missing or different');
ctx.req = { body: { expect: { pdf_sha256: null }, set: { pdf_key: ctx.pdf_key, pdf_sha256: ctx.pdf.sha256, pdf_bytes: ctx.pdf.bytes } } };
return [{ json: ctx }];`, { from: ['Hash invoice PDF'] }));
  f.add(httpNode('Record PDF on invoice', at(6, 8), { method: 'PATCH', url: `${dataUrl('/v1/rows/invoices/')}{{ $json.invoice.id }}`, headers: DATA, write: true }));
  f.add(httpNode('Download stored PDF', at(7, 8), { url: storageUrl(`{{ $('Check delivery progress').first().json.pdf_key }}`), headers: bearer('STORAGE_TOKEN'), responseFormat: 'file', timeout: 30000 }));
  f.add(code('Prepare invoice email', at(8, 8), `
let recorded = null;
try { recorded = $('Record PDF on invoice').first().json.row; } catch (error) { recorded = null; }
const expected = recorded ? recorded.pdf_sha256 : ctx.invoice.pdf_sha256;
const buffer = await this.helpers.getBinaryDataBuffer(0, 'data');
const pdf = inspectPdf(buffer, ctx.config.max_pdf_bytes);
if (!pdf.ok || pdf.sha256 !== expected) throw new Error('The stored PDF does not match the SHA-256 recorded on the invoice');
if (!ctx.client || !ctx.client.email) throw new Error('The client of ' + ctx.invoice.number + ' has no email address');
ctx.req = { body: invoiceEmailBody(ctx.invoice, ctx.client, ctx.config, $env.EMAIL_FROM, buffer.toString('base64')) };
return [{ json: ctx }];`, { from: ['Check delivery progress'] }));
  f.add(httpNode('Record email start', at(9, 8), { method: 'PATCH', url: `${dataUrl('/v1/rows/invoices/')}{{ $json.invoice.id }}`, headers: DATA, write: true, body: "={{ JSON.stringify({ expect: { email_id: null }, stamp: ['email_started_at'] }) }}" }));
  f.add(bodyFrom(httpNode('Send invoice email', at(10, 8), { method: 'POST', url: `${ENV('EMAIL_BASE_URL')}/emails`, headers: bearer('EMAIL_API_KEY'), write: true, timeout: '={{ Number($env.EMAIL_TIMEOUT_MS) || 15000 }}' }), 'Prepare invoice email'));
  f.add(code('Prepare delivery record', at(11, 8), `
if (!response || typeof response.id !== 'string') throw new Error('The email API did not return an email id');
ctx.email_id = response.id;
ctx.req = { body: { expect: { status: 'issued' }, set: { status: 'sent', email_id: response.id } } };
return [{ json: ctx }];`, { from: ['Prepare invoice email'] }));
  f.add(httpNode('Record delivery', at(12, 8), { method: 'PATCH', url: `${dataUrl('/v1/rows/invoices/')}{{ $json.invoice.id }}`, headers: DATA, write: true }));
  f.add(code('Prepare delivered result', at(13, 8), `
const row = rowOf(response, 'invoice');
ctx.outcome = 'delivered';
ctx.invoice = invoiceRef(row);
ctx.req = { body: completeBody('billing_event', ctx.event_id, 'delivered', { ...invoiceSummary(row), email_id: row.email_id, pdf_sha256: row.pdf_sha256 }) };
return [{ json: ctx }];`, { from: ['Prepare delivery record'] }));
  f.connect('Check delivery progress', 'Route delivery step');
  f.connect('Route delivery step', 'Create invoice PDF', 0);
  f.connect('Route delivery step', 'Download stored PDF', 1);
  f.connect('Route delivery step', 'Mark event done', 2);
  f.chain('Create invoice PDF', 'Hash invoice PDF', 'Store invoice PDF', 'Prepare PDF record', 'Record PDF on invoice', 'Download stored PDF', 'Prepare invoice email', 'Record email start', 'Send invoice email', 'Prepare delivery record', 'Record delivery', 'Prepare delivered result', 'Mark event done');

  // --- 4. void and refund
  f.add(findRows('Find invoice to change', at(0, 11), 'invoices', 'number', fromClaim('data.invoice_number')));
  f.add(findRows('Find invoice payments', at(1, 11), 'payments', 'invoice_number', fromClaim('data.invoice_number')));
  f.add(findRows('Find invoice refunds', at(2, 11), 'refunds', 'invoice_number', fromClaim('data.invoice_number')));
  f.add(code('Decide change', at(3, 11), `
const invoice = rowsOf($('Find invoice to change').first().json, 'invoice')[0] || null;
const payments = rowsOf($('Find invoice payments').first().json, 'payment');
const refunds = rowsOf(response, 'refund');
ctx.attempt = moneyAttempt($runIndex, 'Decide change for ' + ctx.data.invoice_number);
const decision = ctx.type === 'invoice.void_requested' ? decideVoid(ctx, invoice, payments) : decideRefund(ctx, invoice, payments, refunds, Date.now());
ctx.invoice = invoice ? invoiceRef(invoice) : null;
ctx.route = decision.route;
ctx.answer = decision.answer;
ctx.refundable_after_minor = decision.refundable_after_minor === undefined ? null : decision.refundable_after_minor;
ctx.own_refund = decision.own_refund || null;
ctx.req = decision.req;
ctx.guard_tag = decision.req && decision.req.body.guard ? guardTag(decision.req.body.guard) : null;
if (decision.route === 'void_replay') {
  ctx.outcome = 'voided';
  ctx.req = { body: completeBody('billing_event', ctx.event_id, 'voided', { invoice_id: invoice.id, number: invoice.number }) };
} else if (decision.route === 'refund_replay') {
  delete ctx.req;
} else if (!['void', 'refund', 'refund_resume'].includes(decision.route)) {
  ctx.outcome = decision.route;
  ctx.req = { body: completeBody('billing_event', ctx.event_id, decision.route, decision.answer) };
}
return [{ json: ctx }];`, { from: ['Read claim result'] }));
  f.add(switchNode('Route change decision', at(4, 11), '$json.route', ['void', 'refund', 'void_replay', 'refund_resume', 'refund_replay', 'not_found', 'invalid_transition', 'refund_refused']));
  f.add(guardedKey(httpNode('Mark invoice void', at(5, 11), { method: 'PATCH', url: `${dataUrl('/v1/rows/invoices/')}{{ $json.invoice.id }}`, headers: DATA, write: true })));
  f.add(ifNode('Route on void write', at(6, 11), "$json.outcome !== 'conflict'"));
  f.add(code('Prepare void result', at(7, 11), `
const row = rowOf(response, 'invoice');
if (row.status !== 'void') throw new Error('The invoice is not void after the update');
ctx.outcome = 'voided';
ctx.answer = { ...ctx.answer, changed: response.changed === true };
ctx.req = { body: completeBody('billing_event', ctx.event_id, 'voided', { invoice_id: row.id, number: row.number }) };
return [{ json: ctx }];`, { from: ['Decide change'] }));
  f.add(respondNode('Respond 200 voided', at(8, 11), 'JSON.stringify($json.answer)', 200));
  f.add(guardedKey(httpNode('Store refund row', at(5, 12), { method: 'POST', url: dataUrl('/v1/rows/refunds/guarded'), headers: DATA, write: true })));
  f.add(ifNode('Route on refund write', at(6, 12), "$json.outcome !== 'conflict'"));
  f.add(code('Prepare processor refund', at(7, 12), `
const refund = ctx.route === 'refund_resume' ? ctx.own_refund : rowOf(response, 'refund');
ctx.refund = { id: refund.id, invoice_id: refund.invoice_id, invoice_number: refund.invoice_number, amount_minor: refund.amount_minor, currency: refund.currency };
ctx.req = { body: processorRefundBody(refund) };
return [{ json: ctx }];`, { from: ['Decide change'] }));
  f.add(httpNode('Send refund to processor', at(8, 12), { method: 'POST', url: `${ENV('PAYMENTS_BASE_URL')}/v1/refunds`, headers: bearer('PAYMENTS_API_KEY'), write: true }));
  f.add(code('Prepare refund record', at(9, 12), `
if (!response || typeof response.id !== 'string') throw new Error('The payment processor did not return a refund id');
ctx.processor_refund_id = response.id;
ctx.req = { body: { expect: { status: ['approved', 'submitted'] }, set: { status: 'submitted', processor_refund_id: response.id } } };
return [{ json: ctx }];`, { from: ['Prepare processor refund'] }));
  f.add(httpNode('Record processor refund', at(10, 12), { method: 'PATCH', url: `${dataUrl('/v1/rows/refunds/')}{{ $json.refund.id }}`, headers: DATA, write: true }));
  f.add(code('Prepare refund result', at(11, 12), `
const row = ctx.route === 'refund_replay' ? ctx.own_refund : rowOf(response, 'refund');
ctx.outcome = 'refunded';
ctx.answer = { ...ctx.answer, refund_id: row.id, processor_refund_id: row.processor_refund_id, refundable_after_minor: ctx.refundable_after_minor };
ctx.req = { body: completeBody('billing_event', ctx.event_id, 'refunded', { refund_id: row.id, invoice_id: row.invoice_id, amount_minor: row.amount_minor, currency: row.currency, processor_refund_id: row.processor_refund_id }) };
return [{ json: ctx }];`, { from: ['Prepare refund record', 'Decide change'] }));
  f.add(respondNode('Respond 200 refunded', at(12, 12), 'JSON.stringify($json.answer)', 200));
  f.add(respondNode('Respond 404 unknown invoice', at(5, 13), 'JSON.stringify($json.answer)', 404));
  f.add(respondNode('Respond 409 invalid transition', at(6, 13), 'JSON.stringify($json.answer)', 409));
  f.add(respondNode('Respond 422 refund refused', at(7, 13), 'JSON.stringify($json.answer)', 422));
  f.chain('Find invoice to change', 'Find invoice payments', 'Find invoice refunds', 'Decide change', 'Route change decision');
  f.connect('Route change decision', 'Mark invoice void', 0);
  f.connect('Route change decision', 'Store refund row', 1);
  f.connect('Route change decision', 'Respond 200 voided', 2);
  f.connect('Route change decision', 'Prepare processor refund', 3);
  f.connect('Route change decision', 'Prepare refund result', 4);
  f.connect('Route change decision', 'Respond 404 unknown invoice', 5);
  f.connect('Route change decision', 'Respond 409 invalid transition', 6);
  f.connect('Route change decision', 'Respond 422 refund refused', 7);
  f.chain('Mark invoice void', 'Route on void write');
  f.connect('Route on void write', 'Prepare void result', 0);
  f.connect('Route on void write', 'Find invoice to change', 1);
  f.chain('Prepare void result', 'Respond 200 voided', 'Mark event done');
  f.chain('Store refund row', 'Route on refund write');
  f.connect('Route on refund write', 'Prepare processor refund', 0);
  f.connect('Route on refund write', 'Find invoice to change', 1);
  f.chain('Prepare processor refund', 'Send refund to processor', 'Prepare refund record', 'Record processor refund', 'Prepare refund result', 'Respond 200 refunded', 'Mark event done');
  for (const respond of ['Respond 404 unknown invoice', 'Respond 409 invalid transition', 'Respond 422 refund refused']) f.connect(respond, 'Mark event done');

  // --- 5. finish
  f.add(httpNode('Mark event done', at(0, 15), { method: 'POST', url: dataUrl('/v1/ledger/complete'), headers: DATA, runId: true, soft: true }));
  f.add(code('Summarize run', at(1, 15), `
const done = httpOutcome(response);
return [{ json: { event_id: ctx.event_id, type: ctx.type, outcome: ctx.outcome, invoice_id: ctx.invoice ? ctx.invoice.id : null, number: ctx.invoice ? ctx.invoice.number : null, warnings: done.ok ? [] : ['ledger_done_failed'] } }];`,
  { from: ['Prepare delivered result', 'Prepare void result', 'Prepare refund result', 'Check delivery progress', 'Decide change', 'Decide invoice plan'] }));
  f.connect('Mark event done', 'Summarize run', 0);
  f.connect('Mark event done', 'Summarize run', 1);
  return f.json();
}

export const ENTRY = { file: FILE, id: ID, name: NAME, webhooks: [{ method: 'POST', path: PATH }], readOnlyPostNodes: READ_ONLY_POST };
