// Shared pieces of the three invoicing workflows: the logic modules, data service URLs, and the signed-webhook
// intake (signature, shape, dead letter, ledger claim) that "Issue invoices" and "Match payments" both use.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV, at, codeNode, httpNode, ifNode, respondNode, switchNode, webhookNode } from '../../../_shared/lib/flow.mjs';
import { createModules } from '../../../_shared/lib/modules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const LIB_FILES = ['dates', 'money', 'service', 'signature', 'events', 'invoice', 'documents', 'payments', 'changes', 'chase'].map(file => join(here, '..', 'lib', `${file}.js`));
export const lib = createModules(LIB_FILES);
export const TIMEZONE = 'Asia/Manila';
export const CONFIG_NAME = 'invoice-to-payment';
// Schedule Trigger version from n8n-mcp get_node for n8n 2.42.6 (the kit has no factory for it).
export const SCHEDULE_TRIGGER_VERSION = 1.4;
// Successful runs keep no execution data (client emails and PDFs would sit in it); failed runs keep it for debugging.
export const SETTINGS = { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' };

export const code = (name, position, body, options) => codeNode(name, position, lib.codeSource(name, body, options));
export const DATA = { Authorization: `=Bearer ${ENV('DATA_SERVICE_TOKEN')}` };
export const dataUrl = path => `${ENV('DATA_SERVICE_BASE_URL')}${path}`;
export const bearer = variable => ({ Authorization: `=Bearer ${ENV(variable)}` });
// A GET on a data service table filtered by one column taken from an earlier node.
export const findRows = (name, position, table, column, expression) => httpNode(name, position, { url: `${dataUrl(`/v1/rows/${table}`)}${column ? `?${column}={{ encodeURIComponent(${expression}) }}` : ''}`, headers: DATA });

export function signedWebhookNode(name, position, path) {
  const node = webhookNode(name, position, { path });
  node.parameters.options = { rawBody: true };
  return node;
}

export function scheduleNode(name, position, interval) {
  return { name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: SCHEDULE_TRIGGER_VERSION, position, parameters: { rule: { interval: [interval] } } };
}

// PUT of the binary property "data" (the kit's httpNode sends JSON bodies only).
export function binaryPutNode(name, position, { url, headers }) {
  const node = httpNode(name, position, { method: 'PUT', url, headers, body: false, write: true });
  const { options, ...rest } = node.parameters;
  node.parameters = { ...rest, sendBody: true, contentType: 'binaryData', inputDataFieldName: 'data', options };
  return node;
}

const setHeader = (node, name, value) => {
  const header = node.parameters.headerParameters.parameters.find(entry => entry.name === name);
  if (!header) throw new Error(`${node.name} has no ${name} header`);
  header.value = value;
  return node;
};

// A guarded money write: its Idempotency-Key also names the money_seq the decision was made against
// (<idem_base>:seq<n>:<node name>), so a new decision after a conflict is a new request, not the old key with a
// different body.
export function guardedKey(node) {
  return setHeader(node, 'Idempotency-Key', `={{ $json.idem_base }}:{{ $json.guard_tag }}:${node.name}`);
}

// A write whose body and key come from a named earlier node instead of its input item (the node before it is
// another HTTP call whose answer replaced the item).
export function bodyFrom(node, source) {
  node.parameters.jsonBody = `={{ JSON.stringify($('${source}').first().json.req.body) }}`;
  return setHeader(node, 'Idempotency-Key', `={{ $('${source}').first().json.idem_base }}:${node.name}`);
}

export function intakeNotes({ webhook, path, secret, scope, accepted, label }) {
  return {
    [webhook]: `POST /webhook/${path}. Signed by the sender with ${secret}; the raw body is kept for the HMAC.`,
    'Verify signature': 'HMAC-SHA256 over "<t>.<raw body>" from X-CRIT-Signature, constant-time compare, then the timestamp within 300 s. Nothing runs before this.',
    'Route on signature': 'Early exit: a missing, wrong or stale signature ends the run with 401 and no call of any kind.',
    'Respond 401 unauthorized': 'Answers 401 {status: unauthorized, error}.',
    'Validate event shape': `Envelope (id, type, created_at, data) and the data of ${accepted}, checked before anything is stored. Amounts must be whole minor units.`,
    'Route by event shape': 'valid goes on; a well-formed event of another type is ignored; a broken one is dead-lettered.',
    'Respond 200 ignored': 'Answers 200 {status: ignored}. Nothing stored.',
    'Store dead letter': 'Data service dead_letters: the payload as received, the reasons, its hash (unique, so a second delivery is not stored twice). Non-critical.',
    'Respond 400 invalid': 'Answers 400 {status: invalid, errors, dead_letter_id}.',
    'Check dead letter stored': 'After the 400: if the dead letter was not stored, the run fails into the error workflow, which alerts with the payload hash (ids only). The payload stays in the failed execution.',
    'Prepare event claim': `Ledger claim for this ${label} (scope ${scope}, key = the sender's event id), with the event kept for replay.`,
    'Claim event': 'Data service ledger: one claim per event id. Critical: 3 retries 5 s apart, then the error workflow.',
    'Read claim result': 'claimed goes on; in_flight means another run holds it; done means it was handled already.',
    'Route on claim': 'Early exit for in_flight (409, the sender retries later) and done (200 duplicate).',
    'Respond 409 in flight': 'Answers 409 with Retry-After: 30. Nothing else runs.',
    'Respond 200 duplicate': 'Answers 200 {status: duplicate, outcome} with the first run\'s outcome. Nothing else runs.',
  };
}

// Adds section 1 nodes and wires them. Returns the name of the node that receives claimed events (Route on claim
// output 0 is left for the caller to connect).
export function addIntake(f, { webhook, path, secretEnv, typesConst, scope, idemPrefix, source, workflow }) {
  f.add(signedWebhookNode(webhook, at(0, 0), path));
  f.add(code('Verify signature', at(1, 0), `
const raw = await rawBodyOf(this.helpers, $input.first());
const verdict = verifySignature($env.${secretEnv}, headerValue(ctx.headers, SIGNATURE_HEADER), raw, Math.floor(Date.now() / 1000));
const checked = verifiedPayload(verdict, raw);
const rawText = checked.ok && checked.payload === null && raw ? raw.toString('utf8').slice(0, 2000) : null;
return [{ json: { signature_ok: checked.ok, signature_reason: checked.reason, payload: checked.payload, parse_error: checked.parse_error || null, raw_text: rawText } }];`));
  f.add(ifNode('Route on signature', at(2, 0), '$json.signature_ok'));
  f.add(respondNode('Respond 401 unauthorized', at(2, 1), "JSON.stringify({ status: 'unauthorized', error: $json.signature_reason })", 401));
  f.add(code('Validate event shape', at(3, 0), `
const shape = ctx.payload === null ? { kind: 'invalid', errors: [ctx.parse_error || 'the body is empty'], event_id: null, type: null, data: null } : validateEvent(ctx.payload, ${typesConst});
const out = { kind: shape.kind, errors: shape.errors, event_id: shape.event_id, type: shape.type, created_at: shape.created_at || null, data: shape.data, payload: ctx.payload };
if (shape.kind === 'invalid') {
  out.req = { body: deadLetterRow('${source}', '${workflow}', ctx.payload, ctx.raw_text, shape.errors) };
  out.idem_base = 'dead-letter:' + out.req.body.row.payload_sha256;
}
return [{ json: out }];`));
  f.add(switchNode('Route by event shape', at(4, 0), '$json.kind', ['valid', 'ignored', 'invalid']));
  f.add(respondNode('Respond 200 ignored', at(4, 1), "JSON.stringify({ status: 'ignored', event_id: $json.event_id, type: $json.type })", 200));
  f.add(httpNode('Store dead letter', at(4, 2), { method: 'POST', url: dataUrl('/v1/rows/dead_letters'), headers: DATA, write: true, soft: true }));
  f.add(respondNode('Respond 400 invalid', at(5, 2), "JSON.stringify({ status: 'invalid', errors: $('Validate event shape').first().json.errors, dead_letter_id: $json.row ? $json.row.id : null })", 400));
  f.add(code('Check dead letter stored', at(6, 2), `
const shape = $('Validate event shape').first().json;
// The Respond node passes on what Store dead letter gave it: the stored row, or the error item (output 1).
const stored = response;
if (!stored || !stored.row || typeof stored.row.id !== 'string') {
  const failure = httpOutcome(stored);
  throw new Error('Dead letter not stored (${workflow}, source ${source}): payload sha256 ' + shape.req.body.row.payload_sha256 + ', event id ' + (shape.event_id || 'none') + ', ' + shape.errors.length + ' reason(s). The sender was answered 400; the payload is kept in this failed execution. Data service: ' + (failure.error || 'no row in the answer'));
}
return [{ json: { dead_letter_id: stored.row.id, payload_sha256: stored.row.payload_sha256 } }];`));
  f.add(code('Prepare event claim', at(5, 0), `
ctx.idem_base = '${idemPrefix}:' + ctx.event_id;
ctx.req = { body: claimBody('${scope}', ctx.event_id, ctx.payload) };
delete ctx.payload;
return [{ json: ctx }];`));
  f.add(httpNode('Claim event', at(6, 0), { method: 'POST', url: dataUrl('/v1/ledger/claim'), headers: DATA, runId: true }));
  f.add(code('Read claim result', at(7, 0), `
const outcome = claimOutcome(response);
delete ctx.req;
ctx.claim = outcome;
ctx.reclaimed = response.reclaimed || null;
ctx.previous = outcome === 'done' && response.entry ? { outcome: response.entry.outcome, result: response.entry.result } : null;
return [{ json: ctx }];`, { from: ['Prepare event claim'] }));
  f.add(switchNode('Route on claim', at(8, 0), '$json.claim', ['claimed', 'in_flight', 'done']));
  f.add(respondNode('Respond 409 in flight', at(8, 1), "JSON.stringify({ status: 'in_flight', event_id: $json.event_id })", 409, { 'Retry-After': '30' }));
  f.add(respondNode('Respond 200 duplicate', at(8, 2), "JSON.stringify({ status: 'duplicate', event_id: $json.event_id, outcome: $json.previous ? $json.previous.outcome : null })", 200));

  f.chain(webhook, 'Verify signature', 'Route on signature');
  f.connect('Route on signature', 'Validate event shape', 0);
  f.connect('Route on signature', 'Respond 401 unauthorized', 1);
  f.connect('Validate event shape', 'Route by event shape');
  f.connect('Route by event shape', 'Prepare event claim', 0);
  f.connect('Route by event shape', 'Respond 200 ignored', 1);
  f.connect('Route by event shape', 'Store dead letter', 2);
  f.connect('Store dead letter', 'Respond 400 invalid', 0);
  f.connect('Store dead letter', 'Respond 400 invalid', 1);
  f.connect('Respond 400 invalid', 'Check dead letter stored');
  f.chain('Prepare event claim', 'Claim event', 'Read claim result', 'Route on claim');
  f.connect('Route on claim', 'Respond 409 in flight', 1);
  f.connect('Route on claim', 'Respond 200 duplicate', 2);
  return 'Route on claim';
}
