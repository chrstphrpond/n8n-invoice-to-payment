// End-to-end run of the invoicing workflow set on a real n8n 2.42.6 server.
//   node invoice-to-payment/tests/e2e.mjs                 every scenario
//   node invoice-to-payment/tests/e2e.mjs --only a,b      just these (writes results/e2e-summary.partial.json)
// The kit harness takes the machine-wide e2e lock, starts n8n in a fresh temp folder on free ports with an
// allowlisted environment, imports and publishes the error workflow and the three invoicing workflows, and runs
// the stand-ins (data service, PDF renderer, object storage, Resend-shaped email, payment processor, Slack) in this
// process. Each scenario posts signed events to the production webhooks and asserts on the HTTP answer, the calls
// made in order, the rows, ledger entries, stored objects, emails and alerts. Nothing leaves 127.0.0.1.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALERTS_CHANNEL, createHarness, N8N_VERSION } from '../../_shared/lib/harness.mjs';
import { LOCK_DIR } from '../../_shared/lib/lock.mjs';
import { lib } from '../workflow/flows/common.mjs';
import { PATH as BILLING_PATH } from '../workflow/flows/issue.mjs';
import { PATH as PAYMENT_PATH } from '../workflow/flows/payments.mjs';
import { PATH as SWEEP_PATH } from '../workflow/flows/chase.mjs';
import { BUCKET, CLIENTS, invoiceModules } from '../standins/index.mjs';
import { minimalPdf } from '../standins/vendors.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const onlyArg = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const only = onlyArg ? new Set(onlyArg.split(',')) : null;
const L = lib.load();
const EMAIL_TIMEOUT_MS = 1500;
const REVIEW_CHANNEL = '#crit-billing';

const h = createHarness({
  workflowDir: root,
  timezone: 'Asia/Manila',
  label: 'invoice-to-payment e2e',
  modules: ({ secrets }) => {
    for (const name of ['billing', 'paymentsHook', 'pdf', 'storage', 'email', 'payments']) secrets[name] = secrets.random(name.toLowerCase());
    return invoiceModules({ secrets });
  },
  env: ({ url, secrets }) => ({
    BILLING_WEBHOOK_SECRET: secrets.billing, PAYMENTS_WEBHOOK_SECRET: secrets.paymentsHook,
    PDF_BASE_URL: `${url}/pdf`, PDF_API_TOKEN: secrets.pdf,
    STORAGE_BASE_URL: `${url}/storage`, STORAGE_TOKEN: secrets.storage, STORAGE_BUCKET: BUCKET,
    EMAIL_BASE_URL: `${url}/email`, EMAIL_API_KEY: secrets.email, EMAIL_FROM: 'CRIT Billing <billing@critdept.com>', EMAIL_TIMEOUT_MS,
    PAYMENTS_BASE_URL: `${url}/payments`, PAYMENTS_API_KEY: secrets.payments,
    REVIEW_SLACK_CHANNEL: REVIEW_CHANNEL, INVOICE_CLOCK_OVERRIDE: 'allow', INVOICE_SCHEDULES: 'off',
  }),
});

// ---------------------------------------------------------------- test data (test-range ids)
let seq = 100;
const nextId = prefix => `${prefix}_test_${seq++}`;
const nowIso = () => new Date().toISOString();
const line = (description, quantity, unit, taxCode) => ({ description, quantity, unit_price_minor: unit, tax_code: taxCode });
const STUDIO_LINES = [line('Brand identity system', 1, 8500000, 'VAT12'), line('Motion design, 30 s spot', 2.5, 1200000, 'VAT12'), line('Hosting pass-through', '1', 125050, 'ZERO')];
const invoiceRequest = (data = {}) => ({ id: nextId('evt_req'), type: 'invoice.requested', created_at: nowIso(), data: { client_id: 'client_test_harbor', currency: 'PHP', issue_date: '2026-11-02', due_date: '2026-11-16', po_number: 'PO-7781', line_items: STUDIO_LINES, ...data } });
const paymentEvent = (reference, amount, extra = {}) => ({ id: nextId('evt_pay'), type: 'payment.received', created_at: nowIso(), data: { payment_id: nextId('pay'), reference, amount_minor: amount, currency: 'PHP', received_at: '2026-11-18T02:15:00Z', ...extra } });
const changeEvent = (type, data) => ({ id: nextId('evt_chg'), type, created_at: nowIso(), data });
const sweep = (kind, asOf) => ({ id: nextId('sweep'), type: `sweep.${kind}`, created_at: nowIso(), data: asOf ? { as_of: asOf } : {} });
const CLIENT_SECRETS = [...CLIENTS.flatMap(c => [c.email, c.name]), ...STUDIO_LINES.map(l => l.description)];

const signed = (secret, body, { ts = Math.floor(Date.now() / 1000), raw = JSON.stringify(body) } = {}) => ({ raw, headers: { 'x-crit-signature': L.signatureHeader(secret, ts, raw) } });
const postSigned = (path, secret, body, options = {}) => { const { raw, headers } = signed(secret, body, options); return h.post(path, null, options.headers ?? headers, { raw: options.sendRaw ?? raw }); };
const sendBilling = (event, options) => postSigned(BILLING_PATH, h.secrets.billing, event, options);
const sendPayment = (event, options) => postSigned(PAYMENT_PATH, h.secrets.paymentsHook, event, options);
const sendSweep = (event, options) => postSigned(SWEEP_PATH, h.secrets.billing, event, options);

const data = () => h.standin.moduleState('data');
const ledger = (scope, key) => data().ledger.get(`${scope}:${key}`);
const rows = table => h.standin.state().data.tables[table];
const emails = () => h.standin.state().email.sent;
const slack = channel => h.standin.state().slack.messages.filter(m => !channel || m.channel === channel);
const objects = () => h.standin.state().storage.objects;
const log = () => h.standin.log();
const ops = (fromSeq = 0) => log().filter(e => e.seq >= fromSeq).map(e => e.op);
const seqNow = () => log().length;
const count = op => log().filter(e => e.op === op).length;
const HOUR = 3600 * 1000;
const hoursAgo = hours => new Date(Date.now() - hours * HOUR).toISOString();
const sha256 = data => createHash('sha256').update(data).digest('hex');
// The first data.insert/update on a guarded table after both runs read: both delayed reads were answered from the
// state before either write, so the two decisions really were made against the same "before".
function assertBothReadBeforeWrite(writeOp) {
  const delayed = log().filter(e => e.op === 'data.find.refunds' && /^delayed_/.test(e.fault ?? ''));
  const firstWrite = log().find(e => e.op === writeOp);
  assert.equal(delayed.length, 2, 'both runs read the refunds while the reads were slowed');
  assert.ok(delayed.every(e => e.seq < firstWrite.seq), 'both runs read before either wrote');
  return log().filter(e => e.outcome === 'guard_conflict').length;
}
// A ledger entry left by a run that died after the claim (the error workflow marked it failed).
function seedFailedClaim(scope, key) {
  data().ledger.set(`${scope}:${key}`, { scope, key, state: 'failed', run_id: '1', attempts: 1, payload: null, claimed_at: hoursAgo(30), claimed_ms: Date.now() - 30 * HOUR, outcome: null, result: null, error: 'run died', failed_at: hoursAgo(30) });
}

async function done(scope, key, states = ['done']) {
  await h.waitFor(() => states.includes(ledger(scope, key)?.state), { what: `${scope}:${key} to be ${states.join(' or ')}`, timeoutMs: 120000 });
  await h.settle(600);
}
// A sweep has no event ledger: wait for its last expected call, then for quiet.
async function swept(lastOp, times) {
  await h.waitFor(() => count(lastOp) >= times, { what: `${times} x ${lastOp}`, timeoutMs: 60000 });
  await h.settle(900);
}

// Rows seeded straight into the data service for payment, change and sweep scenarios.
function seedInvoice({ number, total, currency = 'PHP', status = 'sent', due = '2026-11-16', client = 'client_test_harbor', createdAt = '2026-11-02T01:00:00.000Z', extra = {} }) {
  h.standin.control({ data: { rows: { invoices: [{ request_event_id: nextId('evt_seed'), number, sequence: 'invoice-2026', sequence_value: Number(number.slice(-4)), client_id: client, currency, issue_date: '2026-11-02', due_date: due, po_number: null, line_items: [], tax_lines: [], subtotal_minor: total, tax_minor: 0, total_minor: total, status, money_seq: 0, created_at: createdAt, ...extra }] } } });
  return rows('invoices').at(-1);
}
function seedPayment(invoice, amount, extra = {}) {
  h.standin.control({ data: { rows: { payments: [{ event_id: nextId('evt_seedpay'), processor_payment_id: nextId('pay_seed'), reference: invoice.number, invoice_id: invoice.id, invoice_number: invoice.number, amount_minor: amount, currency: invoice.currency, received_at: '2026-11-10T02:00:00Z', match: 'exact', counted: true, excess_minor: 0, paid_after_minor: amount, ...extra }] } } });
}

