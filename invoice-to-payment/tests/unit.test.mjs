// Unit tests for the invoicing workflows: the logic modules exactly as n8n runs them, the stand-ins, the Code-node
// glue (run outside n8n with stand-in globals), the generated workflows and layout.json. No n8n, no network
// beyond 127.0.0.1 stand-ins started in this process.
//   node _shared/bin/run-unit.mjs invoice-to-payment
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lintWorkflow } from '../../_shared/lib/lint.mjs';
import { KIT_WORKFLOW_VARIABLES } from '../../_shared/lib/n8n-env.mjs';
import { startStandin } from '../../_shared/lib/standin.mjs';
import { buildAll, FLOWS, MANIFEST } from '../workflow/build.mjs';
import { lib } from '../workflow/flows/common.mjs';
import { CLIENTS, CONFIG, invoiceModules, TABLES } from '../standins/index.mjs';
import { htmlText, minimalPdf } from '../standins/vendors.mjs';
import { jsonOf, runCode } from './run-code.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const L = lib.load();
const [issueWf, paymentsWf, chaseWf] = FLOWS.map(flow => flow.build());
const SECRET = 'test-secret-0123456789abcdef';
const NOW = 1794700000; // 2026-11-15T03:46:40Z

const line = (description, quantity, unit, taxCode) => ({ description, quantity, unit_price_minor: unit, tax_code: taxCode });
const LINES = [line('Brand identity system', 1, 8500000, 'VAT12'), line('Motion design, 30 s spot', 2.5, 1200000, 'VAT12'), line('Hosting pass-through', '1', 125050, 'ZERO')];
const requestEvent = (data = {}) => ({ id: 'evt_test_req_1', type: 'invoice.requested', created_at: '2026-11-02T01:00:00Z', data: { client_id: 'client_test_harbor', currency: 'PHP', issue_date: '2026-11-02', due_date: '2026-11-16', po_number: 'PO-7781', line_items: LINES, ...data } });
const clientRows = CLIENTS.map((client, i) => ({ id: `client_000${i + 1}`, ...client }));
const INVOICE = { id: 'invoice_0005', number: 'CRIT-2026-0001', client_id: 'client_test_harbor', status: 'sent', total_minor: 10000, currency: 'PHP', due_date: '2026-11-16', issue_date: '2026-11-02', money_seq: 0 };
const HOUR = 3600 * 1000;
const pay = (id, amount, extra = {}) => ({ id, event_id: `evt_${id}`, processor_payment_id: `pay_${id}`, reference: INVOICE.number, invoice_id: INVOICE.id, invoice_number: INVOICE.number, amount_minor: amount, currency: 'PHP', counted: true, match: 'partial', ...extra });

// ------------------------------------------------------------------ money

test('quantityMilli: decimal text to thousandths, float artefacts and bad values refused', () => {
  assert.deepEqual([L.quantityMilli(1), L.quantityMilli('2.5'), L.quantityMilli(0.125), L.quantityMilli('1000000')], [1000, 2500, 125, 1000000000]);
  for (const bad of [0, -1, '1.2345', 0.1 + 0.2, 1e-7, 'abc', '', null, undefined, '1,5', '10000000']) assert.equal(L.quantityMilli(bad), null, `refuses ${String(bad)}`);
});

test('computeTotals: line nets, one tax per rate on the summed net, integer minor units', () => {
  const { ok, totals } = L.computeTotals(LINES, CONFIG.tax_rates);
  assert.ok(ok);
  assert.deepEqual(totals.lines.map(l => l.net_minor), [8500000, 3000000, 125050]);
  assert.deepEqual(totals.tax_lines.map(t => [t.tax_code, t.net_minor, t.tax_minor]), [['VAT12', 11500000, 1380000], ['ZERO', 125050, 0]]);
  assert.deepEqual([totals.subtotal_minor, totals.tax_minor, totals.total_minor], [11625050, 1380000, 13005050]);
  assert.equal(L.formatMoney(totals.total_minor, 'PHP', 2), 'PHP 130,050.50');
});

test('computeTotals: rounding edges (half up once, per rate not per line, zero-decimal yen)', () => {
  const t = lines => L.computeTotals(lines, CONFIG.tax_rates).totals;
  assert.equal(t([line('a', 1.5, 333, 'ZERO')]).lines[0].net_minor, 500, '499.5 rounds up');
  assert.equal(t([line('a', 0.5, 333, 'ZERO')]).lines[0].net_minor, 167, '166.5 rounds up');
  assert.equal(t([line('a', 1.25, 1, 'ZERO')]).lines[0].net_minor, 1, '1.25 rounds down');
  // Two lines of 5 at 12%: per-line rounding would give 1 + 1 = 2; tax on the summed 10 is 1.2 -> 1.
  assert.equal(t([line('a', 1, 5, 'VAT12'), line('b', 1, 5, 'VAT12')]).tax_minor, 1);
  // Yen: 1,005 at 10% is 100.5 -> 101; 980 x 3 = 2,940 -> 294.
  assert.deepEqual([t([line('ramen', 1, 1005, 'JCT10')]).total_minor, t([line('ramen', 3, 980, 'JCT10')]).tax_minor], [1106, 294]);
  assert.equal(L.formatMoney(1106, 'JPY', 0), 'JPY 1,106');
  assert.equal(t([line('a', 1, 125, 'JCT10')]).tax_minor, 13, '12.5 rounds up');
});

test('computeTotals: refuses float prices, unknown tax codes, zero and oversized totals', () => {
  assert.match(L.computeTotals([line('a', 1, 10.5, 'VAT12')], CONFIG.tax_rates).errors.join(), /whole number of minor units/);
  assert.match(L.computeTotals([line('a', 1, 100, 'GST')], CONFIG.tax_rates).errors.join(), /"GST" is not a configured tax rate/);
  assert.match(L.computeTotals([line('a', 1, 0, 'ZERO')], CONFIG.tax_rates).errors.join(), /must be above 0/);
  assert.match(L.computeTotals([line('a', 1, 1000000000000, 'VAT12')], CONFIG.tax_rates).errors.join(), /larger than the service accepts/);
  // BigInt keeps the product exact where a float would not be: 999,999,999,999 x 0.001.
  assert.equal(L.computeTotals([line('a', 0.001, 999999999999, 'ZERO')], CONFIG.tax_rates).totals.total_minor, 1000000000);
});

test('formatMoney and formatQuantity: integer formatting, no floats', () => {
  assert.deepEqual([L.formatMoney(5, 'PHP', 2), L.formatMoney(-250, 'USD', 2), L.formatMoney(100000000, 'USD', 2), L.formatMoney(0, 'JPY', 0)], ['PHP 0.05', '-USD 2.50', 'USD 1,000,000.00', 'JPY 0']);
  assert.deepEqual([L.formatQuantity(2500), L.formatQuantity(1000), L.formatQuantity(125)], ['2.5', '1', '0.125']);
});

// ------------------------------------------------------------------ signatures and events

test('verifySignature: HMAC over the raw bytes, then the timestamp; every failure has its own reason', () => {
  const raw = Buffer.from(JSON.stringify(requestEvent()));
  const header = L.signatureHeader(SECRET, NOW, raw);
  assert.equal(L.verifySignature(SECRET, header, raw, NOW + 10).ok, true);
  assert.equal(L.verifySignature(SECRET, header, Buffer.concat([raw, Buffer.from(' ')]), NOW).reason, 'bad_signature', 'one extra byte fails');
  assert.equal(L.verifySignature('another-secret-0123456789', header, raw, NOW).reason, 'bad_signature');
  assert.equal(L.verifySignature(SECRET, undefined, raw, NOW).reason, 'missing_signature');
  assert.equal(L.verifySignature(SECRET, 'sha256=abc', raw, NOW).reason, 'malformed_signature');
  assert.equal(L.verifySignature(SECRET, header, null, NOW).reason, 'raw_body_missing');
  assert.equal(L.verifySignature(SECRET, header, raw, NOW + 301).reason, 'stale_timestamp');
  assert.equal(L.verifySignature(SECRET, header, raw, NOW - 301).reason, 'stale_timestamp', 'a timestamp from the future too');
  assert.equal(L.verifySignature('short', L.signatureHeader('short', NOW, raw), raw, NOW).reason, 'secret_not_configured');
  // During a secret rotation the sender may send two v1 values; one matching is enough.
  const rotated = `t=${NOW},v1=${'0'.repeat(64)},v1=${L.hmacHex(SECRET, NOW, raw)}`;
  assert.equal(L.verifySignature(SECRET, rotated, raw, NOW).ok, true);
  // A forged signature for a different timestamp does not pass.
  assert.equal(L.verifySignature(SECRET, `t=${NOW + 5},v1=${L.hmacHex(SECRET, NOW, raw)}`, raw, NOW).reason, 'bad_signature');
});

