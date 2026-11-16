// Event shapes, checked before anything is stored. Envelope: { id, type, created_at, data }.
// A well-formed event of a type a workflow does not act on is "ignored" (200); a broken one is "invalid" (400,
// dead letter); only "valid" events are claimed in the ledger.

const EVENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const BILLING_EVENT_TYPES = ['invoice.requested', 'invoice.void_requested', 'refund.requested'];
const PAYMENT_EVENT_TYPES = ['payment.received'];
const SWEEP_EVENT_TYPES = ['sweep.reminders', 'sweep.watchdog'];
const LINE_ITEM_KEYS = ['description', 'quantity', 'unit_price_minor', 'tax_code'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isShortText(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isCurrencyCode(value) {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

function envelopeErrors(body) {
  const errors = [];
  if (!isPlainObject(body)) {
    errors.push('the body must be a JSON object');
    return errors;
  }
  if (typeof body.id !== 'string' || !EVENT_ID_PATTERN.test(body.id)) errors.push('id must be 1-100 letters, digits or _.:-');
  if (typeof body.type !== 'string' || !/^[a-z_]+\.[a-z_]+$/.test(body.type)) errors.push('type must look like "noun.verb"');
  if (!isIsoTimestamp(body.created_at)) errors.push('created_at must be an ISO 8601 timestamp');
  if (!isPlainObject(body.data)) errors.push('data must be an object');
  return errors;
}

function invoiceRequestErrors(data) {
  const errors = [];
  if (!isShortText(data.client_id, 64)) errors.push('data.client_id is required');
  if (!isCurrencyCode(data.currency)) errors.push('data.currency must be an ISO 4217 code');
  if (!isCalendarDate(data.due_date)) errors.push('data.due_date must be a date (YYYY-MM-DD)');
  if (data.issue_date !== undefined && !isCalendarDate(data.issue_date)) errors.push('data.issue_date must be a date (YYYY-MM-DD)');
  if (data.po_number !== undefined && data.po_number !== null && !isShortText(data.po_number, 40)) errors.push('data.po_number must be text of at most 40 characters');
  if (!Array.isArray(data.line_items) || data.line_items.length === 0) errors.push('data.line_items must be a non-empty list');
  else if (data.line_items.length > 50) errors.push('data.line_items has more than 50 lines');
  else data.line_items.forEach((line, index) => {
    const at = 'data.line_items[' + index + ']';
    if (!isPlainObject(line)) { errors.push(at + ' must be an object'); return; }
    const extra = Object.keys(line).filter(key => !LINE_ITEM_KEYS.includes(key));
    if (extra.length) errors.push(at + ' has unknown field(s): ' + extra.join(', '));
    if (!isShortText(line.description, 200)) errors.push(at + '.description is required (at most 200 characters)');
    if (quantityMilli(line.quantity) === null) errors.push(at + '.quantity must be a number above 0 with at most 3 decimals');
    if (!isMinorAmount(line.unit_price_minor)) errors.push(at + '.unit_price_minor must be a whole number of minor units (no decimals)');
    if (!isShortText(line.tax_code, 20)) errors.push(at + '.tax_code is required');
  });
  return errors;
}

function voidRequestErrors(data) {
  const errors = [];
  if (!isShortText(data.invoice_number, 40)) errors.push('data.invoice_number is required');
  if (data.reason !== undefined && !isShortText(data.reason, 200)) errors.push('data.reason must be text of at most 200 characters');
  return errors;
}

function refundRequestErrors(data) {
  const errors = [];
  if (!isShortText(data.invoice_number, 40)) errors.push('data.invoice_number is required');
  if (!isMinorAmount(data.amount_minor, 1)) errors.push('data.amount_minor must be a whole number of minor units above 0');
  if (!isCurrencyCode(data.currency)) errors.push('data.currency must be an ISO 4217 code');
  if (data.reason !== undefined && !isShortText(data.reason, 200)) errors.push('data.reason must be text of at most 200 characters');
  return errors;
}

function paymentErrors(data) {
  const errors = [];
  if (!isShortText(data.payment_id, 100)) errors.push('data.payment_id is required');
  if (!isShortText(data.reference, 60)) errors.push('data.reference is required');
  if (!isMinorAmount(data.amount_minor, 1)) errors.push('data.amount_minor must be a whole number of minor units above 0');
  if (!isCurrencyCode(data.currency)) errors.push('data.currency must be an ISO 4217 code');
  if (!isIsoTimestamp(data.received_at)) errors.push('data.received_at must be an ISO 8601 timestamp');
  return errors;
}

function sweepErrors(data) {
  return data.as_of === undefined || isIsoTimestamp(data.as_of) ? [] : ['data.as_of must be an ISO 8601 timestamp'];
}

const EVENT_RULES = {
  'invoice.requested': invoiceRequestErrors,
  'invoice.void_requested': voidRequestErrors,
  'refund.requested': refundRequestErrors,
  'payment.received': paymentErrors,
  'sweep.reminders': sweepErrors,
  'sweep.watchdog': sweepErrors,
};

// acceptedTypes: the types this workflow acts on. Returns { kind: valid | ignored | invalid, errors, event_id, type, data }.
function validateEvent(body, acceptedTypes) {
  const errors = envelopeErrors(body);
  const base = { event_id: isPlainObject(body) && typeof body.id === 'string' ? body.id.slice(0, 100) : null, type: isPlainObject(body) && typeof body.type === 'string' ? body.type.slice(0, 60) : null };
  if (errors.length) return { kind: 'invalid', errors, ...base, data: null };
  if (!acceptedTypes.includes(body.type)) return { kind: 'ignored', errors: [], ...base, data: null };
  const typeErrors = EVENT_RULES[body.type](body.data);
  if (typeErrors.length) return { kind: 'invalid', errors: typeErrors, ...base, data: null };
  return { kind: 'valid', errors: [], ...base, created_at: body.created_at, data: body.data };
}

function sha256Hex(text) {
  return require('crypto').createHash('sha256').update(text).digest('hex');
}

// A dead letter keeps the payload as received and why it was refused. No timestamp in the body: the same broken
// payload delivered twice must be byte-identical, so its Idempotency-Key replays (the data service adds created_at).
function deadLetterRow(source, workflow, payload, rawText, errors) {
  const stored = payload === null || payload === undefined ? { unparsed: String(rawText || '').slice(0, 2000) } : payload;
  return { row: { source, workflow, reason: errors.join('; ').slice(0, 500), payload_sha256: sha256Hex(JSON.stringify(stored)), payload: stored } };
}

function claimBody(scope, key, payload) {
  return { scope, key: String(key), payload: payload === undefined ? null : payload };
}

function completeBody(scope, key, outcome, result) {
  return { scope, key: String(key), outcome, result: result === undefined ? null : result };
}