const CREATE_OPS = ['data.ledger_claim', 'data.get_config', 'data.find.clients', 'data.find.invoices', 'data.sequence_next', 'data.insert.invoices', 'pdf.render', 'storage.put_object', 'data.update.invoices', 'storage.get_object', 'data.update.invoices', 'email.send', 'data.update.invoices', 'data.ledger_complete'];
const PAYMENT_OPS = ['data.ledger_claim', 'data.get_config', 'data.find.invoices', 'data.find.payments', 'data.find.refunds', 'data.insert.payments'];
const RECEIPT_OPS = ['data.find.clients', 'email.send', 'data.update.invoices'];
const REVIEW_OPS = ['data.insert.review_items', 'slack.post_message'];
const REMINDER_READS = ['data.get_config', 'data.find.invoices', 'data.find.payments', 'data.find.refunds', 'data.find.reminders', 'data.find.clients'];

function assertDelivered(invoice, note) {
  const [object] = objects();
  const mail = emails().find(m => m.id === invoice.email_id);
  assert.equal(invoice.status, 'sent');
  assert.equal(object.path, `${BUCKET}/invoices/2026/${invoice.number}.pdf`);
  assert.equal(invoice.pdf_sha256, object.sha256, 'the invoice records the stored object');
  assert.equal(mail.attachments[0].sha256, object.sha256, 'the email attaches the stored object');
  assert.equal(mail.attachments[0].is_pdf, true);
  if (note) note.pdf = { key: object.path, bytes: object.size, sha256: object.sha256.slice(0, 16) };
}

