// "CRIT · Chase overdue invoices": a daily reminder sweep and an hourly watchdog, both also startable through a
// signed sweep request (which may fix the clock with as_of when INVOICE_CLOCK_OVERRIDE=allow).
import { ENV, Flow, at, httpNode, ifNode, respondNode, switchNode } from '../../../_shared/lib/flow.mjs';
import { CONFIG_NAME, DATA, SETTINGS, TIMEZONE, bearer, code, dataUrl, findRows, scheduleNode, signedWebhookNode } from './common.mjs';

export const ID = 'critInvoiceChase';
export const NAME = 'CRIT · Chase overdue invoices';
export const FILE = 'chase-invoices.json';
export const PATH = 'crit/invoices/sweeps';

const NOTES = {
  'Receive daily reminder tick': 'Schedule: every day at 09:00 in the workflow time zone (Asia/Manila).',
  'Prepare reminder sweep': 'A reminders sweep with the real clock. INVOICE_SCHEDULES=off stops it here (the tests start sweeps by request instead).',
  'Receive watchdog tick': 'Schedule: every hour at minute 20.',
  'Prepare watchdog sweep': 'A watchdog sweep with the real clock. INVOICE_SCHEDULES=off stops it here.',
  'Receive sweep request': `POST /webhook/${PATH}: an operator or a test starts a sweep. Signed with BILLING_WEBHOOK_SECRET.`,
  'Verify signature': 'Same check as the billing intake: HMAC over the raw body, then the timestamp within 300 s.',
  'Route on signature': 'Early exit: 401 and no call.',
  'Respond 401 unauthorized': 'Answers 401 {status: unauthorized, error}.',
  'Validate sweep request': 'sweep.reminders or sweep.watchdog, optional data.as_of (used only when INVOICE_CLOCK_OVERRIDE is allow).',
  'Route sweep request': 'valid goes on, anything else gets 400.',
  'Respond 400 invalid': 'Answers 400 {status: invalid, errors}.',
  'Respond 202 accepted': 'Answers 202 {status: accepted, kind}; the sweep runs after the answer.',
  'Fetch chase config': `Data service config "${CONFIG_NAME}": reminder steps, stuck threshold, time zone.`,
  'Read chase config': 'Fixes the clock for this run (now, or as_of when allowed) and the date in the business time zone.',
  'Route by sweep kind': 'reminders or watchdog.',
  'Find sent invoices': 'Data service invoices with status sent (delivered, not void).',
  'Pick overdue invoices': 'Due date before today. None: early exit, nothing else is read.',
  'Route on overdue': 'Early exit when no delivered invoice is past due.',
  'Find payments': 'Data service payments, to derive what is still open on each invoice.',
  'Find refunds': 'Data service refunds: a refunded invoice is not chased.',
  'Find sent reminders': 'Data service reminders already sent (one row per invoice and step).',
  'Find clients': 'Data service clients, for the reminder address.',
  'Decide reminders due': 'Per invoice: the highest step reached (config reminder_steps_days), only if neither it nor a later step was sent. Paid and refunded invoices get nothing. One item per reminder.',
  'Route on planned': 'Early exit when nothing is due.',
  'Claim reminder steps': 'Data service ledger, one claim per invoice and step (scope invoice_reminder): a step is sent at most once, also when two sweeps overlap.',
  'Pick claimed steps': 'claimed goes to send; a claim taken over from a failed or stuck run goes to review (the email may have gone out); in flight or done is skipped.',
  'Route reminder claim': 'send, review or none.',
  'Send reminder emails': 'Transactional email API POST /emails, one per item, Idempotency-Key per invoice and step. Critical.',
  'Prepare reminder rows': 'The reminder row per sent email: step, days overdue, open amount, email id.',
  'Store reminder rows': 'Data service reminders (unique invoice and step). Idempotency-Key per invoice, step and node.',
  'Prepare reminder done marks': 'Ledger done marks for the sent steps.',
  'Store reminder reviews': 'Data service review_items: the step whose state is unknown, ids and amounts only.',
  'Prepare review alert': 'One Slack message for the billing review channel listing the steps under review.',
  'Post review alert': 'chat.postMessage to REVIEW_SLACK_CHANNEL. Non-critical.',
  'Prepare review done marks': 'Ledger done marks (needs_review) for the steps under review, so they are not claimed again.',
  'Mark reminder steps done': 'Data service ledger: each step done with its outcome. Non-critical.',
  'Summarize reminders': 'The run\'s final item: date, clock source, what was sent or skipped and why. Ids only.',
  'Find all invoices': 'Data service invoices, all statuses.',
  'Find taken numbers': 'Data service invoice_numbers: every number taken from the sequence.',
  'Find stuck work': 'Invoices still issued (not delivered) and numbers with no invoice row, older than stuck_after_minutes. None: early exit.',
  'Route on stuck': 'Early exit when nothing is stuck.',
  'Claim stuck reports': 'Data service ledger, one claim per stuck invoice or number (scope stuck_report): each is reported once.',
  'Pick new reports': 'Keeps the newly claimed ones and builds one alert. None new: early exit.',
  'Route on new reports': 'Early exit when everything stuck was reported before.',
  'Post watchdog alert': 'chat.postMessage to REVIEW_SLACK_CHANNEL: invoice ids, numbers and ages. Critical: if it fails, the claims are released and the next run reports again.',
  'Prepare report done marks': 'Ledger done marks for the reported items.',
  'Mark reports done': 'Data service ledger: each report done. Non-critical.',
  'Summarize watchdog': 'The run\'s final item: what was found and reported. Ids only.',
};