test('validateEvent: valid, ignored and invalid events, with reasons', () => {
  assert.equal(L.validateEvent(requestEvent(), L.BILLING_EVENT_TYPES).kind, 'valid');
  assert.equal(L.validateEvent({ ...requestEvent(), type: 'invoice.updated' }, L.BILLING_EVENT_TYPES).kind, 'ignored');
  assert.deepEqual(L.validateEvent({ id: 'bad id!', type: 'x', data: [] }, L.BILLING_EVENT_TYPES).errors, ['id must be 1-100 letters, digits or _.:-', 'type must look like "noun.verb"', 'created_at must be an ISO 8601 timestamp', 'data must be an object']);
  assert.deepEqual(L.validateEvent([], L.BILLING_EVENT_TYPES).errors, ['the body must be a JSON object']);
  const broken = L.validateEvent(requestEvent({ currency: 'peso', due_date: '2026-02-30', line_items: [{ description: 'x', quantity: 1, unit_price_minor: 99.5, tax_code: 'VAT12', discount: 5 }] }), L.BILLING_EVENT_TYPES);
  assert.equal(broken.kind, 'invalid');
  assert.deepEqual(broken.errors, ['data.currency must be an ISO 4217 code', 'data.due_date must be a date (YYYY-MM-DD)', 'data.line_items[0] has unknown field(s): discount', 'data.line_items[0].unit_price_minor must be a whole number of minor units (no decimals)']);
  const payment = { id: 'evt_pay_1', type: 'payment.received', created_at: '2026-11-18T02:00:00Z', data: { payment_id: 'pay_1', reference: 'CRIT-2026-0001', amount_minor: 100, currency: 'PHP', received_at: '2026-11-18T02:00:00Z' } };
  assert.equal(L.validateEvent(payment, L.PAYMENT_EVENT_TYPES).kind, 'valid');
  assert.deepEqual(L.validateEvent({ ...payment, data: { ...payment.data, amount_minor: 12.5 } }, L.PAYMENT_EVENT_TYPES).errors, ['data.amount_minor must be a whole number of minor units above 0']);
  assert.deepEqual(L.validateEvent({ ...payment, type: 'refund.requested', data: { invoice_number: 'CRIT-2026-0001', amount_minor: 0, currency: 'PHP' } }, L.BILLING_EVENT_TYPES).errors, ['data.amount_minor must be a whole number of minor units above 0']);
  assert.deepEqual(L.validateEvent({ id: 's1', type: 'sweep.reminders', created_at: '2026-11-19T01:00:00Z', data: { as_of: 'tomorrow' } }, L.SWEEP_EVENT_TYPES).errors, ['data.as_of must be an ISO 8601 timestamp']);
});

test('deadLetterRow: the same payload always gives the same body; unparsed bodies are kept as text', () => {
  const a = L.deadLetterRow('billing-webhook', 'issue-invoices', { id: 1 }, null, ['x']);
  assert.deepEqual(a, L.deadLetterRow('billing-webhook', 'issue-invoices', { id: 1 }, null, ['x']));
  assert.equal(a.row.payload_sha256, L.sha256Hex('{"id":1}'));
  assert.deepEqual(L.deadLetterRow('s', 'w', null, '{not json', ['body is not valid JSON']).row.payload, { unparsed: '{not json' });
});

// ------------------------------------------------------------------ invoice planning and documents

test('planInvoice: accepts a good request; every refusal has a code; a replay reuses its invoice', () => {
  const plan = L.planInvoice({ event_id: 'evt_1', ...requestEvent() }, CONFIG, clientRows, null);
  assert.deepEqual([plan.route, plan.has_invoice, plan.draft.sequence, plan.draft.total_minor, plan.draft.issue_date], ['accept', false, 'invoice-2026', 13005050, '2026-11-02']);
  const codes = (data, clients = clientRows) => L.planInvoice(requestEvent(data), CONFIG, clients, null).reasons.map(r => r.code);
  assert.deepEqual(codes({ client_id: 'client_test_nobody' }), ['unknown_client']);
  assert.deepEqual(codes({ client_id: 'client_test_dormant' }), ['client_inactive']);
  assert.deepEqual(codes({ currency: 'USD' }), ['currency_mismatch']);
  assert.deepEqual(codes({ currency: 'EUR' }, [{ ...clientRows[0], currency: 'EUR' }]), ['unsupported_currency']);
  assert.deepEqual(codes({ due_date: '2026-11-01' }), ['due_before_issue']);
  assert.deepEqual(codes({ line_items: [line('a', 1, 100, 'GST')] }), ['totals_invalid']);
  const replay = L.planInvoice(requestEvent(), CONFIG, clientRows, INVOICE);
  assert.deepEqual([replay.route, replay.has_invoice, replay.invoice.id], ['accept', true, 'invoice_0005']);
  // No issue date: the date of created_at in the business time zone (01:30 UTC on the 2nd is still the 2nd in Manila; 17:30 UTC on the 1st is the 2nd).
  const late = { ...requestEvent(), created_at: '2026-11-01T17:30:00Z' };
  delete late.data.issue_date;
  assert.equal(L.planInvoice(late, CONFIG, clientRows, null).draft.issue_date, '2026-11-02');
});

test('numbers, rows and delivery steps', () => {
  assert.equal(L.formatInvoiceNumber(CONFIG, '2026-11-02', 7), 'CRIT-2026-0007');
  assert.equal(L.formatInvoiceNumber(CONFIG, '2027-01-04', 12345), 'CRIT-2027-12345');
  const plan = L.planInvoice(requestEvent(), CONFIG, clientRows, null);
  const row = L.invoiceRow('evt_1', plan.draft, 'CRIT-2026-0001', 1);
  assert.deepEqual(row, L.invoiceRow('evt_1', plan.draft, 'CRIT-2026-0001', 1), 'deterministic');
  assert.deepEqual(Object.keys(row.row).filter(key => !TABLES.invoices.columns.includes(key)), [], 'only declared columns');
  assert.equal(row.row.status, 'issued');
  assert.deepEqual(['render', 'email', 'done', 'stop'], [{ status: 'issued' }, { status: 'issued', pdf_sha256: 'x' }, { status: 'sent' }, { status: 'void' }].map(L.deliveryStep));
  assert.equal(L.pdfKeyFor({ number: 'CRIT-2026-0001', issue_date: '2026-11-02' }), 'invoices/2026/CRIT-2026-0001.pdf');
  assert.deepEqual(Object.keys(L.invoiceSummary(INVOICE)), ['invoice_id', 'number', 'total_minor', 'currency', 'status']);
});

test('inspectPdf: signature, size limit, hash', () => {
  const pdf = minimalPdf(['Invoice CRIT-2026-0001']);
  const ok = L.inspectPdf(pdf, 2000000);
  assert.equal(ok.ok, true);
  assert.equal(ok.size, pdf.length);
  assert.equal(L.inspectPdf(Buffer.from('<html>'), 2000000).error, 'the renderer did not return a PDF');
  assert.match(L.inspectPdf(pdf, 10).error, /over the 10 limit/);
  assert.equal(L.inspectPdf(Buffer.alloc(0), 10).error, 'the renderer returned no bytes');
});

test('renderInvoiceHtml: CRIT template with every amount, values escaped', () => {
  const plan = L.planInvoice(requestEvent({ line_items: [...LINES, line('<script>alert(1)</script> & "quotes"', 1, 100, 'ZERO')] }), CONFIG, clientRows, null);
  const invoice = { id: 'invoice_0001', ...L.invoiceRow('evt_1', plan.draft, 'CRIT-2026-0001', 1).row };
  const html = L.renderInvoiceHtml(invoice, { name: 'Harbor & Pine Coffee' }, CONFIG);
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);
  assert.match(html, /Harbor &amp; Pine Coffee/);
  for (const text of ['CRIT-2026-0001', 'PHP 130,051.50', 'VAT 12% on PHP 115,000.00', 'PHP 13,800.00', '16 Nov 2026', 'PO-7781', '2.5']) assert.ok(html.includes(text), `has ${text}`);
  assert.ok(htmlText(html).includes('Amount due PHP 130,051.50'));
});

test('emails: Resend request shape; the invoice email attaches the PDF', () => {
  const client = clientRows[0];
  const invoice = { ...INVOICE, total_minor: 13005050 };
  const mail = L.invoiceEmailBody(invoice, client, CONFIG, 'CRIT Billing <billing@critdept.com>', 'JVBERi0=');
  assert.deepEqual(Object.keys(mail), ['from', 'to', 'subject', 'html', 'text', 'tags', 'attachments']);
  assert.deepEqual(mail.to, ['accounts@harbor-pine.example']);
  assert.equal(mail.subject, 'Invoice CRIT-2026-0001 from CRIT: PHP 130,050.50 due 16 Nov 2026');
  assert.deepEqual(mail.attachments, [{ filename: 'CRIT-2026-0001.pdf', content: 'JVBERi0=', content_type: 'application/pdf' }]);
  assert.ok(mail.tags.every(tag => /^[A-Za-z0-9_-]+$/.test(tag.name) && /^[A-Za-z0-9_-]+$/.test(tag.value)), 'Resend tag charset');
  const receipt = L.receiptEmailBody(invoice, client, { amount_minor: 13005050, currency: 'PHP', received_at: '2026-11-18T02:00:00Z', reference: 'CRIT-2026-0001' }, CONFIG, 'b@critdept.com');
  assert.equal(receipt.subject, 'Payment received for CRIT-2026-0001: PHP 130,050.50');
  assert.match(receipt.text, /We received PHP 130,050\.50 on 18 Nov 2026 with reference CRIT-2026-0001\. Invoice CRIT-2026-0001 \(PHP 130,050\.50\) is paid in full\./);
  const reminder = L.reminderEmailBody(invoice, client, { step_days: 10, days_overdue: 10, balance_minor: 6000 }, CONFIG, 'b@critdept.com');
  assert.equal(reminder.subject, 'Reminder: invoice CRIT-2026-0001 is 10 days overdue');
  assert.match(reminder.text, /was due on 16 Nov 2026\. PHP 60\.00 is still open\./);
});