// ---------------------------------------------------------------- scenarios
const scenarios = [
  {
    id: 'happy_create_deliver', description: 'A signed invoice.requested is numbered CRIT-2026-0001, totalled in minor units, rendered, stored and emailed with the PDF; every step recorded.',
    async run(note) {
      const event = invoiceRequest();
      const started = Date.now();
      const res = await sendBilling(event);
      note.answer_ms = Date.now() - started;
      assert.deepEqual([res.status, res.json], [202, { status: 'accepted', event_id: event.id }]);
      await done('billing_event', event.id);
      assert.deepEqual(ops(), CREATE_OPS);
      const [invoice] = rows('invoices');
      assert.deepEqual([invoice.number, invoice.subtotal_minor, invoice.tax_minor, invoice.total_minor, invoice.currency, invoice.due_date], ['CRIT-2026-0001', 11625050, 1380000, 13005050, 'PHP', '2026-11-16']);
      assert.deepEqual(invoice.tax_lines.map(t => [t.tax_code, t.net_minor, t.tax_minor]), [['VAT12', 11500000, 1380000], ['ZERO', 125050, 0]]);
      assertDelivered(invoice, note);
      assert.deepEqual(invoice.history.map(entry => entry.set), [['pdf_key', 'pdf_sha256', 'pdf_bytes'], ['email_started_at'], ['status', 'email_id']], 'each step recorded on the invoice, the email start before the send');
      assert.ok(Date.parse(invoice.email_started_at) <= log().find(e => e.op === 'email.send').at_ms, 'stamped before the send');
      const [mail] = emails();
      assert.deepEqual([emails().length, mail.to, mail.subject, mail.from], [1, ['accounts@harbor-pine.example'], 'Invoice CRIT-2026-0001 from CRIT: PHP 130,050.50 due 16 Nov 2026', 'CRIT Billing <billing@critdept.com>']);
      assert.match(mail.text, /Invoice CRIT-2026-0001 for PHP 130,050\.50 is attached\. It is due on 16 Nov 2026\./);
      const [render] = h.standin.state().pdf.renders;
      for (const text of ['CRIT-2026-0001', 'Harbor &amp; Pine Coffee', 'PHP 130,050.50', 'VAT 12% on PHP 115,000.00']) assert.ok(render.html.includes(text), `the template shows ${text}`);
      const entry = ledger('billing_event', event.id);
      assert.deepEqual([entry.outcome, entry.result.number, entry.result.email_id], ['delivered', 'CRIT-2026-0001', mail.id]);
      assert.equal(rows('invoice_numbers').length, 1);
      note.email_subject = mail.subject;
      note.invoice = { number: invoice.number, total_minor: invoice.total_minor, tax_minor: invoice.tax_minor };
    },
  },
  {
    id: 'gap_free_numbers', description: 'Good, refused (unknown client, 422), good: the refusal takes no number, so the two invoices are 0001 and 0002; a yen invoice is totalled with zero decimals.',
    async run(note) {
      const first = invoiceRequest();
      await sendBilling(first);
      await done('billing_event', first.id);
      const refused = invoiceRequest({ client_id: 'client_test_nobody' });
      const answer = await sendBilling(refused);
      await done('billing_event', refused.id);
      assert.equal(answer.status, 422);
      assert.deepEqual([answer.json.status, answer.json.reasons.map(r => r.code)], ['rejected', ['unknown_client']]);
      const yen = invoiceRequest({ client_id: 'client_test_kiso', currency: 'JPY', po_number: null, line_items: [line('Menu photography, half day', 1, 45000, 'JCT10'), line('Retouching', 7, 1005, 'JCT10')] });
      await sendBilling(yen);
      await done('billing_event', yen.id);
      assert.deepEqual(rows('invoices').map(i => [i.number, i.currency, i.total_minor]), [['CRIT-2026-0001', 'PHP', 13005050], ['CRIT-2026-0002', 'JPY', 57239]]);
      assert.deepEqual(rows('invoice_numbers').map(r => r.value), [1, 2]);
      assert.equal(ledger('billing_event', refused.id).outcome, 'rejected');
      assert.equal(emails()[1].subject, 'Invoice CRIT-2026-0002 from CRIT: JPY 57,239 due 16 Nov 2026');
      note.refusal = answer.json;
    },
  },
  {
    id: 'redelivered_event', description: 'The same invoice.requested delivered again after it was handled: 200 duplicate after one ledger call; one number, one PDF, one email.',
    async run(note) {
      const event = invoiceRequest();
      await sendBilling(event);
      await done('billing_event', event.id);
      const from = seqNow();
      const again = await sendBilling(event);
      await h.settle(800);
      assert.deepEqual([again.status, again.json], [200, { status: 'duplicate', event_id: event.id, outcome: 'delivered' }]);
      assert.deepEqual(ops(from), ['data.ledger_claim']);
      assert.deepEqual([rows('invoices').length, objects().length, emails().length, count('pdf.render')], [1, 1, 1, 1]);
      note.second_answer = again.json;
    },
  },
  {
    id: 'redelivery_while_in_flight', description: 'Redelivered while the first run waits on a slow renderer: 409 with Retry-After, then 200 duplicate once done.',
    faults: [{ op: 'pdf.render', delay_ms: 2500, times: 1 }],
    async run(note) {
      const event = invoiceRequest();
      assert.equal((await sendBilling(event)).status, 202);
      await h.waitFor(() => count('pdf.render') > 0, { what: 'the render to start' });
      const second = await sendBilling(event);
      assert.deepEqual([second.status, second.headers['retry-after'], second.json.status], [409, '30', 'in_flight']);
      await done('billing_event', event.id);
      const third = await sendBilling(event);
      assert.deepEqual([third.status, third.json.status], [200, 'duplicate']);
      assert.deepEqual(log().filter(e => e.op === 'data.ledger_claim').map(e => e.outcome), ['claimed', 'in_flight', 'done']);
      assert.deepEqual([rows('invoices').length, emails().length, count('data.sequence_next')], [1, 1, 1]);
      note.answers = [202, second.status, third.status];
    },
  },
  {
    id: 'bad_signature', description: 'Wrong secret, no header, a body changed after signing, and the billing secret on the payment endpoint: 401 each, no call of any kind.',
    async run(note) {
      const event = invoiceRequest();
      const wrong = await postSigned(BILLING_PATH, 'not-the-billing-secret-at-all', event);
      const missing = await h.post(BILLING_PATH, event, {});
      const { headers } = signed(h.secrets.billing, event);
      const tampered = await h.post(BILLING_PATH, null, headers, { raw: JSON.stringify({ ...event, data: { ...event.data, due_date: '2027-12-31' } }) });
      const crossed = await postSigned(PAYMENT_PATH, h.secrets.billing, paymentEvent('CRIT-2026-0001', 100));
      await h.settle(800);
      assert.deepEqual([wrong, missing, tampered, crossed].map(r => [r.status, r.json.error]), [[401, 'bad_signature'], [401, 'missing_signature'], [401, 'bad_signature'], [401, 'bad_signature']]);
      assert.deepEqual(ops(), []);
      note.answers = [wrong.json, missing.json, tampered.json, crossed.json];
    },
  },
  {
    id: 'stale_timestamp', description: 'A correctly signed request 10 minutes old (a replay) or 10 minutes in the future: 401 stale_timestamp, no call.',
    async run(note) {
      const event = invoiceRequest();
      const now = Math.floor(Date.now() / 1000);
      const old = await sendBilling(event, { ts: now - 600 });
      const future = await sendPayment(paymentEvent('CRIT-2026-0001', 100), { ts: now + 600 });
      await h.settle(800);
      assert.deepEqual([old.status, old.json.error, future.status, future.json.error], [401, 'stale_timestamp', 401, 'stale_timestamp']);
      assert.deepEqual(ops(), []);
      note.answers = [old.json, future.json];
    },
  },
  {
    id: 'invalid_payload', description: 'Signed but broken (decimal price, missing client), sent twice: 400 with the reasons, one dead letter. A body that is not JSON is refused by n8n itself (422) before the workflow runs. Another event type: 200 ignored.',
    async run(note) {
      const broken = invoiceRequest({ client_id: undefined, line_items: [line('Retainer', 1, 15000.5, 'VAT12')] });
      const first = await sendBilling(broken);
      const second = await sendBilling(broken);
      const notJson = await h.post(BILLING_PATH, null, signed(h.secrets.billing, null, { raw: '{"id": "evt_test_cut", "type": ' }).headers, { raw: '{"id": "evt_test_cut", "type": ' });
      const ignored = await sendBilling({ ...invoiceRequest(), type: 'invoice.viewed' });
      await h.settle(800);
      assert.equal(first.status, 400);
      assert.deepEqual(first.json.errors, ['data.client_id is required', 'data.line_items[0].unit_price_minor must be a whole number of minor units (no decimals)']);
      assert.equal(second.json.dead_letter_id, first.json.dead_letter_id);
      // n8n's webhook parses application/json bodies itself and answers 422 when that fails; the workflow never runs.
      assert.equal(notJson.status, 422);
      note.not_json_answer = { status: notJson.status, code: notJson.json?.code, message: notJson.json?.message, hint: notJson.json?.hint };
      assert.deepEqual([ignored.status, ignored.json.status], [200, 'ignored']);
      assert.deepEqual(ops(), ['data.insert.dead_letters', 'data.insert.dead_letters']);
      assert.equal(log()[1].idempotent_replay, true);
      const letters = rows('dead_letters');
      assert.equal(letters.length, 1);
      assert.deepEqual([letters[0].workflow, letters[0].source, letters[0].payload.id], ['issue-invoices', 'billing-webhook', broken.id]);
      note.answer = first.json;
    },
  },
  {
    id: 'pdf_5xx_retry', description: 'The renderer answers 503 twice; the third try works 5 s apart and the invoice is delivered once.',
    faults: [{ op: 'pdf.render', status: 503, times: 2, body: { error: 'renderer busy' } }],
    async run(note) {
      const event = invoiceRequest();
      const started = Date.now();
      await sendBilling(event);
      await done('billing_event', event.id);
      const calls = log().filter(e => e.op === 'pdf.render');
      assert.deepEqual(calls.map(e => e.status), [503, 503, 200]);
      assert.ok(calls[2].at_ms - calls[0].at_ms >= 9500, 'two 5 s waits between tries');
      assertDelivered(rows('invoices')[0]);
      assert.deepEqual([objects().length, emails().length], [1, 1]);
      note.render_statuses = calls.map(e => e.status);
      note.seconds = Math.round((Date.now() - started) / 100) / 10;
    },
  },
  {
    id: 'email_timeout_after_send', description: `The email API takes the send but answers after 4 s (timeout ${EMAIL_TIMEOUT_MS} ms): the retry carries the same Idempotency-Key, gets the first answer, and one email exists.`,
    faults: [{ op: 'email.send', delay_ms: 4000, times: 1 }],
    async run(note) {
      const event = invoiceRequest();
      await sendBilling(event);
      await done('billing_event', event.id);
      const calls = log().filter(e => e.op === 'email.send');
      assert.equal(calls.length, 2);
      assert.equal(calls[0].idempotency_key, calls[1].idempotency_key);
      assert.equal(calls[0].idempotency_key, `billing-event:${event.id}:Send invoice email`);
      assert.equal(calls[1].idempotent_replay, true);
      assert.equal(emails().length, 1, 'one email was sent');
      assert.equal(rows('invoices')[0].email_id, emails()[0].id);
      note.email_calls = calls.map(e => `${e.status}${e.fault ? ` ${e.fault}` : ''}${e.idempotent_replay ? ' replayed' : ''}`);
    },
  },
  {
    id: 'storage_failure_error_workflow', description: 'Object storage fails all 4 tries: the run stops, the error workflow releases the claim and alerts #crit-alerts; the redelivery reuses the same number and delivers once.',
    faults: [{ op: 'storage.put_object', status: 500, times: 4, body: { error: 'InternalError' } }],
    async run(note) {
      const event = invoiceRequest();
      assert.equal((await sendBilling(event)).status, 202);
      await h.waitFor(() => slack(ALERTS_CHANNEL).length > 0 && ledger('billing_event', event.id)?.state === 'failed', { what: 'the alert and the released claim', timeoutMs: 120000 });
      await h.settle(800);
      const [alert] = slack(ALERTS_CHANNEL);
      assert.equal(slack(ALERTS_CHANNEL).length, 1);
      assert.match(alert.text, /^Workflow failed: CRIT · Issue invoices\nFailed node: Store invoice PDF\nError: /);
      assert.match(alert.text, /Execution: http:\/\/127\.0\.0\.1:\d+\/workflow\/critInvoiceIssue\/executions\/\d+/);
      assert.match(alert.text, new RegExp(`Released for redelivery: billing_event:${event.id}`));
      assert.equal(count('storage.put_object'), 4);
      assert.deepEqual([emails().length, rows('invoices')[0].status, rows('invoices')[0].number], [0, 'issued', 'CRIT-2026-0001']);
      note.alert = alert.text;

      const from = seqNow();
      assert.equal((await sendBilling(event)).status, 202);
      await done('billing_event', event.id);
      const replay = log().filter(e => e.seq >= from);
      assert.equal(replay[0].outcome, 'claimed_after_failure');
      assert.deepEqual(ops(from), ['data.ledger_claim', 'data.get_config', 'data.find.clients', 'data.find.invoices', 'pdf.render', 'storage.put_object', 'data.update.invoices', 'storage.get_object', 'data.update.invoices', 'email.send', 'data.update.invoices', 'data.ledger_complete']);
      assert.deepEqual([rows('invoices').length, rows('invoices')[0].number, rows('invoice_numbers').length, count('data.sequence_next')], [1, 'CRIT-2026-0001', 1, 1], 'the same number, taken once');
      assert.deepEqual([objects().length, objects()[0].writes, emails().length, count('pdf.render')], [1, 1, 1, 2]);
      assertDelivered(rows('invoices')[0]);
      assert.equal(ledger('billing_event', event.id).attempts, 2);
      note.replay_calls = ops(from);
    },
  },
  {
    id: 'payment_exact', description: 'A payment of exactly the total with the invoice number as reference: recorded as exact, one receipt, paid_at on the invoice, no review.',
    async run(note) {
      const invoice = seedInvoice({ number: 'CRIT-2026-0041', total: 1120000 });
      const event = paymentEvent(invoice.number, 1120000);
      assert.equal((await sendPayment(event)).status, 202);
      await done('payment_event', event.id);
      assert.deepEqual(ops(), [...PAYMENT_OPS, ...RECEIPT_OPS, 'data.ledger_complete']);
      const [payment] = rows('payments');
      assert.deepEqual([payment.match, payment.counted, payment.invoice_id, payment.paid_after_minor], ['exact', true, invoice.id, 1120000]);
      assert.deepEqual([emails().length, emails()[0].subject, emails()[0].to], [1, 'Payment received for CRIT-2026-0041: PHP 11,200.00', ['accounts@harbor-pine.example']]);
      const stored = rows('invoices')[0];
      assert.deepEqual([stored.receipt_email_id, stored.paid_at], [emails()[0].id, '2026-11-18T02:15:00Z']);
      assert.deepEqual([rows('review_items').length, slack().length], [0, 0]);
      note.receipt = emails()[0].subject;
    },
  },
  {
    id: 'payment_partial_then_rest', description: 'PHP 4,000 then PHP 7,200 on an PHP 11,200 invoice: partial (no receipt), then completes (one receipt).',
    async run(note) {
      const invoice = seedInvoice({ number: 'CRIT-2026-0042', total: 1120000 });
      const part = paymentEvent(invoice.number, 400000);
      await sendPayment(part);
      await done('payment_event', part.id);
      assert.deepEqual([rows('payments')[0].match, emails().length], ['partial', 0]);
      assert.deepEqual(ops(), [...PAYMENT_OPS, 'data.ledger_complete']);
      const rest = paymentEvent(invoice.number, 720000);
      await sendPayment(rest);
      await done('payment_event', rest.id);
      assert.deepEqual(rows('payments').map(p => [p.match, p.paid_after_minor]), [['partial', 400000], ['completes', 1120000]]);
      assert.equal(emails().length, 1);
      assert.match(emails()[0].text, /We received PHP 7,200\.00 on 18 Nov 2026 with reference CRIT-2026-0042\. Invoice CRIT-2026-0042 \(PHP 11,200\.00\) is paid in full\./);
      note.matches = rows('payments').map(p => p.match);
    },
  },
  {
    id: 'payment_over', description: 'PHP 11,500 on a PHP 11,200 invoice: paid in full (receipt), and the PHP 300 excess goes to the review queue and #crit-billing.',
    async run(note) {
      const invoice = seedInvoice({ number: 'CRIT-2026-0043', total: 1120000 });
      const event = paymentEvent(invoice.number, 1150000);
      await sendPayment(event);
      await done('payment_event', event.id);
      assert.deepEqual(ops(), [...PAYMENT_OPS, ...RECEIPT_OPS, ...REVIEW_OPS, 'data.ledger_complete']);
      const [payment] = rows('payments');
      const [review] = rows('review_items');
      assert.deepEqual([payment.match, payment.excess_minor, emails().length], ['overpaid', 30000, 1]);
      assert.deepEqual([review.kind, review.payment_id, review.invoice_id, review.amount_minor], ['overpaid', payment.id, invoice.id, 1150000]);
      const [message] = slack(REVIEW_CHANNEL);
      assert.equal(message.text, `Billing review: paid more than the invoice total. Payment ${payment.id} (processor ${event.data.payment_id}, reference CRIT-2026-0043): PHP 11,500.00. Invoice CRIT-2026-0043 (${invoice.id}), total PHP 11,200.00. Excess PHP 300.00. Review item ${review.id}.`);
      assert.equal(slack(ALERTS_CHANNEL).length, 0);
      note.review_alert = message.text;
    },
  },
  {
    id: 'payment_wrong_currency', description: 'USD 112.00 against a PHP invoice: not counted, no receipt, review and alert.',
    async run(note) {
      const invoice = seedInvoice({ number: 'CRIT-2026-0044', total: 1120000 });
      const event = paymentEvent(invoice.number, 11200, { currency: 'USD' });
      await sendPayment(event);
      await done('payment_event', event.id);
      assert.deepEqual(ops(), [...PAYMENT_OPS, ...REVIEW_OPS, 'data.ledger_complete']);
      assert.deepEqual([rows('payments')[0].match, rows('payments')[0].counted, emails().length, rows('review_items')[0].kind], ['wrong_currency', false, 0, 'wrong_currency']);
      assert.match(slack(REVIEW_CHANNEL)[0].text, /^Billing review: paid in a different currency than the invoice\. .*: USD 112\.00\./);
      note.review_alert = slack(REVIEW_CHANNEL)[0].text;
    },
  },
  {
    id: 'payment_unknown_reference', description: 'A reference that matches no invoice: recorded unmatched, review and alert, nothing guessed.',
    async run(note) {
      seedInvoice({ number: 'CRIT-2026-0045', total: 1120000 });
      const event = paymentEvent('CRIT-2026-9999', 1120000);
      await sendPayment(event);
      await done('payment_event', event.id);
      assert.deepEqual(ops(), [...PAYMENT_OPS, ...REVIEW_OPS, 'data.ledger_complete']);
      assert.deepEqual([rows('payments')[0].match, rows('payments')[0].invoice_id, rows('review_items')[0].kind, emails().length], ['unknown_reference', null, 'unknown_reference', 0]);
      assert.match(slack(REVIEW_CHANNEL)[0].text, /the reference matches no invoice\. Payment payment_\d+ \(processor pay_test_\d+, reference CRIT-2026-9999\): PHP 11,200\.00\. Review item/);
      note.review_alert = slack(REVIEW_CHANNEL)[0].text;
    },
  },
  {
    id: 'payment_on_void_invoice', description: 'A payment on a void invoice: not counted, no receipt, review and alert.',
    async run(note) {
      const invoice = seedInvoice({ number: 'CRIT-2026-0046', total: 1120000, status: 'void' });
      const event = paymentEvent(invoice.number, 1120000);
      await sendPayment(event);
      await done('payment_event', event.id);
      assert.deepEqual([rows('payments')[0].match, rows('payments')[0].counted, rows('review_items')[0].kind, emails().length], ['invoice_void', false, 'invoice_void', 0]);
      assert.match(slack(REVIEW_CHANNEL)[0].text, /^Billing review: paid on a void invoice\./);
      note.review_alert = slack(REVIEW_CHANNEL)[0].text;
    },
  },
  {
    id: 'payment_duplicates', description: 'The same payment event twice (200 duplicate after one call), and the same processor payment under a new event id (recorded once, no second receipt).',
    async run(note) {
      const invoice = seedInvoice({ number: 'CRIT-2026-0047', total: 1120000 });
      const event = paymentEvent(invoice.number, 1120000);
      await sendPayment(event);
      await done('payment_event', event.id);
      const from = seqNow();
      const again = await sendPayment(event);
      await h.settle(800);
      assert.deepEqual([again.status, again.json.status, again.json.outcome], [200, 'duplicate', 'exact']);
      assert.deepEqual(ops(from), ['data.ledger_claim']);
      const twin = { ...paymentEvent(invoice.number, 1120000), data: { ...event.data } };
      await sendPayment(twin);
      await done('payment_event', twin.id);
      assert.equal(ledger('payment_event', twin.id).outcome, 'duplicate_payment');
      assert.deepEqual([rows('payments').length, emails().length, rows('review_items').length], [1, 1, 0]);
      note.twin_outcome = ledger('payment_event', twin.id).result;
    },
  },
  {
    id: 'refund_limits', description: 'On an invoice paid PHP 11,200: a PHP 12,000 refund is refused (422), PHP 5,000 is refunded through the processor, then PHP 7,000 is refused (only PHP 6,200 left).',
    async run(note) {
      const invoice = seedInvoice({ number: 'CRIT-2026-0048', total: 1120000 });
      seedPayment(invoice, 1120000);
      const tooLarge = changeEvent('refund.requested', { invoice_number: invoice.number, amount_minor: 1200000, currency: 'PHP', reason: 'goodwill' });
      const big = await sendBilling(tooLarge);
      await done('billing_event', tooLarge.id);
      assert.deepEqual([big.status, big.json.reason, big.json.requested_minor, big.json.refundable_minor], [422, 'refund_exceeds_paid', 1200000, 1120000]);
      const ok = changeEvent('refund.requested', { invoice_number: invoice.number, amount_minor: 500000, currency: 'PHP' });
      const from = seqNow();
      const good = await sendBilling(ok);
      await done('billing_event', ok.id);
      assert.deepEqual([good.status, good.json.status, good.json.refundable_after_minor], [200, 'refunded', 620000]);
      assert.deepEqual(ops(from), ['data.ledger_claim', 'data.find.invoices', 'data.find.payments', 'data.find.refunds', 'data.insert.refunds', 'payments.create_refund', 'data.update.refunds', 'data.ledger_complete']);
      const [refund] = rows('refunds');
      assert.deepEqual([refund.status, refund.amount_minor, refund.processor_refund_id, good.json.processor_refund_id], ['submitted', 500000, 're_test_0001', 're_test_0001']);
      const more = changeEvent('refund.requested', { invoice_number: invoice.number, amount_minor: 700000, currency: 'PHP' });
      const over = await sendBilling(more);
      await done('billing_event', more.id);
      assert.deepEqual([over.status, over.json.refundable_minor], [422, 620000]);
      assert.deepEqual([rows('refunds').length, h.standin.state().payments.refunds.length], [1, 1]);
      note.answers = [big.json, good.json, over.json];
    },
  },
  {
    id: 'invalid_transitions', description: 'Void a paid invoice (409), refund an unpaid one (409), void a sent unpaid one (200), void it again (409), void an unknown number (404).',
    async run(note) {
      const paid = seedInvoice({ number: 'CRIT-2026-0051', total: 500000 });
      seedPayment(paid, 500000);
      const unpaid = seedInvoice({ number: 'CRIT-2026-0052', total: 500000 });
      const send = async (type, data) => { const event = changeEvent(type, data); const res = await sendBilling(event); await done('billing_event', event.id); return res; };
      const voidPaid = await send('invoice.void_requested', { invoice_number: paid.number });
      const refundUnpaid = await send('refund.requested', { invoice_number: unpaid.number, amount_minor: 100, currency: 'PHP' });
      const voidOk = await send('invoice.void_requested', { invoice_number: unpaid.number, reason: 'raised in error' });
      const voidAgain = await send('invoice.void_requested', { invoice_number: unpaid.number });
      const unknown = await send('invoice.void_requested', { invoice_number: 'CRIT-2026-0999' });
      assert.deepEqual([voidPaid.status, voidPaid.json.status, voidPaid.json.from, voidPaid.json.to], [409, 'invalid_transition', 'paid', 'void']);
      assert.deepEqual([refundUnpaid.status, refundUnpaid.json.from, refundUnpaid.json.to], [409, 'unpaid', 'refunded']);
      assert.deepEqual([voidOk.status, voidOk.json.status, voidOk.json.changed], [200, 'voided', true]);
      assert.deepEqual([voidAgain.status, voidAgain.json.from], [409, 'void']);
      assert.deepEqual([unknown.status, unknown.json.status], [404, 'unknown_invoice']);
      assert.deepEqual(rows('invoices').map(i => i.status), ['sent', 'void']);
      assert.equal(rows('invoices')[1].void_reason, 'raised in error');
      assert.equal(count('data.update.invoices'), 1, 'only the valid void wrote anything');
      assert.equal(count('payments.create_refund'), 0);
      note.answers = [voidPaid, refundUnpaid, voidOk, voidAgain, unknown].map(r => [r.status, r.json.status, r.json.from ?? null]);
    },
  },
  {
    id: 'reminder_steps', description: 'An unpaid invoice due 16 Nov: the sweep on 19 Nov sends the 3-day reminder, the same day again sends nothing, 26 Nov sends the 10-day one, and again nothing.',
    async run(note) {
      const invoice = seedInvoice({ number: 'CRIT-2026-0061', total: 1120000 });
      const run = async (asOf, expectEmails) => {
        const clientsBefore = count('data.find.clients');
        const emailsBefore = emails().length;
        const res = await sendSweep(sweep('reminders', asOf));
        assert.deepEqual([res.status, res.json.kind], [202, 'reminders']);
        if (expectEmails > emailsBefore) await h.waitFor(() => emails().length >= expectEmails && count('data.ledger_complete') >= expectEmails, { what: 'the reminder' });
        await swept('data.find.clients', clientsBefore + 1);
      };
      await run('2026-11-19T01:00:00Z', 1);
      const firstRun = ops();
      assert.deepEqual(firstRun, [...REMINDER_READS, 'data.ledger_claim', 'email.send', 'data.insert.reminders', 'data.ledger_complete']);
      assert.deepEqual([emails()[0].subject, emails()[0].to], ['Reminder: invoice CRIT-2026-0061 is 3 days overdue', ['accounts@harbor-pine.example']]);
      assert.match(emails()[0].text, /PHP 11,200\.00 is still open\./);
      let from = seqNow();
      await run('2026-11-19T05:00:00Z', 1);
      assert.deepEqual(ops(from), REMINDER_READS, 'same day: nothing due, no claim, no email');
      await run('2026-11-26T01:00:00Z', 2);
      assert.equal(emails()[1].subject, 'Reminder: invoice CRIT-2026-0061 is 10 days overdue');
      from = seqNow();
      await run('2026-11-26T08:00:00Z', 2);
      assert.deepEqual(ops(from), REMINDER_READS);
      assert.deepEqual(rows('reminders').map(r => [r.invoice_id, r.step_days, r.as_of, r.days_overdue, r.email_id]), [[invoice.id, 3, '2026-11-19', 3, emails()[0].id], [invoice.id, 10, '2026-11-26', 10, emails()[1].id]]);
      assert.deepEqual([ledger('invoice_reminder', `${invoice.id}:d3`).state, ledger('invoice_reminder', `${invoice.id}:d10`).state], ['done', 'done']);
      assert.equal(emails().length, 2);
      note.subjects = emails().map(m => m.subject);
    },
  },
  {
    id: 'reminder_skips', description: 'Sweep on 30 Nov over four invoices due 16 Nov: paid, refunded and void get nothing; the partly paid one gets the 10-day reminder for its open PHP 7,200.',
    async run(note) {
      const paid = seedInvoice({ number: 'CRIT-2026-0071', total: 1120000 });
      seedPayment(paid, 1120000);
      const refunded = seedInvoice({ number: 'CRIT-2026-0072', total: 1120000 });
      seedPayment(refunded, 1120000);
      h.standin.control({ data: { rows: { refunds: [{ event_id: 'evt_seed_refund', invoice_id: refunded.id, invoice_number: refunded.number, amount_minor: 1120000, currency: 'PHP', reason: null, status: 'submitted', processor_refund_id: 're_seed' }] } } });
      seedInvoice({ number: 'CRIT-2026-0073', total: 1120000, status: 'void' });
      const partly = seedInvoice({ number: 'CRIT-2026-0074', total: 1120000, client: 'client_test_lumen', currency: 'USD' });
      seedPayment(partly, 400000);
      await sendSweep(sweep('reminders', '2026-11-30T01:00:00Z'));
      await h.waitFor(() => emails().length === 1 && count('data.ledger_complete') === 1, { what: 'one reminder' });
      await h.settle(900);
      assert.deepEqual([emails().length, emails()[0].subject, emails()[0].to], [1, 'Reminder: invoice CRIT-2026-0074 is 14 days overdue', ['billing@lumen-dental.example']]);
      assert.match(emails()[0].text, /USD 7,200\.00 is still open\./);
      assert.deepEqual(rows('reminders').map(r => [r.invoice_number, r.step_days, r.balance_minor]), [['CRIT-2026-0074', 10, 720000]]);
      assert.equal(count('data.ledger_claim'), 1, 'only the open invoice was claimed');
      note.reminder = emails()[0].subject;
    },
  },
  {
    id: 'reminder_early_exit', description: 'No delivered invoice is past due: the sweep reads the config and the invoices and stops.',
    async run(note) {
      seedInvoice({ number: 'CRIT-2026-0081', total: 1120000, due: '2026-12-31' });
      seedInvoice({ number: 'CRIT-2026-0082', total: 1120000, status: 'issued', due: '2026-11-01' });
      const res = await sendSweep(sweep('reminders', '2026-11-19T01:00:00Z'));
      await swept('data.find.invoices', 1);
      assert.equal(res.status, 202);
      assert.deepEqual(ops(), ['data.get_config', 'data.find.invoices']);
      assert.equal(emails().length, 0);
      note.calls = ops();
    },
  },
  {
    id: 'reminder_after_failed_run', description: 'A reminder claim left by a run that died (ledger state failed): the next sweep does not resend; the step goes to review with an alert.',
    async run(note) {
      const invoice = seedInvoice({ number: 'CRIT-2026-0091', total: 1120000 });
      data().ledger.set(`invoice_reminder:${invoice.id}:d3`, { scope: 'invoice_reminder', key: `${invoice.id}:d3`, state: 'failed', run_id: '1', attempts: 1, payload: null, claimed_at: '2026-11-19T01:00:01.000Z', claimed_ms: Date.parse('2026-11-19T01:00:01Z'), outcome: null, result: null, error: 'run died' });
      await sendSweep(sweep('reminders', '2026-11-19T02:00:00Z'));
      await h.waitFor(() => ledger('invoice_reminder', `${invoice.id}:d3`)?.state === 'done', { what: 'the step to be marked for review' });
      await h.settle(900);
      assert.deepEqual(ops(), [...REMINDER_READS, 'data.ledger_claim', 'data.insert.review_items', 'slack.post_message', 'data.ledger_complete']);
      assert.equal(log().find(e => e.op === 'data.ledger_claim').outcome, 'claimed_after_failure');
      assert.deepEqual([emails().length, rows('review_items')[0].kind, ledger('invoice_reminder', `${invoice.id}:d3`).outcome], [0, 'reminder_state_unknown', 'needs_review']);
      assert.ok(slack(REVIEW_CHANNEL)[0].text.startsWith(`Billing review: a reminder run stopped after claiming this step; whether the email went out is not known. Invoice CRIT-2026-0091 (${invoice.id}), step 3 days, open PHP 11,200.00. Review item review_item_`));
      note.review_alert = slack(REVIEW_CHANNEL)[0].text;
    },
  },
  {
    id: 'watchdog', description: 'An invoice numbered 2 hours ago but never delivered and a number taken with no invoice are reported once to #crit-billing; a fresh one is not; the next run reports nothing new.',
    async run(note) {
      const now = Date.now();
      const ago = minutes => new Date(now - minutes * 60000).toISOString();
      const stuck = seedInvoice({ number: 'CRIT-2026-0101', total: 1120000, status: 'issued', createdAt: ago(120), extra: { pdf_sha256: 'a'.repeat(64) } });
      seedInvoice({ number: 'CRIT-2026-0102', total: 1120000, status: 'issued', createdAt: ago(5) });
      seedInvoice({ number: 'CRIT-2026-0103', total: 1120000, status: 'sent', createdAt: ago(300) });
      h.standin.control({ data: { rows: { invoice_numbers: [{ sequence: 'invoice-2026', value: 104, key: 'evt_test_lost', created_at: ago(95) }] } } });
      const orphan = rows('invoice_numbers').at(-1);
      await sendSweep(sweep('watchdog', new Date(now).toISOString()));
      await h.waitFor(() => slack(REVIEW_CHANNEL).length === 1 && count('data.ledger_complete') === 2, { what: 'the watchdog alert' });
      await h.settle(900);
      assert.deepEqual(ops(), ['data.get_config', 'data.find.invoices', 'data.find.invoice_numbers', 'data.ledger_claim', 'data.ledger_claim', 'slack.post_message', 'data.ledger_complete', 'data.ledger_complete']);
      assert.equal(slack(REVIEW_CHANNEL)[0].text, `Invoice watchdog:\n1 invoice(s) not delivered after 30 minutes:\n- CRIT-2026-0101 (${stuck.id}), issued 120 min ago, PDF stored\n1 invoice number(s) taken with no invoice row:\n- invoice-2026 #104 (${orphan.id}), taken 95 min ago`);
      const from = seqNow();
      await sendSweep(sweep('watchdog', new Date(now + 60000).toISOString()));
      await swept('data.ledger_claim', 4);
      assert.deepEqual(ops(from), ['data.get_config', 'data.find.invoices', 'data.find.invoice_numbers', 'data.ledger_claim', 'data.ledger_claim']);
      assert.equal(slack(REVIEW_CHANNEL).length, 1, 'reported once');
      note.alert = slack(REVIEW_CHANNEL)[0].text;
    },
  },
  {
    id: 'invoice_to_payment_chain', description: 'The whole path: an invoice is requested and emailed, paid in full by the processor (receipt), and the reminder sweep after the due date leaves it alone.',
    async run(note) {
      const request = invoiceRequest({ client_id: 'client_test_lumen', currency: 'USD', po_number: null, line_items: [line('Website care plan, November', 1, 90000, 'ZERO'), line('Landing page design', 12.5, 6500, 'ZERO')] });
      await sendBilling(request);
      await done('billing_event', request.id);
      const [invoice] = rows('invoices');
      assert.deepEqual([invoice.number, invoice.total_minor, invoice.status], ['CRIT-2026-0001', 171250, 'sent']);
      const payment = paymentEvent(invoice.number, 171250, { currency: 'USD' });
      await sendPayment(payment);
      await done('payment_event', payment.id);
      assert.equal(rows('payments')[0].match, 'exact');
      await sendSweep(sweep('reminders', '2026-11-30T01:00:00Z'));
      await swept('data.find.clients', 3);
      assert.deepEqual(emails().map(m => m.subject), ['Invoice CRIT-2026-0001 from CRIT: USD 1,712.50 due 16 Nov 2026', 'Payment received for CRIT-2026-0001: USD 1,712.50']);
      assert.deepEqual([rows('reminders').length, rows('invoices')[0].receipt_email_id], [0, emails()[1].id]);
      note.emails = emails().map(m => m.subject);
    },
  },
  {
    id: 'concurrent_refunds', description: 'Two refund.requested events (different event ids, PHP 7,000 each) for one invoice paid PHP 11,200, posted at the same moment; both runs read the refunds before either writes. One refund goes to the processor; the other, decided again after its guarded write lost, is refused with PHP 4,200 left.',
    faults: [{ op: 'data.find.refunds', delay_ms: 1500, times: 2 }],
    async run(note) {
      const invoice = seedInvoice({ number: 'CRIT-2026-0111', total: 1120000 });
      seedPayment(invoice, 1120000);
      const events = [0, 1].map(() => changeEvent('refund.requested', { invoice_number: invoice.number, amount_minor: 700000, currency: 'PHP' }));
      const answers = await Promise.all(events.map(event => sendBilling(event)));
      for (const event of events) await done('billing_event', event.id);
      const conflicts = assertBothReadBeforeWrite('data.insert.refunds');
      const byStatus = Object.fromEntries(answers.map(a => [a.status, a.json]));
      assert.deepEqual(answers.map(a => a.status).sort(), [200, 422]);
      assert.deepEqual([byStatus[200].status, byStatus[200].refundable_after_minor], ['refunded', 420000]);
      assert.deepEqual([byStatus[422].reason, byStatus[422].refundable_minor], ['refund_exceeds_paid', 420000]);
      assert.equal(conflicts, 1, 'the losing write got a guard conflict');
      assert.deepEqual([rows('refunds').length, h.standin.state().payments.refunds.length, count('payments.create_refund')], [1, 1, 1], 'one refund row, one processor refund');
      assert.equal(rows('refunds')[0].money_seq, 1);
      assert.equal(rows('invoices')[0].money_seq, 1);
      note.answers = answers.map(a => [a.status, a.json.status, a.json.reason ?? null]);
      note.guard_conflicts = conflicts;
    },
  },
  {
    id: 'concurrent_full_payments', description: 'Two payments of the full PHP 11,200 (different processor payments) posted at the same moment; both runs read before either writes. The first is exact with one receipt; the second, decided again, is already_paid: counted, no second receipt, a review item and one #crit-billing message. No run fails.',
    faults: [{ op: 'data.find.refunds', delay_ms: 1500, times: 2 }],
    async run(note) {
      const invoice = seedInvoice({ number: 'CRIT-2026-0112', total: 1120000 });
      const events = [0, 1].map(() => paymentEvent(invoice.number, 1120000));
      const answers = await Promise.all(events.map(event => sendPayment(event)));
      for (const event of events) await done('payment_event', event.id);
      assert.deepEqual(answers.map(a => a.status), [202, 202]);
      const conflicts = assertBothReadBeforeWrite('data.insert.payments');
      assert.equal(conflicts, 1);
      const payments = rows('payments');
      assert.deepEqual(payments.map(p => p.match), ['exact', 'already_paid']);
      assert.deepEqual(payments.map(p => [p.counted, p.excess_minor, p.money_seq]), [[true, 0, 1], [true, 1120000, 2]]);
      assert.deepEqual([emails().length, emails()[0].subject], [1, 'Payment received for CRIT-2026-0112: PHP 11,200.00']);
      assert.deepEqual(rows('review_items').map(r => [r.kind, r.payment_id]), [['already_paid', payments[1].id]]);
      assert.equal(slack(REVIEW_CHANNEL).length, 1);
      assert.match(slack(REVIEW_CHANNEL)[0].text, /^Billing review: paid on an invoice that was already paid in full\./);
      assert.equal(slack(ALERTS_CHANNEL).length, 0, 'no run failed');
      assert.deepEqual(events.map(e => ledger('payment_event', e.id).outcome).sort(), ['already_paid', 'exact']);
      note.matches = payments.map(p => p.match);
      note.review_alert = slack(REVIEW_CHANNEL)[0].text;
    },
  },
  {
    id: 'concurrent_partial_and_rest', description: 'PHP 4,000 and PHP 7,200 on a PHP 11,200 invoice posted at the same moment: one is partial, the other, decided against the state after the first, completes the invoice and gets the one receipt.',
    faults: [{ op: 'data.find.refunds', delay_ms: 1500, times: 2 }],
    async run(note) {
      const invoice = seedInvoice({ number: 'CRIT-2026-0113', total: 1120000 });
      const events = [paymentEvent(invoice.number, 400000), paymentEvent(invoice.number, 720000)];
      await Promise.all(events.map(event => sendPayment(event)));
      for (const event of events) await done('payment_event', event.id);
      assert.equal(assertBothReadBeforeWrite('data.insert.payments'), 1);
      const payments = rows('payments');
      assert.deepEqual(payments.map(p => p.match), ['partial', 'completes']);
      assert.deepEqual(payments.map(p => p.paid_after_minor), [payments[0].amount_minor, 1120000]);
      assert.equal(emails().length, 1);
      assert.match(emails()[0].text, /Invoice CRIT-2026-0113 \(PHP 11,200\.00\) is paid in full\./);
      assert.equal(rows('invoices')[0].receipt_email_id, emails()[0].id);
      assert.deepEqual([rows('review_items').length, slack().length], [0, 0]);
      note.order = payments.map(p => [p.match, p.amount_minor]);
    },
  },
  {
    id: 'concurrent_void_and_payment', description: 'A void request and a full payment for the same unpaid invoice posted at the same moment; both runs read before either writes. Whichever write lands first wins and the other is decided again: never a void invoice with a counted payment and a receipt.',
    faults: [{ op: 'data.find.refunds', delay_ms: 1500, times: 2 }],
    async run(note) {
      const invoice = seedInvoice({ number: 'CRIT-2026-0114', total: 1120000 });
      const voidEvent = changeEvent('invoice.void_requested', { invoice_number: invoice.number, reason: 'raised in error' });
      const payment = paymentEvent(invoice.number, 1120000);
      const [voidAnswer, paymentAnswer] = await Promise.all([sendBilling(voidEvent), sendPayment(payment)]);
      await done('billing_event', voidEvent.id);
      await done('payment_event', payment.id);
      const delayed = log().filter(e => e.op === 'data.find.refunds' && /^delayed_/.test(e.fault ?? ''));
      const firstWrite = log().find(e => e.op === 'data.insert.payments' || e.op === 'data.update.invoices');
      assert.ok(delayed.length === 2 && delayed.every(e => e.seq < firstWrite.seq), 'both runs read before either wrote');
      assert.equal(log().filter(e => e.outcome === 'guard_conflict').length, 1);
      const [stored] = rows('invoices');
      const [row] = rows('payments');
      assert.equal(paymentAnswer.status, 202);
      if (stored.status === 'void') {
        assert.deepEqual([voidAnswer.status, row.match, row.counted, emails().length, rows('review_items')[0].kind], [200, 'invoice_void', false, 0, 'invoice_void']);
        note.winner = 'void';
      } else {
        assert.deepEqual([voidAnswer.status, voidAnswer.json.status, voidAnswer.json.from, row.match, emails().length], [409, 'invalid_transition', 'paid', 'exact', 1]);
        note.winner = 'payment';
      }
      assert.ok(!(stored.status === 'void' && row.counted), 'never a void invoice with a counted payment');
      assert.equal(slack(ALERTS_CHANNEL).length, 0);
      note.answers = [voidAnswer.status, paymentAnswer.status];
      note.payment_match = row.match;
    },
  },
  {
    id: 'dead_letter_store_failure', description: 'A broken payload while the data service refuses the dead letter on all 4 tries: the sender still gets a deliberate 400, and the error workflow alerts #crit-alerts with the payload hash (no payload, no client data).',
    faults: [{ op: 'data.insert.dead_letters', status: 500, times: 4, body: { error: 'database unavailable' } }],
    async run(note) {
      const broken = invoiceRequest({ client_id: undefined, line_items: [line('Retainer', 1, 15000.5, 'VAT12')] });
      const res = await sendBilling(broken);
      assert.deepEqual([res.status, res.json.status, res.json.dead_letter_id], [400, 'invalid', null]);
      await h.waitFor(() => slack(ALERTS_CHANNEL).length > 0, { what: 'the dead-letter alert', timeoutMs: 60000 });
      await h.settle(800);
      assert.deepEqual(ops(), ['data.insert.dead_letters', 'data.insert.dead_letters', 'data.insert.dead_letters', 'data.insert.dead_letters', 'data.ledger_fail', 'slack.post_message']);
      const [alert] = slack(ALERTS_CHANNEL);
      const hash = L.deadLetterRow('billing-webhook', 'issue-invoices', JSON.parse(JSON.stringify(broken)), null, []).row.payload_sha256;
      assert.match(alert.text, new RegExp(`^Workflow failed: CRIT · Issue invoices\nFailed node: Check dead letter stored\nError: Dead letter not stored \\(issue-invoices, source billing-webhook\\): payload sha256 ${hash}, event id ${broken.id}, 2 reason\\(s\\)\\. The sender was answered 400`));
      assert.match(alert.text, /No claim was held by this run\.$/);
      assert.ok(!alert.text.includes('Retainer'), 'no payload text in the alert');
      assert.equal(rows('dead_letters').length, 0);
      note.alert = alert.text;
    },
  },
  {
    id: 'late_redelivery_after_lost_answer', description: 'Redeliveries after a run died with a send whose answer was lost: an invoice email started 30 h ago, a receipt for a payment stored 30 h ago and a refund stored 30 h ago are not sent again (past the 23-hour resend window) and each raises an alert with ids; an invoice email started 2 h ago is resent with the same key and delivered once.',
    async run(note) {
      const pdf = minimalPdf(['Invoice CRIT-2026-0131']);
      const seedEmailStep = (number, startedHoursAgo) => {
        const event = invoiceRequest();
        const invoice = seedInvoice({ number, total: 1120000, status: 'issued', extra: { request_event_id: event.id, pdf_key: `invoices/2026/${number}.pdf`, pdf_sha256: sha256(pdf), pdf_bytes: pdf.length, email_started_at: hoursAgo(startedHoursAgo) } });
        h.standin.moduleState('storage').objects.set(`${BUCKET}/invoices/2026/${number}.pdf`, { path: `${BUCKET}/invoices/2026/${number}.pdf`, size: pdf.length, sha256: sha256(pdf), content_type: 'application/pdf', bytes: pdf, writes: 1 });
        seedFailedClaim('billing_event', event.id);
        return { event, invoice };
      };
      const alertsBefore = () => slack(ALERTS_CHANNEL).length;
      const awaitAlert = async n => { await h.waitFor(() => slack(ALERTS_CHANNEL).length >= n, { what: `alert ${n}`, timeoutMs: 60000 }); await h.settle(800); return slack(ALERTS_CHANNEL)[n - 1].text; };

      // 1. invoice email started 30 h ago, no answer recorded
      const late = seedEmailStep('CRIT-2026-0131', 30);
      assert.equal((await sendBilling(late.event)).status, 202);
      const emailAlert = await awaitAlert(alertsBefore() + 1);
      assert.match(emailAlert, new RegExp(`^Workflow failed: CRIT · Issue invoices\nFailed node: Check delivery progress\nError: Invoice CRIT-2026-0131 \\(${late.invoice.id}\\): an email send started at .* past the 23-hour resend window; not resent\\.`));
      assert.deepEqual([emails().length, count('storage.get_object'), rows('invoices')[0].status, ledger('billing_event', late.event.id).state], [0, 0, 'issued', 'failed']);

      // 2. invoice email started 2 h ago: resent with the same key, delivered once, the first start time kept
      const recent = seedEmailStep('CRIT-2026-0132', 2);
      const startedAt = recent.invoice.email_started_at;
      await sendBilling(recent.event);
      await done('billing_event', recent.event.id);
      const delivered = rows('invoices').find(i => i.number === 'CRIT-2026-0132');
      assert.deepEqual([emails().length, delivered.status, delivered.email_started_at, emails()[0].idempotency_key], [1, 'sent', startedAt, `billing-event:${recent.event.id}:Send invoice email`]);

      // 3. receipt: the payment row was stored 30 h ago, the receipt never recorded
      const paidInvoice = seedInvoice({ number: 'CRIT-2026-0133', total: 1120000 });
      const payment = paymentEvent(paidInvoice.number, 1120000);
      h.standin.control({ data: { rows: { payments: [{ event_id: payment.id, processor_payment_id: payment.data.payment_id, reference: paidInvoice.number, invoice_id: paidInvoice.id, invoice_number: paidInvoice.number, amount_minor: 1120000, currency: 'PHP', received_at: payment.data.received_at, match: 'exact', counted: true, excess_minor: 0, paid_after_minor: 1120000, money_seq: 1, created_at: hoursAgo(30) }] } } });
      seedFailedClaim('payment_event', payment.id);
      const before = alertsBefore();
      assert.equal((await sendPayment(payment)).status, 202);
      const receiptAlert = await awaitAlert(before + 1);
      assert.match(receiptAlert, /^Workflow failed: CRIT · Match payments\nFailed node: Prepare receipt email\nError: Payment payments_\d+ \(event evt_pay_test_\d+, reference CRIT-2026-0133\) was stored at .* past the 23-hour resend window, so it is not resent\./);
      assert.equal(emails().length, 1, 'no receipt');
      assert.equal(rows('payments').length, 1, 'the payment row is not written again');

      // 4. refund: stored 30 h ago, the processor's answer never recorded
      const refundInvoice = seedInvoice({ number: 'CRIT-2026-0134', total: 1120000 });
      seedPayment(refundInvoice, 1120000);
      const refund = changeEvent('refund.requested', { invoice_number: refundInvoice.number, amount_minor: 500000, currency: 'PHP' });
      h.standin.control({ data: { rows: { refunds: [{ event_id: refund.id, invoice_id: refundInvoice.id, invoice_number: refundInvoice.number, amount_minor: 500000, currency: 'PHP', reason: null, status: 'approved', processor_refund_id: null, money_seq: 1, created_at: hoursAgo(30) }] } } });
      seedFailedClaim('billing_event', refund.id);
      const beforeRefund = alertsBefore();
      const refundAnswer = await sendBilling(refund);
      const refundAlert = await awaitAlert(beforeRefund + 1);
      assert.equal(refundAnswer.status, 500, 'n8n answers 500 when the run fails before its answer, so the sender knows it did not go through');
      assert.match(refundAlert, /^Workflow failed: CRIT · Issue invoices\nFailed node: Decide change\nError: Refund refunds_\d+ on CRIT-2026-0134 \(invoices_\d+\) was stored at .* a second send could refund twice; not resent\./);
      assert.deepEqual([count('payments.create_refund'), rows('refunds').length], [0, 1]);
      note.alerts = [emailAlert, receiptAlert, refundAlert].map(text => text.split('\n')[1]);
      note.refund_answer = refundAnswer.status;
    },
  },
];