const config = "$('Read chase config').first().json";

export function build() {
  const f = new Flow({ id: ID, name: NAME, timezone: TIMEZONE, notes: NOTES, settings: SETTINGS });
  f.sticky('Read me', [
    `## ${NAME}`,
    '**Reminders** (daily 09:00): every delivered invoice past due gets one reminder per step in config reminder_steps_days (3, 10, 21 days late), never twice for a step, never for a paid, over-paid, refunded or void invoice. **Watchdog** (hourly): invoices numbered but not delivered after stuck_after_minutes, and numbers taken with no invoice, are reported once to the billing channel.',
    '**Clock**: a sweep reads the time once. A signed sweep request may pass data.as_of, used only when INVOICE_CLOCK_OVERRIDE=allow (tests); the schedules always use the real time. INVOICE_SCHEDULES=off stops the scheduled runs.',
    '**State** in the data service: reminders (unique per invoice and step), a ledger claim per step and per stuck item, review items. **Retries**: 3 retries 5 s apart; writes send Idempotency-Key and X-Run-Id. Required steps that fail go to "CRIT · Alert on errors".',
  ].join('\n\n'), [170, -420], 2580, 400, 4);
  f.section('1. Start and clock', 'Two schedules and a signed sweep request (401, 400, 202). The clock is fixed once per run.', [0, 0], [8, 3]);
  f.section('2. Reminders', 'Overdue, open, step reached and not sent: one claim, one email, one row per step. Early exits when nothing is overdue or due.', [0, 5], [8, 8.2]);
  f.section('3. Watchdog', 'Stuck invoices and orphan numbers, each reported once. Early exit when nothing is stuck or new.', [0, 11], [10, 11]);

  // --- 1. start and clock
  f.add(scheduleNode('Receive daily reminder tick', at(0, 0), { field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 }));
  f.add(code('Prepare reminder sweep', at(1, 0), `
if ($env.INVOICE_SCHEDULES === 'off') return [];
return [{ json: { kind: 'reminders', source: 'schedule', event_id: null, requested_as_of: null } }];`));
  f.add(scheduleNode('Receive watchdog tick', at(0, 1), { field: 'hours', hoursInterval: 1, triggerAtMinute: 20 }));
  f.add(code('Prepare watchdog sweep', at(1, 1), `
if ($env.INVOICE_SCHEDULES === 'off') return [];
return [{ json: { kind: 'watchdog', source: 'schedule', event_id: null, requested_as_of: null } }];`));
  f.add(signedWebhookNode('Receive sweep request', at(0, 2), PATH));
  f.add(code('Verify signature', at(1, 2), `
const raw = await rawBodyOf(this.helpers, $input.first());
const verdict = verifySignature($env.BILLING_WEBHOOK_SECRET, headerValue(ctx.headers, SIGNATURE_HEADER), raw, Math.floor(Date.now() / 1000));
const checked = verifiedPayload(verdict, raw);
return [{ json: { signature_ok: checked.ok, signature_reason: checked.reason, payload: checked.payload, parse_error: checked.parse_error || null } }];`));
  f.add(ifNode('Route on signature', at(2, 2), '$json.signature_ok'));
  f.add(respondNode('Respond 401 unauthorized', at(2, 3), "JSON.stringify({ status: 'unauthorized', error: $json.signature_reason })", 401));
  f.add(code('Validate sweep request', at(3, 2), `
const shape = ctx.payload === null ? { kind: 'invalid', errors: [ctx.parse_error || 'the body is empty'], event_id: null, type: null, data: null } : validateEvent(ctx.payload, SWEEP_EVENT_TYPES);
const valid = shape.kind === 'valid';
const errors = shape.kind === 'ignored' ? ['type must be one of ' + SWEEP_EVENT_TYPES.join(', ')] : shape.errors;
return [{ json: { valid, errors, event_id: shape.event_id, kind: valid ? shape.type.split('.')[1] : null, source: 'request', requested_as_of: valid ? shape.data.as_of || null : null } }];`));
  f.add(ifNode('Route sweep request', at(4, 2), '$json.valid'));
  f.add(respondNode('Respond 400 invalid', at(4, 3), "JSON.stringify({ status: 'invalid', errors: $json.errors })", 400));
  f.add(respondNode('Respond 202 accepted', at(5, 2), "JSON.stringify({ status: 'accepted', event_id: $json.event_id, kind: $json.kind })", 202));
  f.add(httpNode('Fetch chase config', at(6, 1), { url: dataUrl(`/v1/config/${CONFIG_NAME}`), headers: DATA }));
  f.add(code('Read chase config', at(7, 1), `
const settings = checkedConfig(response);
const clock = resolveAsOf(ctx.requested_as_of, $env.INVOICE_CLOCK_OVERRIDE, Date.now());
if (Number.isNaN(clock.ms)) throw new Error('as_of is not a valid time');
return [{ json: { kind: ctx.kind, source: ctx.source, event_id: ctx.event_id, config: settings, as_of_ms: clock.ms, as_of: new Date(clock.ms).toISOString(), as_of_date: localDate(clock.ms, settings.timezone), clock_overridden: clock.overridden } }];`,
  { from: ['Respond 202 accepted', 'Prepare reminder sweep', 'Prepare watchdog sweep'] }));
  f.add(switchNode('Route by sweep kind', at(8, 1), '$json.kind', ['reminders', 'watchdog']));
  f.connect('Receive daily reminder tick', 'Prepare reminder sweep');
  f.connect('Receive watchdog tick', 'Prepare watchdog sweep');
  f.connect('Prepare reminder sweep', 'Fetch chase config');
  f.connect('Prepare watchdog sweep', 'Fetch chase config');
  f.chain('Receive sweep request', 'Verify signature', 'Route on signature');
  f.connect('Route on signature', 'Validate sweep request', 0);
  f.connect('Route on signature', 'Respond 401 unauthorized', 1);
  f.connect('Validate sweep request', 'Route sweep request');
  f.connect('Route sweep request', 'Respond 202 accepted', 0);
  f.connect('Route sweep request', 'Respond 400 invalid', 1);
  f.chain('Respond 202 accepted', 'Fetch chase config', 'Read chase config', 'Route by sweep kind');
  f.connect('Route by sweep kind', 'Find sent invoices', 0);
  f.connect('Route by sweep kind', 'Find all invoices', 1);

  // --- 2. reminders
  f.add(findRows('Find sent invoices', at(0, 5), 'invoices', 'status', "'sent'"));
  f.add(code('Pick overdue invoices', at(1, 5), `
const overdue = pickOverdue(rowsOf(response, 'invoice'), ctx.as_of_date);
ctx.overdue = overdue.map(invoice => invoice.id);
ctx.any_overdue = overdue.length > 0;
if (!ctx.any_overdue) ctx.result = 'no_overdue_invoices';
return [{ json: ctx }];`, { from: ['Read chase config'] }));
  f.add(ifNode('Route on overdue', at(2, 5), '$json.any_overdue'));
  f.add(findRows('Find payments', at(3, 5), 'payments'));
  f.add(findRows('Find refunds', at(4, 5), 'refunds'));
  f.add(findRows('Find sent reminders', at(5, 5), 'reminders'));
  f.add(findRows('Find clients', at(6, 5), 'clients'));
  f.add(code('Decide reminders due', at(7, 5), `
const plan = planReminders({
  invoices: rowsOf($('Find sent invoices').first().json, 'invoice'), payments: rowsOf($('Find payments').first().json, 'payment'),
  refunds: rowsOf($('Find refunds').first().json, 'refund'), reminders: rowsOf($('Find sent reminders').first().json, 'reminder'),
  clients: rowsOf(response, 'client'), asOfDate: ctx.as_of_date, steps: ctx.config.reminder_steps_days,
});
if (!plan.candidates.length) return [{ json: { planned: false, result: 'nothing_due', skipped: plan.skipped } }];
return plan.candidates.map(candidate => ({
  json: { planned: true, candidate, skipped: plan.skipped, idem_base: 'reminder:' + reminderKey(candidate), req: { body: claimBody('invoice_reminder', reminderKey(candidate), { as_of_date: ctx.as_of_date }) } },
  pairedItem: 0,
}));`, { from: ['Pick overdue invoices'] }));
  f.add(ifNode('Route on planned', at(8, 5), '$json.planned'));
  f.add(httpNode('Claim reminder steps', at(0, 7), { method: 'POST', url: dataUrl('/v1/ledger/claim'), headers: DATA, runId: true }));
  f.add(code('Pick claimed steps', at(1, 7), `
const settings = ${config};
const plans = $('Decide reminders due').all().map(item => item.json);
const invoices = rowsOf($('Find sent invoices').first().json, 'invoice');
const clients = rowsOf($('Find clients').first().json, 'client');
const out = [];
$input.all().forEach((item, index) => {
  const outcome = claimOutcome(item.json);
  const plan = plans[index];
  if (outcome !== 'claimed') return;
  const candidate = plan.candidate;
  if (item.json.reclaimed) {
    out.push({ json: { route: 'review', candidate, idem_base: plan.idem_base, req: { body: reminderReviewRow(candidate, settings.config) } }, pairedItem: index });
    return;
  }
  const invoice = invoices.find(row => row.id === candidate.invoice_id);
  const client = clients.find(row => row.client_id === invoice.client_id);
  out.push({ json: { route: 'send', candidate, idem_base: plan.idem_base, req: { body: reminderEmailBody(invoiceRef(invoice), client, candidate, settings.config, $env.EMAIL_FROM) } }, pairedItem: index });
});
if (!out.length) return [{ json: { route: 'none', result: 'no_new_claims' } }];
return out;`));
  f.add(switchNode('Route reminder claim', at(2, 7), '$json.route', ['send', 'review', 'none']));
  f.add(httpNode('Send reminder emails', at(3, 7), { method: 'POST', url: `${ENV('EMAIL_BASE_URL')}/emails`, headers: bearer('EMAIL_API_KEY'), write: true, timeout: '={{ Number($env.EMAIL_TIMEOUT_MS) || 15000 }}' }));
  f.add(code('Prepare reminder rows', at(4, 7), `
const settings = ${config};
const sends = $('Pick claimed steps').all().map(item => item.json).filter(item => item.route === 'send');
return $input.all().map((item, index) => {
  if (!item.json || typeof item.json.id !== 'string') throw new Error('The email API did not return an email id for a reminder');
  const sent = sends[index];
  return { json: { candidate: sent.candidate, idem_base: sent.idem_base, email_id: item.json.id, req: { body: reminderRow(sent.candidate, item.json.id, settings.as_of_date) } }, pairedItem: index };
});`));
  f.add(httpNode('Store reminder rows', at(5, 7), { method: 'POST', url: dataUrl('/v1/rows/reminders'), headers: DATA, write: true }));
  f.add(code('Prepare reminder done marks', at(6, 7), `
const rows = $('Prepare reminder rows').all().map(item => item.json);
return $input.all().map((item, index) => {
  const row = rowOf(item.json, 'reminder');
  const sent = rows[index];
  return { json: { candidate: sent.candidate, outcome: 'sent', req: { body: completeBody('invoice_reminder', reminderKey(sent.candidate), 'sent', { reminder_id: row.id, email_id: row.email_id }) } }, pairedItem: index };
});`));
  f.add(httpNode('Store reminder reviews', at(3, 8.2), { method: 'POST', url: dataUrl('/v1/rows/review_items'), headers: DATA, write: true }));
  f.add(code('Prepare review alert', at(4, 8.2), `
const settings = ${config};
const stored = $input.all().map(item => rowOf(item.json, 'review item'));
const text = stored.map(row => row.detail + ' Review item ' + row.id + '.').join('\\n');
return [{ json: { idem_base: 'reminder-review:' + stored.map(row => row.id).join(','), stored: stored.map(row => row.id), req: { body: { channel: $env.REVIEW_SLACK_CHANNEL, text, unfurl_links: false } } } }];`));
  f.add(httpNode('Post review alert', at(5, 8.2), { method: 'POST', url: `${ENV('ALERTS_SLACK_BASE_URL')}/api/chat.postMessage`, headers: bearer('ALERTS_SLACK_TOKEN'), write: true, soft: true }));
  f.add(code('Prepare review done marks', at(6, 8.2), `
const posted = httpOutcome(response);
const reviews = $('Pick claimed steps').all().map(item => item.json).filter(item => item.route === 'review');
const stored = $('Prepare review alert').first().json.stored;
return reviews.map((review, index) => ({ json: { candidate: review.candidate, outcome: 'needs_review', req: { body: completeBody('invoice_reminder', reminderKey(review.candidate), 'needs_review', { review_item_id: stored[index], alert_posted: posted.ok }) } }, pairedItem: 0 }));`));
  f.add(httpNode('Mark reminder steps done', at(7, 7), { method: 'POST', url: dataUrl('/v1/ledger/complete'), headers: DATA, runId: true, soft: true }));
  f.add(code('Summarize reminders', at(8, 7), `
const settings = ${config};
let skipped = [];
try { skipped = $('Decide reminders due').first().json.skipped || []; } catch (error) { skipped = []; }
const marks = [];
for (const name of ['Prepare reminder done marks', 'Prepare review done marks']) {
  try { for (const item of $(name).all()) marks.push({ invoice_id: item.json.candidate.invoice_id, step_days: item.json.candidate.step_days, outcome: item.json.outcome }); } catch (error) { /* that branch did not run */ }
}
const first = $input.first().json;
return [{ json: { kind: 'reminders', as_of_date: settings.as_of_date, clock_overridden: settings.clock_overridden, result: first.result || (marks.length ? 'done' : 'nothing_due'), marks, skipped } }];`));
  f.chain('Find sent invoices', 'Pick overdue invoices', 'Route on overdue');
  f.connect('Route on overdue', 'Find payments', 0);
  f.connect('Route on overdue', 'Summarize reminders', 1);
  f.chain('Find payments', 'Find refunds', 'Find sent reminders', 'Find clients', 'Decide reminders due', 'Route on planned');
  f.connect('Route on planned', 'Claim reminder steps', 0);
  f.connect('Route on planned', 'Summarize reminders', 1);
  f.chain('Claim reminder steps', 'Pick claimed steps', 'Route reminder claim');
  f.connect('Route reminder claim', 'Send reminder emails', 0);
  f.connect('Route reminder claim', 'Store reminder reviews', 1);
  f.connect('Route reminder claim', 'Summarize reminders', 2);
  f.chain('Send reminder emails', 'Prepare reminder rows', 'Store reminder rows', 'Prepare reminder done marks', 'Mark reminder steps done', 'Summarize reminders');
  f.chain('Store reminder reviews', 'Prepare review alert', 'Post review alert', 'Prepare review done marks', 'Mark reminder steps done');
  f.connect('Post review alert', 'Prepare review done marks', 1);
  f.connect('Mark reminder steps done', 'Summarize reminders', 1);

  // --- 3. watchdog
  f.add(findRows('Find all invoices', at(0, 11), 'invoices'));
  f.add(findRows('Find taken numbers', at(1, 11), 'invoice_numbers'));
  f.add(code('Find stuck work', at(2, 11), `
const findings = findStuck(rowsOf($('Find all invoices').first().json, 'invoice'), rowsOf(response, 'invoice number'), ctx.as_of_ms, ctx.config.stuck_after_minutes);
const items = [...findings.stuck_invoices, ...findings.orphan_numbers];
if (!items.length) return [{ json: { stuck: false, result: 'nothing_stuck' } }];
return items.map(item => ({ json: { stuck: true, item, idem_base: 'watchdog:' + item.kind + ':' + item.ref, req: { body: claimBody('stuck_report', item.kind + ':' + item.ref, { age_minutes: item.age_minutes }) } }, pairedItem: 0 }));`, { from: ['Read chase config'] }));
  f.add(ifNode('Route on stuck', at(3, 11), '$json.stuck'));
  f.add(httpNode('Claim stuck reports', at(4, 11), { method: 'POST', url: dataUrl('/v1/ledger/claim'), headers: DATA, runId: true }));
  f.add(code('Pick new reports', at(5, 11), `
const settings = ${config};
const asked = $('Find stuck work').all().map(item => item.json.item);
const fresh = [];
$input.all().forEach((item, index) => { if (claimOutcome(item.json) === 'claimed') fresh.push(asked[index]); });
if (!fresh.length) return [{ json: { report: false, result: 'already_reported', found: asked.length } }];
const findings = { stuck_invoices: fresh.filter(item => item.kind === 'invoice'), orphan_numbers: fresh.filter(item => item.kind === 'number') };
return [{ json: { report: true, fresh, idem_base: 'watchdog-report:' + fresh.map(item => item.ref).join(','), req: { body: watchdogAlert($env.REVIEW_SLACK_CHANNEL, findings, settings.config.stuck_after_minutes) } } }];`));
  f.add(ifNode('Route on new reports', at(6, 11), '$json.report'));
  f.add(httpNode('Post watchdog alert', at(7, 11), { method: 'POST', url: `${ENV('ALERTS_SLACK_BASE_URL')}/api/chat.postMessage`, headers: bearer('ALERTS_SLACK_TOKEN'), write: true }));
  f.add(code('Prepare report done marks', at(8, 11), `
const posted = httpOutcome(response);
if (!posted.ok) throw new Error('The watchdog alert was not posted: ' + posted.error);
const fresh = $('Pick new reports').first().json.fresh;
return fresh.map(item => ({ json: { item, req: { body: completeBody('stuck_report', item.kind + ':' + item.ref, 'reported', { age_minutes: item.age_minutes }) } }, pairedItem: 0 }));`));
  f.add(httpNode('Mark reports done', at(9, 11), { method: 'POST', url: dataUrl('/v1/ledger/complete'), headers: DATA, runId: true, soft: true }));
  f.add(code('Summarize watchdog', at(10, 11), `
const settings = ${config};
let reported = [];
try { reported = $('Pick new reports').first().json.fresh || []; } catch (error) { reported = []; }
const first = $input.first().json;
return [{ json: { kind: 'watchdog', as_of: settings.as_of, clock_overridden: settings.clock_overridden, result: first.result || 'reported', reported: reported.map(item => ({ kind: item.kind, ref: item.ref, age_minutes: item.age_minutes })) } }];`));
  f.chain('Find all invoices', 'Find taken numbers', 'Find stuck work', 'Route on stuck');
  f.connect('Route on stuck', 'Claim stuck reports', 0);
  f.connect('Route on stuck', 'Summarize watchdog', 1);
  f.chain('Claim stuck reports', 'Pick new reports', 'Route on new reports');
  f.connect('Route on new reports', 'Post watchdog alert', 0);
  f.connect('Route on new reports', 'Summarize watchdog', 1);
  f.chain('Post watchdog alert', 'Prepare report done marks', 'Mark reports done', 'Summarize watchdog');
  f.connect('Mark reports done', 'Summarize watchdog', 1);
  return f.json();
}

export const ENTRY = { file: FILE, id: ID, name: NAME, webhooks: [{ method: 'POST', path: PATH }], readOnlyPostNodes: [] };