// ------------------------------------------------------------------ payments, void and refund

test('matchPayment: each kind of payment, from the payments recorded before it', () => {
  const data = (amount, extra = {}) => ({ payment_id: 'pay_new', reference: INVOICE.number, amount_minor: amount, currency: 'PHP', received_at: '2026-11-18T02:00:00Z', ...extra });
  const m = (amount, before = [], extra = {}, invoice = INVOICE, refunds = []) => L.matchPayment('evt_new', data(amount, extra), invoice, before, refunds);
  assert.deepEqual([m(10000).match, m(10000).send_receipt, m(10000).review], ['exact', true, null]);
  assert.deepEqual([m(4000).match, m(4000).send_receipt, m(4000).paid_after_minor], ['partial', false, 4000]);
  assert.deepEqual([m(6000, [pay('payment_0001', 4000)]).match, m(6000, [pay('payment_0001', 4000)]).send_receipt], ['completes', true]);
  assert.deepEqual([m(10500).match, m(10500).excess_minor, m(10500).send_receipt, m(10500).review], ['overpaid', 500, true, 'overpaid']);
  assert.deepEqual([m(300, [pay('payment_0001', 10000)]).match, m(300, [pay('payment_0001', 10000)]).send_receipt], ['already_paid', false]);
  assert.deepEqual([m(10000, [], { currency: 'USD' }).match, m(10000, [], { currency: 'USD' }).counted], ['wrong_currency', false]);
  assert.deepEqual([m(10000, [], {}, null).match, m(10000, [], {}, null).invoice_id], ['unknown_reference', null]);
  assert.equal(m(10000, [], {}, { ...INVOICE, status: 'void' }).match, 'invoice_void');
  assert.equal(m(10000, [pay('payment_0001', 10000)], {}, INVOICE, [{ invoice_id: INVOICE.id, amount_minor: 10000, status: 'submitted' }]).match, 'after_refund');
  // Wrong-currency and unmatched payments do not count towards the invoice.
  assert.equal(m(10000, [pay('payment_0001', 10000, { counted: false, match: 'wrong_currency', currency: 'USD' })]).match, 'exact');
  // The same processor payment under a new event id is a duplicate, not a second payment.
  assert.deepEqual([m(10000, [pay('payment_0001', 10000, { processor_payment_id: 'pay_new' })]).route], ['duplicate']);
});

test('matchPayment: a replay reads its decision back from its own row and writes nothing again', () => {
  const data = { payment_id: 'pay_new', reference: INVOICE.number, amount_minor: 6000, currency: 'PHP', received_at: '2026-11-18T02:00:00Z' };
  const first = L.matchPayment('evt_new', data, INVOICE, [pay('payment_0001', 4000)], []);
  const body = L.paymentRow('evt_new', data, first);
  const own = { id: 'payment_0002', ...body.row, created_at: 'x' };
  // Later another payment arrived; the replay must still decide "completes", from its own row.
  const replay = L.matchPayment('evt_new', data, INVOICE, [pay('payment_0001', 4000), own, pay('payment_0003', 999)], []);
  assert.deepEqual([replay.route, replay.replay, replay.match, replay.send_receipt, replay.row.id], ['replay', true, 'completes', true, 'payment_0002']);
  assert.deepEqual(Object.keys(body.row).filter(key => !TABLES.payments.columns.includes(key)), []);
});

test('invoiceMoney: states derived from rows', () => {
  const s = (payments, refunds = [], invoice = INVOICE) => L.invoiceMoney(invoice, payments, refunds).state;
  assert.deepEqual([s([]), s([pay('a', 1)]), s([pay('a', 10000)]), s([pay('a', 10001)]), s([pay('a', 10000)], [{ invoice_id: INVOICE.id, amount_minor: 1 }]), s([pay('a', 10000)], [{ invoice_id: INVOICE.id, amount_minor: 10000 }]), s([], [], { ...INVOICE, status: 'void' })],
    ['unpaid', 'partially_paid', 'paid', 'overpaid', 'partially_refunded', 'refunded', 'void']);
});

test('paymentReview and reviewAlert: ids and amounts, never the client name, email or line text', () => {
  const payment = { id: 'payment_0009', event_id: 'evt_x', processor_payment_id: 'pay_x', reference: INVOICE.number, amount_minor: 10500, currency: 'PHP', excess_minor: 500 };
  const review = L.paymentReview('overpaid', payment, INVOICE, CONFIG);
  assert.equal(review.row.detail, 'Billing review: paid more than the invoice total. Payment payment_0009 (processor pay_x, reference CRIT-2026-0001): PHP 105.00. Invoice CRIT-2026-0001 (invoice_0005), total PHP 100.00. Excess PHP 5.00.');
  const alert = L.reviewAlert('#crit-billing', { ...review.row, id: 'review_item_0010' });
  assert.equal(alert.text, `${review.row.detail} Review item review_item_0010.`);
  assert.doesNotMatch(JSON.stringify([review, alert]), /harbor|Harbor|@|Brand identity/);
  assert.deepEqual(Object.keys(review.row).filter(key => !TABLES.review_items.columns.includes(key)), []);
});

test('transitions: void only while nothing is paid; refunds only up to what was paid', () => {
  const ev = (type, data) => ({ event_id: 'evt_change', type, data });
  const voidOf = (invoice, payments = []) => L.decideVoid(ev('invoice.void_requested', { invoice_number: INVOICE.number }), invoice, payments);
  assert.deepEqual([voidOf(INVOICE).route, voidOf({ ...INVOICE, status: 'issued' }).route], ['void', 'void']);
  assert.deepEqual([voidOf(INVOICE, [pay('a', 4000)]).route, voidOf(INVOICE, [pay('a', 4000)]).http_status, voidOf(INVOICE, [pay('a', 4000)]).answer.from], ['invalid_transition', 409, 'partially_paid']);
  assert.deepEqual([voidOf({ ...INVOICE, status: 'void' }).answer.from, voidOf({ ...INVOICE, status: 'void' }).answer.to], ['void', 'void']);
  assert.deepEqual([voidOf({ ...INVOICE, status: 'void', void_event_id: 'evt_change' }).route, voidOf({ ...INVOICE, status: 'void', void_event_id: 'evt_change' }).req], ['void_replay', null], 'the same void event again is a replay: answered, nothing written');
  assert.deepEqual([voidOf(null).route, voidOf(null).http_status], ['not_found', 404]);
  assert.equal(L.canTransition('issued', 'sent') && L.canTransition('sent', 'void') && !L.canTransition('sent', 'issued') && !L.canTransition('void', 'sent'), true);

  const NOW_MS = Date.parse('2026-11-20T00:00:00Z');
  const refund = (amount, payments = [pay('a', 10000)], refunds = [], invoice = INVOICE, currency = 'PHP') => L.decideRefund(ev('refund.requested', { invoice_number: INVOICE.number, amount_minor: amount, currency }), invoice, payments, refunds, NOW_MS);
  assert.deepEqual([refund(10000).route, refund(10000).refundable_after_minor], ['refund', 0]);
  assert.deepEqual([refund(10001).route, refund(10001).http_status, refund(10001).answer.reason, refund(10001).answer.refundable_minor], ['refund_refused', 422, 'refund_exceeds_paid', 10000]);
  assert.equal(refund(7000, [pay('a', 10000)], [{ event_id: 'evt_earlier', invoice_id: INVOICE.id, amount_minor: 4000, status: 'submitted' }]).answer.refundable_minor, 6000);
  assert.deepEqual([refund(100, []).route, refund(100, []).answer.from], ['invalid_transition', 'unpaid']);
  assert.equal(refund(100, [], [], { ...INVOICE, status: 'void' }).answer.from, 'void');
  assert.equal(refund(100, [pay('a', 10000)], [], INVOICE, 'USD').answer.reason, 'currency_mismatch');
  // A replay finds its own refund row and goes on from it, even though that refund now uses up the paid amount:
  // no processor answer recorded -> resume (same key, inside the window); recorded -> answer only.
  const ownRow = extra => ({ id: 'refund_0009', event_id: 'evt_change', invoice_id: INVOICE.id, invoice_number: INVOICE.number, amount_minor: 10000, status: 'approved', created_at: new Date(NOW_MS - 2 * HOUR).toISOString(), ...extra });
  const resume = refund(10000, [pay('a', 10000)], [ownRow()]);
  assert.deepEqual([resume.route, resume.replay, resume.own_refund.id, resume.req, resume.refundable_after_minor], ['refund_resume', true, 'refund_0009', null, 0]);
  assert.equal(refund(10000, [pay('a', 10000)], [ownRow({ status: 'submitted', processor_refund_id: 're_1' })]).route, 'refund_replay');
  // Past the processor's 24-hour key window (23 h with margin) a resend could refund twice: the run stops.
  assert.throws(() => refund(10000, [pay('a', 10000)], [ownRow({ created_at: new Date(NOW_MS - 30 * HOUR).toISOString() })]), /refund_0009 on CRIT-2026-0001 \(invoice_0005\) .* past the 23-hour resend window, so a second send could refund twice; not resent/);
});