// Checks that hold over every scenario's request log, the alerts and the ledger results.
const WRITE_OPS = /^(data\.insert\.|data\.update\.|email\.send$|storage\.put_object$|payments\.create_refund$|slack\.post_message$)/;
function assertHouseRules() {
  for (const entry of log()) {
    if (WRITE_OPS.test(entry.op)) {
      assert.match(entry.idempotency_key ?? '', /^[a-z-]+:[^:]+(:d\d+)?(:[^:]+)*:[A-Z][A-Za-z ]+$/, `${entry.op} has an Idempotency-Key`);
      assert.match(entry.run_id ?? '', /^\d+$/, `${entry.op} X-Run-Id`);
    }
    if (entry.op.startsWith('data.ledger_') || entry.op === 'data.sequence_next') {
      assert.equal(entry.idempotency_key, null, `${entry.op} is not keyed`);
      assert.match(entry.run_id ?? '', /^\d+$/, `${entry.op} X-Run-Id`);
    }
    if (entry.op.startsWith('data.find.') || ['data.get_config', 'storage.get_object', 'pdf.render'].includes(entry.op)) assert.equal(entry.idempotency_key, null, `${entry.op} is a read`);
    if (entry.op.startsWith('data.update.')) assert.match(entry.idempotency_key, /:(Record PDF on invoice|Record email start|Record delivery|Mark invoice void|Record processor refund|Record receipt on invoice)$/);
    if (/^data\.insert\.(payments|refunds)$/.test(entry.op) || entry.idempotency_key?.endsWith(':Mark invoice void')) assert.match(entry.idempotency_key, /:(seq\d+|unguarded):(Store payment row|Store refund row|Mark invoice void)$/, `${entry.op} names the money_seq it was decided against`);
  }
  const visible = JSON.stringify({ slack: h.standin.state().slack.messages, ledger: [...data().ledger.values()].map(e => e.result), reviews: rows('review_items') });
  for (const secret of CLIENT_SECRETS) assert.ok(!visible.includes(secret), `no client data in alerts, review items or ledger results: ${secret}`);
}

// ---------------------------------------------------------------- run
// The per-user temp folder (n8n's data folder and the lock live there) is written as <tmp> in every results file.
const TMP_PATHS = [...new Set([realpathSync(tmpdir()), tmpdir()])].sort((a, b) => b.length - a.length);
const scrub = text => TMP_PATHS.reduce((out, path) => out.split(path).join('<tmp>'), text);
const writeScrubbed = (path, text) => writeFileSync(path, scrub(text));
const resultsDir = join(root, 'results');
const logsDir = join(resultsDir, 'request-logs');
if (!only) rmSync(logsDir, { recursive: true, force: true });
mkdirSync(logsDir, { recursive: true });
const outcomes = [];
const startedAt = new Date();
let fatal = null;
try {
  await h.start();
  for (const scenario of scenarios) {
    if (only && !only.has(scenario.id)) continue;
    h.standin.reset();
    if (scenario.faults) h.standin.control({ faults: scenario.faults });
    const note = {};
    const t0 = Date.now();
    const outcome = { id: scenario.id, description: scenario.description, passed: false };
    try {
      await scenario.run(note);
      assertHouseRules();
      outcome.passed = true;
    } catch (error) {
      outcome.error = error.message;
    }
    outcome.seconds = Math.round((Date.now() - t0) / 100) / 10;
    outcome.calls = log().map(e => `${e.op} ${e.status}${e.outcome ? ` ${e.outcome}` : ''}${e.fault ? ` (${e.fault})` : ''}${e.idempotent_replay ? ' (replayed)' : ''}`);
    outcome.notes = note;
    outcomes.push(outcome);
    const state = h.standin.state();
    for (const render of state.pdf.renders) render.html = `<${render.html.length} chars sha256:${render.html_sha256.slice(0, 16)}>`;
    writeScrubbed(join(logsDir, `${scenario.id}.json`), `${JSON.stringify({ log: log(), state }, null, 2)}\n`);
    console.log(`${outcome.passed ? 'PASS' : 'FAIL'} ${scenario.id} (${outcome.seconds}s)${outcome.error ? `\n     ${outcome.error.split('\n').join('\n     ')}` : ''}`);
  }
} catch (error) {
  fatal = error;
  console.error(`harness failure: ${error.stack}`);
} finally {
  if (fatal || outcomes.some(o => !o.passed)) writeScrubbed(join(resultsDir, 'n8n-server.log.txt'), h.serverLog().slice(-30000));
  await h.stop();
}