test('money guard: every money write carries the money_seq it was decided against', () => {
  const ev = (type, data) => ({ event_id: 'evt_change', type, data });
  const seq3 = { ...INVOICE, money_seq: 3 };
  const voided = L.decideVoid(ev('invoice.void_requested', { invoice_number: INVOICE.number, reason: 'x' }), seq3, []);
  assert.deepEqual(voided.req.body, { expect: { status: ['issued', 'sent'] }, set: { status: 'void', void_event_id: 'evt_change', void_reason: 'x' }, guard: { column: 'money_seq', expect: 3 } });
  const refunded = L.decideRefund(ev('refund.requested', { invoice_number: INVOICE.number, amount_minor: 100, currency: 'PHP' }), seq3, [pay('a', 10000)], [], Date.now());
  assert.deepEqual(refunded.req.body.guard, { table: 'invoices', id: 'invoice_0005', column: 'money_seq', expect: 3 });
  assert.deepEqual([L.guardTag(refunded.req.body.guard), L.guardTag(null)], ['seq3', 'unguarded']);
  assert.equal(L.moneyGuard(null), null, 'a payment with no invoice has nothing to guard');
  // A missing counter is never taken as 0: the write cannot be built.
  assert.throws(() => L.decideVoid(ev('invoice.void_requested', { invoice_number: INVOICE.number }), { ...INVOICE, money_seq: undefined }, []), /has no money_seq/);
  assert.deepEqual([L.moneyAttempt(0, 'x'), L.moneyAttempt(4, 'x')], [1, 5]);
  assert.throws(() => L.moneyAttempt(5, 'Decide change for N'), /changed under this run 5 times in a row/);
  assert.throws(() => L.moneyAttempt(undefined, 'x'), /No run index/);
});

test('resend windows: a lost answer is resent with the same key only inside 23 hours', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const ago = hours => new Date(now - hours * HOUR).toISOString();
  assert.deepEqual([L.withinResendWindow(ago(1), now), L.withinResendWindow(ago(22.9), now), L.withinResendWindow(ago(23), now), L.withinResendWindow('not a time', now)], [true, true, false, false]);
  const emailStep = { ...INVOICE, status: 'issued', pdf_sha256: 'a'.repeat(64) };
  assert.equal(L.emailResendBlock({ ...emailStep, email_started_at: ago(2) }, now), null, 'inside the window: resend with the same key');
  assert.equal(L.emailResendBlock(emailStep, now), null, 'never started: send');
  assert.equal(L.emailResendBlock({ ...emailStep, status: 'sent', email_id: 'm', email_started_at: ago(30) }, now), null, 'delivered: nothing to send');
  assert.match(L.emailResendBlock({ ...emailStep, email_started_at: ago(30) }, now), /^Invoice CRIT-2026-0001 \(invoice_0005\): an email send started at .* past the 23-hour resend window; not resent\./);
  const payment = { id: 'payment_0002', event_id: 'evt_p', reference: INVOICE.number };
  assert.equal(L.receiptResendBlock({ ...payment, created_at: ago(1) }, now), null);
  assert.match(L.receiptResendBlock({ ...payment, created_at: ago(30) }, now), /^Payment payment_0002 \(event evt_p, reference CRIT-2026-0001\) .* not resent/);
});

// ------------------------------------------------------------------ reminders and watchdog

test('planReminders: highest step reached, never twice, missed steps not sent late', () => {
  const plan = (asOfDate, extra = {}) => L.planReminders({ invoices: [INVOICE], payments: [], refunds: [], reminders: [], clients: clientRows, steps: [21, 3, 10], asOfDate, ...extra });
  assert.deepEqual(plan('2026-11-16').skipped, [], 'due today is not overdue');
  assert.equal(plan('2026-11-17').skipped[0].reason, 'no_step_reached');
  assert.deepEqual([plan('2026-11-19').candidates[0].step_days, plan('2026-11-19').candidates[0].days_overdue], [3, 3]);
  const sent3 = [{ invoice_id: INVOICE.id, step_days: 3 }];
  assert.equal(plan('2026-11-19', { reminders: sent3 }).skipped[0].reason, 'step_already_sent');
  assert.equal(plan('2026-11-25', { reminders: sent3 }).skipped[0].reason, 'step_already_sent', 'day 9: still step 3');
  assert.deepEqual([plan('2026-11-26', { reminders: sent3 }).candidates[0].step_days, plan('2026-11-26', { reminders: sent3 }).candidates[0].missed_steps], [10, []]);
  assert.deepEqual([plan('2026-12-11').candidates[0].step_days, plan('2026-12-11').candidates[0].missed_steps], [21, [3, 10]]);
  assert.equal(plan('2026-11-30', { reminders: [{ invoice_id: INVOICE.id, step_days: 21 }] }).skipped[0].reason, 'step_already_sent', 'a later step sent means no earlier one');
  assert.equal(plan('2026-11-19', { payments: [pay('a', 10000)] }).skipped[0].reason, 'paid');
  assert.equal(plan('2026-11-19', { payments: [pay('a', 10500)] }).skipped[0].reason, 'paid');
  assert.equal(plan('2026-11-19', { payments: [pay('a', 4000)] }).candidates[0].balance_minor, 6000);
  assert.equal(plan('2026-11-19', { payments: [pay('a', 10000)], refunds: [{ invoice_id: INVOICE.id, amount_minor: 10000 }] }).skipped[0].reason, 'refunded');
  assert.deepEqual(plan('2026-11-19', { invoices: [{ ...INVOICE, status: 'void' }, { ...INVOICE, status: 'issued' }] }), { candidates: [], skipped: [] }, 'void and undelivered invoices are not chased');
  assert.equal(L.reminderKey(plan('2026-11-19').candidates[0]), 'invoice_0005:d3');
});

test('resolveAsOf: the clock is fixed only when the override is allowed', () => {
  assert.deepEqual(L.resolveAsOf('2026-11-19T01:00:00Z', 'allow', 5), { ms: Date.parse('2026-11-19T01:00:00Z'), overridden: true });
  assert.deepEqual(L.resolveAsOf('2026-11-19T01:00:00Z', undefined, 5), { ms: 5, overridden: false });
  assert.deepEqual(L.resolveAsOf(null, 'allow', 5), { ms: 5, overridden: false });
  assert.equal(L.localDate(Date.parse('2026-11-18T16:30:00Z'), 'Asia/Manila'), '2026-11-19');
  assert.deepEqual([L.daysBetween('2026-11-16', '2026-12-11'), L.addDays('2026-12-30', 3), L.displayDate('2026-01-05')], [25, '2027-01-02', '5 Jan 2026']);
});

test('findStuck and watchdogAlert: undelivered invoices and orphan numbers after the threshold, ids only', () => {
  const now = Date.parse('2026-11-15T10:00:00Z');
  const invoices = [
    { id: 'invoice_0001', number: 'CRIT-2026-0001', status: 'issued', created_at: '2026-11-15T09:00:00Z', request_event_id: 'evt_a', pdf_sha256: 'x' },
    { id: 'invoice_0002', number: 'CRIT-2026-0002', status: 'issued', created_at: '2026-11-15T09:45:00Z', request_event_id: 'evt_b' },
    { id: 'invoice_0003', number: 'CRIT-2026-0003', status: 'sent', created_at: '2026-11-14T09:00:00Z', request_event_id: 'evt_c' },
  ];
  const numbers = [{ id: 'invoice_number_0004', sequence: 'invoice-2026', value: 1, key: 'evt_a', created_at: '2026-11-15T09:00:00Z' }, { id: 'invoice_number_0007', sequence: 'invoice-2026', value: 4, key: 'evt_orphan', created_at: '2026-11-15T09:10:00Z' }];
  const found = L.findStuck(invoices, numbers, now, 30);
  assert.deepEqual(found.stuck_invoices.map(item => [item.ref, item.age_minutes, item.pdf_stored]), [['invoice_0001', 60, true]]);
  assert.deepEqual(found.orphan_numbers.map(item => [item.ref, item.value, item.age_minutes]), [['invoice_number_0007', 4, 50]]);
  assert.equal(L.watchdogAlert('#crit-billing', found, 30).text, 'Invoice watchdog:\n1 invoice(s) not delivered after 30 minutes:\n- CRIT-2026-0001 (invoice_0001), issued 60 min ago, PDF stored\n1 invoice number(s) taken with no invoice row:\n- invoice-2026 #4 (invoice_number_0007), taken 50 min ago');
});

// ------------------------------------------------------------------ stand-ins