const leftovers = h.leftovers();
const passed = outcomes.filter(o => o.passed).length;
// Another worker may take the lock the moment it is released, so "released" means: not held by this process.
const lockOwner = (() => { try { return JSON.parse(readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8')).pid; } catch { return null; } })();
const summary = {
  workflows: ['CRIT · Issue invoices (critInvoiceIssue)', 'CRIT · Match payments (critPaymentMatch)', 'CRIT · Chase overdue invoices (critInvoiceChase)', 'CRIT · Alert on errors (critAlertErrors1)'],
  started_at: startedAt.toISOString(),
  finished_at: new Date().toISOString(),
  runtime: { n8n: h.n8nVersion ?? N8N_VERSION, node: process.version, platform: `${process.platform} ${process.arch}` },
  answered_by_local_stand_ins: ['data service (rows, ledger, invoice-number sequence, compare-and-set updates, dead letters, config)', 'document rendering service (HTML to a minimal PDF)', 'object storage (PUT and GET of the PDF)', 'transactional email API in the Resend request shape (with Idempotency-Key)', 'payment processor refund call', 'Slack chat.postMessage (#crit-alerts and #crit-billing)'],
  not_exercised_end_to_end: ['the two Schedule Triggers (INVOICE_SCHEDULES=off in this run; sweeps were started by signed requests)'],
  totals: { scenarios: outcomes.length, passed, failed: outcomes.length - passed },
  cleanup: { n8n_processes_left: leftovers.length, temp_folder_removed: !existsSync(h.userFolder ?? '/nonexistent'), lock_released_by_this_run: lockOwner !== process.pid, lock: LOCK_DIR },
  scenarios: outcomes,
};
writeScrubbed(join(resultsDir, only ? 'e2e-summary.partial.json' : 'e2e-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
// The kit harness writes the n8n CLI's import and publish output as is; it names the temp data folder.
for (const file of readdirSync(resultsDir).filter(name => /^(import|publish)-.*\.stdout\.txt$/.test(name))) writeScrubbed(join(resultsDir, file), readFileSync(join(resultsDir, file), 'utf8'));
console.log(`\n${passed} of ${outcomes.length} scenarios passed. n8n ${summary.runtime.n8n}, Node ${process.version}. Processes left: ${leftovers.length}.`);
if (fatal || passed !== outcomes.length || leftovers.length || (h.userFolder && existsSync(h.userFolder))) process.exitCode = 1;