async function withStandin(fn) {
  const secrets = { data: 'd-token', pdf: 'p-token', storage: 's-token', email: 'e-token', payments: 'y-token' };
  const standin = await startStandin({ modules: invoiceModules({ secrets }) });
  const call = async (method, path, body, headers = {}) => {
    const isBytes = Buffer.isBuffer(body);
    const res = await fetch(`${standin.url}${path}`, { method, headers: { 'content-type': isBytes ? 'application/pdf' : 'application/json', 'x-run-id': '7', ...headers }, body: body === undefined ? undefined : isBytes ? body : JSON.stringify(body) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, json: type.includes('json') ? await res.json() : null, bytes: type.includes('json') ? null : Buffer.from(await res.arrayBuffer()) };
  };
  try { await fn(standin, call, secrets); } finally { await standin.close(); }
}

test('data service sequence: gap-free per sequence, one value per key, the same key gets the same value', () => withStandin(async (standin, call) => {
  const auth = { authorization: 'Bearer d-token' };
  const next = (name, key, headers = auth) => call('POST', `/data/v1/sequences/${name}/next`, { key }, headers);
  assert.deepEqual([(await next('invoice-2026', 'evt_a')).json.value, (await next('invoice-2026', 'evt_b')).json.value, (await next('invoice-2026', 'evt_a')).json.outcome], [1, 2, 'existing']);
  assert.equal((await next('invoice-2027', 'evt_c')).json.value, 1, 'each year starts at 1');
  assert.equal((await next('invoice-2026', 'evt_d')).json.value, 3);
  assert.equal((await next('invoice-2026', 'evt_e', {})).status, 401);
  assert.equal((await next('Bad Name', 'evt_e')).status, 400);
  assert.deepEqual(standin.state().data.tables.invoice_numbers.filter(r => r.sequence === 'invoice-2026').map(r => r.value), [1, 2, 3]);
  assert.equal(standin.state().data.tables.clients.length, CLIENTS.length, 'clients are seeded');
}));

test('data service update: compare-and-set, a repeat is a no-op, conflicts and bad columns refused', () => withStandin(async (standin, call) => {
  const h = key => ({ authorization: 'Bearer d-token', 'idempotency-key': key });
  const stored = (await call('POST', '/data/v1/rows/invoices', { row: { number: 'N-1', request_event_id: 'e1', status: 'issued' } }, h('k0'))).json.row;
  const patch = (body, key) => call('PATCH', `/data/v1/rows/invoices/${stored.id}`, body, h(key));
  const sent = await patch({ expect: { status: 'issued' }, set: { status: 'sent', email_id: 'm1' } }, 'k1');
  assert.deepEqual([sent.status, sent.json.outcome, sent.json.changed, sent.json.row.status], [200, 'changed', true, 'sent']);
  assert.equal((await patch({ expect: { status: 'issued' }, set: { status: 'sent', email_id: 'm1' } }, 'k2')).json.changed, false, 'already in the target state');
  const conflict = await patch({ expect: { status: ['issued'] }, set: { status: 'void' } }, 'k3');
  assert.deepEqual([conflict.status, conflict.json.error, conflict.json.columns], [409, 'conflict', ['status']]);
  assert.equal((await patch({ set: { colour: 'red' } }, 'k4')).status, 400);
  assert.equal((await call('PATCH', '/data/v1/rows/invoices/invoice_9999', { set: { status: 'void' } }, h('k5'))).status, 404);
  assert.equal((await call('PATCH', `/data/v1/rows/invoices/${stored.id}`, { set: { status: 'void' } }, { authorization: 'Bearer d-token' })).status, 400, 'Idempotency-Key required');
  const row = standin.state().data.tables.invoices[0];
  assert.deepEqual(row.history.map(entry => entry.set), [['status', 'email_id']]);
  assert.equal(row.updated_by_run, '7');
  // stamp: the service's clock, only while empty, so a replayed stamp is a no-op and keeps the first time.
  const first = await patch({ stamp: ['email_started_at'] }, 'k6');
  const again = await patch({ stamp: ['email_started_at'] }, 'k7');
  assert.deepEqual([first.json.outcome, again.json.outcome, again.json.row.email_started_at], ['changed', 'unchanged', first.json.row.email_started_at]);
  assert.match(first.json.row.email_started_at, /^\d{4}-\d\d-\d\dT/);
}));

test('data service guard: a money write lands only while money_seq holds the value read; a missing counter never matches', () => withStandin(async (standin, call) => {
  const h = key => ({ authorization: 'Bearer d-token', 'idempotency-key': key });
  const invoice = (await call('POST', '/data/v1/rows/invoices', { row: { number: 'N-1', request_event_id: 'e1', status: 'sent', money_seq: 0 } }, h('i1'))).json.row;
  const legacy = (await call('POST', '/data/v1/rows/invoices', { row: { number: 'N-2', request_event_id: 'e2', status: 'sent' } }, h('i2'))).json.row;
  const guard = (id, expect) => ({ table: 'invoices', id, column: 'money_seq', expect });
  const insert = (event, expect, key, id = invoice.id) => call('POST', '/data/v1/rows/refunds/guarded', { row: { event_id: event, invoice_id: id, invoice_number: 'N-1', amount_minor: 100, currency: 'PHP', status: 'approved' }, guard: guard(id, expect) }, h(key));
  const a = await insert('evt_a', 0, 'r1');
  const b = await insert('evt_b', 0, 'r2');
  assert.deepEqual([a.status, a.json.outcome, a.json.row.money_seq], [201, 'stored', 1]);
  assert.deepEqual([b.status, b.json.outcome, b.json.guard.current], [200, 'conflict', 1], 'the second writer with the same "before" loses');
  assert.equal((await insert('evt_b', 1, 'r3')).json.outcome, 'stored', 'decided again against money_seq 1, it lands');
  assert.equal((await insert('evt_c', 0, 'r4', legacy.id)).json.outcome, 'conflict', 'no money_seq on the row: never treated as 0');
  assert.equal((await call('POST', '/data/v1/rows/refunds/guarded', { row: { event_id: 'evt_d', money_seq: 9 }, guard: guard(invoice.id, 2) }, h('r5'))).status, 400, 'the row cannot set the counter itself');
  assert.equal((await insert('evt_a', 2, 'r6')).status, 409, 'unique keys still hold');
  const plain = await call('POST', '/data/v1/rows/payments/guarded', { row: { event_id: 'evt_p', processor_payment_id: 'pay_p', reference: 'X', amount_minor: 5, currency: 'PHP' }, guard: null }, h('p1'));
  assert.deepEqual([plain.status, plain.json.outcome, plain.json.row.money_seq], [201, 'stored', undefined], 'a payment with no invoice is stored unguarded');
  // The same guard on an update (a void): conflict is answered 200, not as an HTTP error n8n would retry as is.
  const patch = (expect, key) => call('PATCH', `/data/v1/rows/invoices/${invoice.id}`, { expect: { status: ['issued', 'sent'] }, set: { status: 'void' }, guard: { column: 'money_seq', expect } }, h(key));
  const stale = await patch(0, 'v1');
  assert.deepEqual([stale.status, stale.json.outcome, stale.json.row.status], [200, 'conflict', 'sent']);
  const won = await patch(2, 'v2');
  assert.deepEqual([won.json.outcome, won.json.row.status, won.json.row.money_seq], ['changed', 'void', 3]);
  const rows = standin.state().data.tables;
  assert.deepEqual([rows.refunds.length, rows.invoices[0].money_seq], [2, 3]);
}));

// Two runs that both read before either writes: the race the e2e scenarios provoke in n8n, replayed step by step
// against the data service with the decision code the workflows run.
test('race: two refunds, two full payments, partial plus rest, void plus payment, each decided against the same "before"', () => withStandin(async (standin, call) => {
  const h = key => ({ authorization: 'Bearer d-token', 'idempotency-key': key });
  let n = 0;
  const seedInvoice = async () => (await call('POST', '/data/v1/rows/invoices', { row: { number: `N-${++n}`, request_event_id: `seed_${n}`, status: 'sent', total_minor: 10000, currency: 'PHP', money_seq: 0 } }, h(`seed_${n}`))).json.row;
  const auth = { authorization: 'Bearer d-token' };
  const get = path => call('GET', path, undefined, auth);
  const readAs = async invoice => {
    const fresh = (await get(`/data/v1/rows/invoices?number=${invoice.number}`)).json.rows[0];
    return { invoice: fresh, payments: (await get(`/data/v1/rows/payments?reference=${invoice.number}`)).json.rows, refunds: (await get(`/data/v1/rows/refunds?invoice_number=${invoice.number}`)).json.rows };
  };
  const refundEvent = (id, amount) => ({ event_id: id, type: 'refund.requested', data: { invoice_number: null, amount_minor: amount, currency: 'PHP' } });
  const payEvent = (id, amount) => ({ id, data: { payment_id: `pay_${id}`, reference: null, amount_minor: amount, currency: 'PHP', received_at: '2026-11-18T02:00:00Z' } });
  const storePayment = (event, state, key) => {
    const match = L.matchPayment(event.id, event.data, state.invoice, state.payments, state.refunds);
    return call('POST', '/data/v1/rows/payments/guarded', { ...L.paymentRow(event.id, event.data, match), guard: L.moneyGuard(state.invoice) }, h(`${key}:${event.id}:${L.guardTag(L.moneyGuard(state.invoice))}`)).then(res => ({ res, match }));
  };
  // Payments a and b: both read (the invoice first, then its rows), then both write; the loser reads again and decides again.
  const payRace = async (invoice, amountA, amountB) => {
    const a = payEvent(`a${invoice.id}`, amountA); const b = payEvent(`b${invoice.id}`, amountB);
    a.data.reference = invoice.number; b.data.reference = invoice.number;
    const [stateA, stateB] = [await readAs(invoice), await readAs(invoice)];
    const first = await storePayment(a, stateA, 'pa');
    let second = await storePayment(b, stateB, 'pb');
    assert.equal(second.res.json.outcome, 'conflict', 'the second decision was made against the old state');
    second = await storePayment(b, await readAs(invoice), 'pb');
    return [first, second].map(x => [x.res.json.outcome, x.match.match, x.match.send_receipt]);
  };

  // Two refunds of 7,000 on 10,000 paid.
  const paid = await seedInvoice();
  await call('POST', '/data/v1/rows/payments/guarded', { row: { event_id: 'seedpay', processor_payment_id: 'pay_seed', reference: paid.number, invoice_id: paid.id, invoice_number: paid.number, amount_minor: 10000, currency: 'PHP', match: 'exact', counted: true, excess_minor: 0, paid_after_minor: 10000 }, guard: L.moneyGuard(paid) }, h('seedpay'));
  const r1 = refundEvent('evt_r1', 7000); const r2 = refundEvent('evt_r2', 7000);
  r1.data.invoice_number = paid.number; r2.data.invoice_number = paid.number;
  const [s1, s2] = [await readAs(paid), await readAs(paid)];
  const d1 = L.decideRefund(r1, s1.invoice, s1.payments, s1.refunds, Date.now());
  const d2 = L.decideRefund(r2, s2.invoice, s2.payments, s2.refunds, Date.now());
  assert.deepEqual([d1.route, d2.route], ['refund', 'refund'], 'read together, both look allowed');
  const w1 = await call('POST', '/data/v1/rows/refunds/guarded', d1.req.body, h('r1:seq1'));
  const w2 = await call('POST', '/data/v1/rows/refunds/guarded', d2.req.body, h('r2:seq1'));
  assert.deepEqual([w1.json.outcome, w2.json.outcome], ['stored', 'conflict'], 'only one refund row lands');
  const again = await readAs(paid);
  const d2b = L.decideRefund(r2, again.invoice, again.payments, again.refunds, Date.now());
  assert.deepEqual([d2b.route, d2b.answer.reason, d2b.answer.refundable_minor], ['refund_refused', 'refund_exceeds_paid', 3000]);

  assert.deepEqual(await payRace(await seedInvoice(), 10000, 10000), [['stored', 'exact', true], ['stored', 'already_paid', false]], 'two full payments: one receipt, the second goes to review');
  assert.deepEqual(await payRace(await seedInvoice(), 4000, 6000), [['stored', 'partial', false], ['stored', 'completes', true]], 'partial plus rest: the rest completes it and gets the receipt');

  // A void and a full payment read together: the payment lands first, so the void, decided again, is refused.
  const open = await seedInvoice();
  const v = { event_id: 'evt_v', type: 'invoice.void_requested', data: { invoice_number: open.number } };
  const [sv, sp] = [await readAs(open), await readAs(open)];
  const dv = L.decideVoid(v, sv.invoice, sv.payments);
  const p = payEvent('p_void', 10000); p.data.reference = open.number;
  assert.equal((await storePayment(p, sp, 'pv')).res.json.outcome, 'stored');
  assert.equal((await call('PATCH', `/data/v1/rows/invoices/${open.id}`, dv.req.body, h('v:seq0'))).json.outcome, 'conflict');
  const sv2 = await readAs(open);
  assert.deepEqual([L.decideVoid(v, sv2.invoice, sv2.payments).route, L.decideVoid(v, sv2.invoice, sv2.payments).answer.from], ['invalid_transition', 'paid']);
  assert.equal(standin.state().data.tables.invoices.find(row => row.id === open.id).status, 'sent');

  // The other order: the void lands first, so the payment, decided again, is invoice_void (not counted, review).
  const open2 = await seedInvoice();
  const v2 = { event_id: 'evt_v2', type: 'invoice.void_requested', data: { invoice_number: open2.number } };
  const [sv3, sp3] = [await readAs(open2), await readAs(open2)];
  const p2 = payEvent('p_void2', 10000); p2.data.reference = open2.number;
  assert.equal((await call('PATCH', `/data/v1/rows/invoices/${open2.id}`, L.decideVoid(v2, sv3.invoice, sv3.payments).req.body, h('v2:seq0'))).json.outcome, 'changed');
  assert.equal((await storePayment(p2, sp3, 'pv2')).res.json.outcome, 'conflict');
  const late = await storePayment(p2, await readAs(open2), 'pv2');
  assert.deepEqual([late.res.json.outcome, late.match.match, late.match.counted, late.match.send_receipt, late.match.review], ['stored', 'invoice_void', false, false, 'invoice_void']);
}));

test('vendor stand-ins: deterministic PDF, storage round trip, email and refund keys honoured', () => withStandin(async (standin, call) => {
  const html = L.renderInvoiceHtml({ ...INVOICE, line_items: [], tax_lines: [], subtotal_minor: 10000, po_number: null }, { name: 'X' }, CONFIG);
  const pdfAuth = { authorization: 'Bearer p-token' };
  const a = await call('POST', '/pdf/v1/render', { html, filename: 'a.pdf' }, pdfAuth);
  const b = await call('POST', '/pdf/v1/render', { html, filename: 'a.pdf' }, pdfAuth);
  assert.equal(a.bytes.slice(0, 5).toString(), '%PDF-');
  assert.ok(a.bytes.equals(b.bytes), 'same HTML, same bytes');
  assert.match(a.bytes.toString('latin1'), /\(CRIT-2026-0001\) '/);
  assert.equal((await call('POST', '/pdf/v1/render', { html: 'nope' }, pdfAuth)).status, 400);
  const store = { authorization: 'Bearer s-token' };
  const put = await call('PUT', '/storage/objects/crit-invoices/invoices/2026/CRIT-2026-0001.pdf', a.bytes, store);
  assert.equal(put.json.key, 'invoices/2026/CRIT-2026-0001.pdf');
  const got = await call('GET', '/storage/objects/crit-invoices/invoices/2026/CRIT-2026-0001.pdf', undefined, store);
  assert.ok(got.bytes.equals(a.bytes));
  assert.equal((await call('GET', '/storage/objects/crit-invoices/missing.pdf', undefined, store)).status, 404);
  const mail = { from: 'b@critdept.com', to: ['a@x.example'], subject: 's', text: 't', attachments: [{ filename: 'a.pdf', content: a.bytes.toString('base64') }] };
  const keyed = { authorization: 'Bearer e-token', 'idempotency-key': 'k1' };
  const first = await call('POST', '/email/emails', mail, keyed);
  const again = await call('POST', '/email/emails', mail, keyed);
  assert.equal(again.json.id, first.json.id);
  assert.equal(standin.state().email.sent.length, 1, 'one email for one key');
  assert.equal(standin.state().email.sent[0].attachments[0].is_pdf, true);
  assert.equal((await call('POST', '/email/emails', { ...mail, to: ['not-an-address'] }, { ...keyed, 'idempotency-key': 'k2' })).status, 422);
  const refund = { payment_reference: 'CRIT-2026-0001', amount: 100, currency: 'PHP', metadata: {} };
  const r1 = await call('POST', '/payments/v1/refunds', refund, { authorization: 'Bearer y-token', 'idempotency-key': 'r1' });
  await call('POST', '/payments/v1/refunds', refund, { authorization: 'Bearer y-token', 'idempotency-key': 'r1' });
  assert.equal(r1.json.id, 're_test_0001');
  assert.equal(standin.state().payments.refunds.length, 1);
}));

// ------------------------------------------------------------------ Code-node glue

test('glue: Verify signature parses the payload from the verified raw bytes only', async () => {
  const event = requestEvent();
  const raw = Buffer.from(JSON.stringify(event));
  const now = Math.floor(Date.now() / 1000);
  const headers = { 'x-crit-signature': L.signatureHeader(SECRET, now, raw) };
  const [ok] = jsonOf(await runCode(issueWf, 'Verify signature', { input: { headers, body: { tampered: true } }, binary: { data: raw }, env: { BILLING_WEBHOOK_SECRET: SECRET } }));
  assert.deepEqual([ok.signature_ok, ok.payload.id], [true, 'evt_test_req_1'], 'the payload comes from the raw bytes, not n8n\'s parsed body');
  const [bad] = jsonOf(await runCode(issueWf, 'Verify signature', { input: { headers, body: {} }, binary: { data: Buffer.from(JSON.stringify({ ...event, id: 'evt_other' })) }, env: { BILLING_WEBHOOK_SECRET: SECRET } }));
  assert.deepEqual([bad.signature_ok, bad.signature_reason, bad.payload], [false, 'bad_signature', null]);
  const [noRaw] = jsonOf(await runCode(paymentsWf, 'Verify signature', { input: { headers, body: event }, env: { PAYMENTS_WEBHOOK_SECRET: SECRET } }));
  assert.equal(noRaw.signature_reason, 'raw_body_missing');
});

test('glue: Decide invoice plan refuses with 422 reasons and takes no number', async () => {
  const claim = { event_id: 'evt_x', type: 'invoice.requested', ...requestEvent({ client_id: 'client_test_nobody' }) };
  const nodes = { 'Read claim result': claim, 'Fetch billing config': { config: CONFIG }, 'Find client': { rows: [] } };
  const [out] = jsonOf(await runCode(issueWf, 'Decide invoice plan', { input: { rows: [] }, nodes }));
  assert.deepEqual([out.route, out.answer.status, out.answer.reasons[0].code, out.req.body.outcome, out.sequence], ['reject', 'rejected', 'unknown_client', 'rejected', undefined]);
  await assert.rejects(runCode(issueWf, 'Decide invoice plan', { input: { rows: [] }, nodes: { ...nodes, 'Fetch billing config': { config: { timezone: 'UTC' } } } }), /Config invoice-to-payment is missing: seller/);
  const [accept] = jsonOf(await runCode(issueWf, 'Decide invoice plan', { input: { rows: [] }, nodes: { ...nodes, 'Read claim result': { ...claim, data: requestEvent().data }, 'Find client': { rows: [clientRows[0]] } } }));
  assert.deepEqual([accept.route, accept.sequence, accept.req.body], ['accept', 'invoice-2026', { key: 'evt_x' }]);
});

test('glue: Check delivery progress resumes where the last run stopped', async () => {
  const ctx = { event_id: 'evt_x', config: CONFIG, client: clientRows[0] };
  const plan = L.planInvoice(requestEvent(), CONFIG, clientRows, null);
  const invoice = { id: 'invoice_0001', ...L.invoiceRow('evt_x', plan.draft, 'CRIT-2026-0001', 1).row };
  const step = async inv => jsonOf(await runCode(issueWf, 'Check delivery progress', { nodes: { 'Read stored invoice': { ...ctx, invoice: inv } } }))[0];
  const render = await step(invoice);
  assert.deepEqual([render.step_route, render.pdf_key, render.req.body.filename], ['render', 'invoices/2026/CRIT-2026-0001.pdf', 'CRIT-2026-0001.pdf']);
  assert.match(render.req.body.html, /CRIT-2026-0001/);
  assert.equal((await step({ ...invoice, pdf_sha256: 'abc', pdf_key: 'k' })).step_route, 'email');
  const done = await step({ ...invoice, status: 'sent', email_id: 'm' });
  assert.deepEqual([done.step_route, done.outcome, done.req.body.result.number], ['finish', 'already_delivered', 'CRIT-2026-0001']);
  assert.equal((await step({ ...invoice, status: 'void' })).outcome, 'void_before_delivery');
});

test('glue: Prepare invoice email refuses bytes that do not match the recorded SHA-256', async () => {
  const pdf = minimalPdf(['x']);
  const ctx = { event_id: 'evt_x', config: CONFIG, client: clientRows[0], invoice: { ...INVOICE, pdf_sha256: L.inspectPdf(pdf, 1e6).sha256 } };
  const [ok] = jsonOf(await runCode(issueWf, 'Prepare invoice email', { nodes: { 'Check delivery progress': ctx }, binary: { data: pdf }, env: { EMAIL_FROM: 'CRIT Billing <billing@critdept.com>' } }));
  assert.equal(Buffer.from(ok.req.body.attachments[0].content, 'base64').equals(pdf), true);
  await assert.rejects(runCode(issueWf, 'Prepare invoice email', { nodes: { 'Check delivery progress': ctx }, binary: { data: minimalPdf(['y']) } }), /does not match the SHA-256/);
});

test('glue: Decide payment match prepares the payment row; a duplicate is not stored', async () => {
  const claim = { event_id: 'evt_pay_9', data: { payment_id: 'pay_9', reference: INVOICE.number, amount_minor: 10000, currency: 'PHP', received_at: '2026-11-18T02:00:00Z' } };
  const nodes = { 'Read claim result': claim, 'Fetch billing config': { config: CONFIG }, 'Find invoice by reference': { rows: [INVOICE] }, 'Find payments for reference': { rows: [] } };
  const [out] = jsonOf(await runCode(paymentsWf, 'Decide payment match', { input: { rows: [] }, nodes }));
  assert.deepEqual([out.match.match, out.req.body.row.counted, out.invoice.id, out.attempt], ['exact', true, 'invoice_0005', 1]);
  assert.deepEqual([out.req.body.guard, out.guard_tag], [{ table: 'invoices', id: 'invoice_0005', column: 'money_seq', expect: 0 }, 'seq0']);
  const store = paymentsWf.nodes.find(n => n.name === 'Store payment row');
  assert.equal(store.parameters.headerParameters.parameters.find(p => p.name === 'Idempotency-Key').value, '={{ $json.idem_base }}:{{ $json.guard_tag }}:Store payment row');
  assert.match(store.parameters.url, /\/v1\/rows\/payments\/guarded$/);
  // After a conflict the node runs again on fresh rows; the fifth conflict in a row stops the run.
  const [second] = jsonOf(await runCode(paymentsWf, 'Decide payment match', { input: { rows: [] }, nodes: { ...nodes, 'Find invoice by reference': { rows: [{ ...INVOICE, money_seq: 1 }] }, 'Find payments for reference': { rows: [pay('payment_0001', 10000, { processor_payment_id: 'pay_other' })] } }, runIndex: 1 }));
  assert.deepEqual([second.attempt, second.match.match, second.guard_tag], [2, 'already_paid', 'seq1']);
  await assert.rejects(runCode(paymentsWf, 'Decide payment match', { input: { rows: [] }, nodes, runIndex: 5 }), /changed under this run 5 times in a row/);
  const [dup] = jsonOf(await runCode(paymentsWf, 'Decide payment match', { input: { rows: [] }, nodes: { ...nodes, 'Find payments for reference': { rows: [pay('payment_0001', 10000, { processor_payment_id: 'pay_9' })] } } }));
  assert.deepEqual([dup.match.route, dup.outcome, dup.req], ['duplicate', 'duplicate_payment', undefined]);
});

test('glue: Decide change routes replays without writing and guards the void; the sixth pass stops', async () => {
  const claim = (type, data) => ({ event_id: 'evt_c', type, idem_base: 'billing-event:evt_c', data: { invoice_number: INVOICE.number, ...data } });
  const nodes = (invoice, payments = []) => ({ 'Read claim result': claim('invoice.void_requested', {}), 'Find invoice to change': { rows: [invoice] }, 'Find invoice payments': { rows: payments } });
  const [voided] = jsonOf(await runCode(issueWf, 'Decide change', { input: { rows: [] }, nodes: nodes({ ...INVOICE, money_seq: 2 }) }));
  assert.deepEqual([voided.route, voided.guard_tag, voided.req.body.guard], ['void', 'seq2', { column: 'money_seq', expect: 2 }]);
  const [replay] = jsonOf(await runCode(issueWf, 'Decide change', { input: { rows: [] }, nodes: nodes({ ...INVOICE, status: 'void', void_event_id: 'evt_c' }) }));
  assert.deepEqual([replay.route, replay.outcome, replay.answer.changed, replay.req.body.outcome], ['void_replay', 'voided', false, 'voided']);
  await assert.rejects(runCode(issueWf, 'Decide change', { input: { rows: [] }, nodes: nodes(INVOICE), runIndex: 5 }), /Decide change for CRIT-2026-0001: the invoice changed under this run 5 times/);
  const mark = issueWf.nodes.find(n => n.name === 'Mark invoice void');
  assert.equal(mark.parameters.headerParameters.parameters.find(p => p.name === 'Idempotency-Key').value, '={{ $json.idem_base }}:{{ $json.guard_tag }}:Mark invoice void');
  // A conflict loops back to the first read, and the processor is reached only from a stored refund row (or a resume).
  const targets = (from, output) => issueWf.connections[from].main[output].map(link => link.node);
  assert.deepEqual([targets('Route on void write', 1), targets('Route on refund write', 1), targets('Route on refund write', 0)], [['Find invoice to change'], ['Find invoice to change'], ['Prepare processor refund']]);
  assert.deepEqual(targets('Route change decision', 3), ['Prepare processor refund']);
  assert.deepEqual(paymentsWf.connections['Route on payment write'].main.map(links => links.map(link => link.node)), [['Read payment row'], ['Find invoice by reference']]);
});

test('glue: Check dead letter stored fails the run (after the 400) when the dead letter was not stored', async () => {
  const shape = { event_id: 'evt_bad', errors: ['data.client_id is required', 'x'], req: { body: { row: { payload_sha256: 'f'.repeat(64) } } } };
  for (const workflow of [issueWf, paymentsWf]) {
    const [ok] = jsonOf(await runCode(workflow, 'Check dead letter stored', { input: { row: { id: 'dead_letter_0001', payload_sha256: 'f'.repeat(64) } }, nodes: { 'Validate event shape': shape } }));
    assert.equal(ok.dead_letter_id, 'dead_letter_0001');
    await assert.rejects(runCode(workflow, 'Check dead letter stored', { input: { error: { message: 'The service was not able to process your request' } }, nodes: { 'Validate event shape': shape } }), new RegExp(`^Error: Dead letter not stored \\(${workflow === issueWf ? 'issue-invoices' : 'match-payments'}, source .*\\): payload sha256 f{64}, event id evt_bad, 2 reason\\(s\\)\\. The sender was answered 400`));
    assert.deepEqual(workflow.connections['Respond 400 invalid'].main[0].map(link => link.node), ['Check dead letter stored']);
  }
});

test('glue: a late replay does not resend the invoice email or the receipt', async () => {
  const ctx = { event_id: 'evt_x', config: CONFIG, client: clientRows[0] };
  const invoice = { ...INVOICE, status: 'issued', pdf_sha256: 'a'.repeat(64), pdf_key: 'k', line_items: [], tax_lines: [], subtotal_minor: 10000, po_number: null };
  const step = inv => runCode(issueWf, 'Check delivery progress', { nodes: { 'Read stored invoice': { ...ctx, invoice: inv } } });
  assert.equal(jsonOf(await step({ ...invoice, email_started_at: new Date(Date.now() - 2 * HOUR).toISOString() }))[0].step_route, 'email');
  await assert.rejects(step({ ...invoice, email_started_at: new Date(Date.now() - 30 * HOUR).toISOString() }), /Invoice CRIT-2026-0001 \(invoice_0005\): an email send started at .* not resent/);
  const receipt = created => runCode(paymentsWf, 'Prepare receipt email', { input: { rows: [clientRows[0]] }, nodes: { 'Read payment row': { event_id: 'evt_p', config: CONFIG, invoice: INVOICE, payment: { id: 'payment_0002', event_id: 'evt_p', reference: INVOICE.number, amount_minor: 10000, currency: 'PHP', received_at: '2026-11-18T02:00:00Z', created_at: created } } }, env: { EMAIL_FROM: 'b@critdept.com' } });
  assert.equal(jsonOf(await receipt(new Date().toISOString()))[0].req.body.subject, 'Payment received for CRIT-2026-0001: PHP 100.00');
  await assert.rejects(receipt(new Date(Date.now() - 30 * HOUR).toISOString()), /Payment payment_0002 .* not resent/);
  const send = issueWf.nodes.find(n => n.name === 'Send invoice email');
  assert.equal(send.parameters.jsonBody, "={{ JSON.stringify($('Prepare invoice email').first().json.req.body) }}", 'the email body comes from the node that built it, after the stamp');
  assert.deepEqual(issueWf.connections['Prepare invoice email'].main[0].map(link => link.node), ['Record email start']);
});

test('glue: Pick claimed steps sends new claims, reviews taken-over ones, skips the rest', async () => {
  const settings = { config: CONFIG, as_of_date: '2026-11-19' };
  const candidate = id => ({ invoice_id: id, number: `N-${id}`, step_days: 3, days_overdue: 3, balance_minor: 100, currency: 'PHP' });
  const plans = ['invoice_a', 'invoice_b', 'invoice_c'].map(id => ({ candidate: candidate(id), idem_base: `reminder:${id}:d3` }));
  const invoices = ['invoice_a', 'invoice_b', 'invoice_c'].map(id => ({ ...INVOICE, id, number: `N-${id}` }));
  const nodes = { 'Read chase config': settings, 'Decide reminders due': { items: plans }, 'Find sent invoices': { rows: invoices }, 'Find clients': { rows: clientRows } };
  const out = await runCode(chaseWf, 'Pick claimed steps', { input: { items: [{ outcome: 'claimed' }, { outcome: 'claimed', reclaimed: 'after_failure' }, { outcome: 'done' }] }, nodes, env: { EMAIL_FROM: 'b@critdept.com' } });
  assert.deepEqual(out.map(item => [item.json.route, item.json.candidate.invoice_id, item.pairedItem]), [['send', 'invoice_a', 0], ['review', 'invoice_b', 1]]);
  assert.equal(out[0].json.req.body.subject, 'Reminder: invoice N-invoice_a is 3 days overdue');
  assert.equal(out[1].json.req.body.row.kind, 'reminder_state_unknown');
  const none = jsonOf(await runCode(chaseWf, 'Pick claimed steps', { input: { items: [{ outcome: 'in_flight' }, { outcome: 'done' }, { outcome: 'done' }] }, nodes }));
  assert.deepEqual(none, [{ route: 'none', result: 'no_new_claims' }]);
  await assert.rejects(runCode(chaseWf, 'Pick claimed steps', { input: { items: [{ outcome: 'maybe' }] }, nodes }), /answered a claim/);
});

test('glue: Read chase config fixes the clock only when the override is allowed', async () => {
  const run = env => runCode(chaseWf, 'Read chase config', { input: { config: CONFIG }, nodes: { 'Respond 202 accepted': { kind: 'reminders', source: 'request', event_id: 's1', requested_as_of: '2026-11-18T16:30:00Z' } }, env }).then(jsonOf).then(items => items[0]);
  const fixed = await run({ INVOICE_CLOCK_OVERRIDE: 'allow' });
  assert.deepEqual([fixed.as_of_date, fixed.clock_overridden], ['2026-11-19', true]);
  const real = await run({});
  assert.equal(real.clock_overridden, false);
  assert.equal(real.as_of_date, L.localDate(Date.now(), 'Asia/Manila'));
  const off = await runCode(chaseWf, 'Prepare reminder sweep', { input: {}, env: { INVOICE_SCHEDULES: 'off' } });
  assert.deepEqual(off, [], 'the scheduled run stops at once when schedules are off');
});

// ------------------------------------------------------------------ generated files

test('workflows: committed JSON and layout are fresh; house style holds; ids, names and wiring as specified', () => {
  execFileSync(process.execPath, [join(root, 'workflow/build.mjs'), '--check'], { stdio: 'pipe' });
  const ids = [];
  for (const [workflow, entry] of [[issueWf, MANIFEST.workflows[0]], [paymentsWf, MANIFEST.workflows[1]], [chaseWf, MANIFEST.workflows[2]]]) {
    assert.deepEqual(lintWorkflow(workflow, { readOnlyPostNodes: entry.readOnlyPostNodes }), [], workflow.name);
    assert.equal(workflow.settings.timezone, CONFIG.timezone, 'workflow and business time zone agree');
    assert.equal(workflow.settings.errorWorkflow, 'critAlertErrors1');
    assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
    ids.push(workflow.id);
    for (const node of workflow.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest')) {
      const headers = Object.fromEntries((node.parameters.headerParameters?.parameters ?? []).map(h => [h.name, h.value]));
      if (node.parameters.method === 'GET' || node.parameters.method === undefined) assert.equal(headers['Idempotency-Key'], undefined, `${node.name} is a read`);
      if (/^(Store|Send|Record|Mark invoice|Post)/.test(node.name) && !/^Mark (event|reminder|reports)/.test(node.name)) assert.ok(headers['Idempotency-Key']?.endsWith(`:${node.name}`), `${node.name} is keyed`);
    }
  }
  assert.deepEqual(ids, ['critInvoiceIssue', 'critPaymentMatch', 'critInvoiceChase']);
  assert.equal(issueWf.nodes.find(n => n.name === 'Receive billing event').parameters.options.rawBody, true);
  assert.equal(issueWf.nodes.find(n => n.name === 'Store invoice PDF').parameters.contentType, 'binaryData');
  assert.deepEqual(chaseWf.nodes.filter(n => n.type === 'n8n-nodes-base.scheduleTrigger').map(n => n.parameters.rule.interval[0]), [{ field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 }, { field: 'hours', hoursInterval: 1, triggerAtMinute: 20 }]);
});

test('workflows: every $env variable used is in the manifest allowlist or the kit', () => {
  const used = new Set();
  for (const workflow of [issueWf, paymentsWf, chaseWf]) for (const match of JSON.stringify(workflow).matchAll(/\$env\.([A-Z0-9_]+)/g)) used.add(match[1]);
  const allowed = new Set([...MANIFEST.env, ...KIT_WORKFLOW_VARIABLES, 'N8N_EDITOR_BASE_URL']);
  assert.deepEqual([...used].filter(name => !allowed.has(name)), []);
  assert.deepEqual(MANIFEST.env.filter(name => !used.has(name)), [], 'no unused variables in the allowlist');
});

test('layout.json: every node with a section, position and note; every connection', () => {
  const layout = buildAll()['layout.json'];
  for (const [entry, workflow] of layout.workflows.map((entry, i) => [entry, [issueWf, paymentsWf, chaseWf][i]])) {
    const real = workflow.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote');
    assert.equal(entry.nodes.length, real.length);
    assert.ok(entry.nodes.every(node => node.section && node.note && node.position.length === 2), `${entry.name}: every node sits in a section`);
    const linkCount = Object.values(workflow.connections).flatMap(c => c.main).flat().length;
    assert.equal(entry.connections.length, linkCount);
    assert.ok(entry.sections.every(s => /^\d+\. /.test(s.name)));
  }
  const errorLinks = layout.workflows.flatMap(w => w.connections.filter(c => c.kind === 'error').map(c => `${c.from} -> ${c.to}`));
  assert.ok(errorLinks.includes('Store dead letter -> Respond 400 invalid') && errorLinks.includes('Post review alert -> Check review alert'));
});

test('fixtures: invented clients on reserved .example addresses, labelled synthetic', () => {
  const file = JSON.parse(readFileSync(join(root, 'fixtures/clients.json'), 'utf8'));
  assert.equal(file.synthetic, true);
  assert.ok(file.clients.every(client => client.email.endsWith('.example') && client.client_id.startsWith('client_test_')));
});
