// Workflow builder with the CRIT house style built in. A workflow's build script describes nodes and wires;
// Flow fills in what every node needs and refuses a workflow that breaks the rules:
//   - name prefix "CRIT · ", a fixed 16-character id, timezone and executionOrder v1 in settings,
//     the shared error workflow attached (except on the error workflow itself)
//   - verb-first node names, a note on every node shown on the canvas (notesInFlow)
//   - a "Read me" sticky and numbered section stickies ("1. Intake", ...)
//   - HTTP Request nodes: 3 retries 5 s apart (maxTries 4); writes send Idempotency-Key = <idem_base>:<node name>
//     (stable across n8n retries and sender redeliveries) and X-Run-Id = $execution.id
//   - onError continueErrorOutput only with output 1 actually wired somewhere
// Node versions are the ones n8n-mcp's get_node reports for n8n 2.42.6 (see KIT.md for how to re-check).
import { createHash } from 'node:crypto';
import { lintWorkflow } from './lint.mjs';

export const NODE_VERSIONS = { webhook: 2.2, respondToWebhook: 1.5, code: 2, if: 2.3, switch: 3.4, httpRequest: 4.5, errorTrigger: 1, stickyNote: 1, scheduleTrigger: 1.4, wait: 1.1 };
export const ERROR_WORKFLOW_ID = 'critAlertErrors1';
export const NAME_PREFIX = 'CRIT · ';

export function uuid(seed) {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Canvas grid: column and row to pixels.
export const GRID = { col: 260, row: 200 };
export const at = (col, row) => [240 + col * GRID.col, 200 + row * GRID.row];
const ENV = name => `{{ $env.${name} }}`;
export { ENV };

export class Flow {
  // notes: { [node name]: text shown under the node }. errorWorkflow: false only for the error workflow.
  // verbs: extra node-name verbs (the same list as the manifest's "verbs"; the lint accepts VERBS plus these).
  constructor({ id, name, timezone, notes, errorWorkflow = ERROR_WORKFLOW_ID, settings = {}, verbs = [] }) {
    if (!/^[A-Za-z0-9]{16}$/.test(id)) throw new Error(`workflow id must be 16 letters or digits: ${id}`);
    if (!name.startsWith(NAME_PREFIX)) throw new Error(`workflow name must start with "${NAME_PREFIX}": ${name}`);
    if (!timezone) throw new Error('timezone is required');
    Object.assign(this, { id, name, notes, verbs, nodes: [], connections: {} });
    this.settings = { executionOrder: 'v1', timezone, ...(errorWorkflow ? { errorWorkflow } : {}), ...settings };
    this.isErrorWorkflow = !errorWorkflow;
  }

  add(node) {
    if (this.nodes.some(existing => existing.name === node.name)) throw new Error(`Duplicate node name: ${node.name}`);
    const full = { id: uuid(`${this.id}/${node.name}`), ...node };
    if (node.type !== 'n8n-nodes-base.stickyNote') {
      const note = this.notes[node.name];
      if (!note) throw new Error(`Missing note for node "${node.name}"`);
      full.notes = note;
      full.notesInFlow = true;
    }
    this.nodes.push(full);
    return node.name;
  }

  connect(from, to, output = 0) {
    if (!this.nodes.some(node => node.name === from)) throw new Error(`Unknown node ${from}`);
    const entry = (this.connections[from] ??= { main: [] });
    while (entry.main.length <= output) entry.main.push([]);
    entry.main[output].push({ node: to, type: 'main', index: 0 });
  }

  // connect a -> b -> c on output 0
  chain(...names) {
    for (let i = 0; i < names.length - 1; i++) this.connect(names[i], names[i + 1]);
  }

  sticky(name, content, position, width, height, color = 7) {
    this.add({ name, type: 'n8n-nodes-base.stickyNote', typeVersion: NODE_VERSIONS.stickyNote, position, parameters: { content, width, height, color } });
  }

  // A numbered section sticky drawn behind the nodes of a grid area: from [col, row] to [col, row] inclusive
  // (the at() grid). The name is the heading ("1. Intake and trust"), the text sits under it.
  section(name, text, [c1, r1], [c2, r2], color = 7) {
    const [x, y] = at(c1, r1);
    this.sticky(name, `## ${name}\n${text}`, [x - 70, y - 190], (c2 - c1) * GRID.col + 240, (r2 - r1) * GRID.row + 320, color);
  }

  json() {
    const workflow = { id: this.id, name: this.name, nodes: this.nodes, connections: this.connections, settings: this.settings, active: false, pinData: {}, tags: [] };
    const problems = lintWorkflow(workflow, { isErrorWorkflow: this.isErrorWorkflow, readOnlyPostNodes: this.readOnlyPostNodes ?? [], verbs: this.verbs ?? [], noRetryNodes: this.noRetryNodes ?? [] });
    if (problems.length) throw new Error(`${this.name} breaks the house style:\n - ${problems.join('\n - ')}`);
    return workflow;
  }
}

// ---------------------------------------------------------------- node factories

export function webhookNode(name, position, { path, method = 'POST' }) {
  return {
    name, type: 'n8n-nodes-base.webhook', typeVersion: NODE_VERSIONS.webhook, position, webhookId: uuid(`webhook/${path}`),
    parameters: { httpMethod: method, path, responseMode: 'responseNode', options: {} },
  };
}

export function codeNode(name, position, jsCode) {
  return { name, type: 'n8n-nodes-base.code', typeVersion: NODE_VERSIONS.code, position, parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode } };
}

// method, url (n8n expression text without the leading "="), headers { name: value }, query: send $json.req.query,
// body: send $json.req.body (or pass an expression string), write: add Idempotency-Key and X-Run-Id,
// runId: add X-Run-Id only (calls that change state but are idempotent by design, such as ledger calls),
// soft: onError continueErrorOutput (wire output 1!), responseFormat: 'file' for downloads, timeout in ms or an
// expression string. retry: false only for a paid call that is not idempotent (list it in the manifest's
// noRetryNodes as { node, reason }, and set f.noRetryNodes to the same list; see KIT.md): n8n then tries it once.
export function httpNode(name, position, { method = 'GET', url, headers = {}, query = false, body = method !== 'GET', write = false, runId = false, soft = false, timeout = 10000, responseFormat = null, retry = true }) {
  const allHeaders = { ...headers };
  if (write) allHeaders['Idempotency-Key'] = `={{ $json.idem_base }}:${name}`;
  if (write || runId) allHeaders['X-Run-Id'] = '={{ $execution.id }}';
  const options = { timeout };
  if (responseFormat) options.response = { response: { responseFormat, ...(responseFormat === 'file' ? { outputPropertyName: 'data' } : {}) } };
  const parameters = { method, url: `=${url}`, authentication: 'none' };
  if (query) Object.assign(parameters, { sendQuery: true, specifyQuery: 'json', jsonQuery: '={{ JSON.stringify($json.req.query) }}' });
  if (Object.keys(allHeaders).length) {
    Object.assign(parameters, { sendHeaders: true, specifyHeaders: 'keypair', headerParameters: { parameters: Object.entries(allHeaders).map(([key, value]) => ({ name: key, value })) } });
  }
  if (body) Object.assign(parameters, { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: typeof body === 'string' ? body : '={{ JSON.stringify($json.req.body) }}' });
  parameters.options = options;
  return {
    name, type: 'n8n-nodes-base.httpRequest', typeVersion: NODE_VERSIONS.httpRequest, position, parameters,
    ...(retry ? { retryOnFail: true, maxTries: 4, waitBetweenTries: 5000 } : { retryOnFail: false }),
    onError: soft ? 'continueErrorOutput' : 'stopWorkflow',
  };
}

const booleanCondition = (expression, seed) => ({
  options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
  conditions: [{ id: uuid(`cond/${seed}`), leftValue: `={{ ${expression} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
  combinator: 'and',
});

// Output 0 = true, output 1 = false. The expression must evaluate to a boolean.
export function ifNode(name, position, expression) {
  return { name, type: 'n8n-nodes-base.if', typeVersion: NODE_VERSIONS.if, position, parameters: { conditions: booleanCondition(expression, name), looseTypeValidation: false, options: {} } };
}

// One output per value, in order; the expression must evaluate to one of them (anything else fails the run).
export function switchNode(name, position, expression, values) {
  return {
    name, type: 'n8n-nodes-base.switch', typeVersion: NODE_VERSIONS.switch, position,
    parameters: {
      mode: 'rules',
      rules: {
        values: values.map(value => ({
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{ id: uuid(`switch/${name}/${value}`), leftValue: `={{ ${expression} }}`, rightValue: value, operator: { type: 'string', operation: 'equals' } }],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: value,
        })),
      },
      looseTypeValidation: false,
      options: { fallbackOutput: 'none' },
    },
  };
}

export function respondNode(name, position, bodyExpression, statusCode, responseHeaders = null) {
  const options = { responseCode: statusCode };
  if (responseHeaders) options.responseHeaders = { entries: Object.entries(responseHeaders).map(([header, value]) => ({ name: header, value })) };
  return {
    name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: NODE_VERSIONS.respondToWebhook, position,
    parameters: { respondWith: 'json', responseBody: `={{ ${bodyExpression} }}`, options },
  };
}

// interval: one n8n Schedule Trigger rule, for example { field: 'minutes', minutesInterval: 15 }.
export function scheduleNode(name, position, interval) {
  return { name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: NODE_VERSIONS.scheduleTrigger, position, parameters: { rule: { interval: [interval] } } };
}

// Waits in the run (n8n keeps a wait under 65 s in memory). seconds: a number (n8n-mcp's strict profile refuses an
// expression for the Wait node's amount).
export function waitNode(name, position, seconds) {
  return { name, type: 'n8n-nodes-base.wait', typeVersion: NODE_VERSIONS.wait, position, webhookId: uuid(`wait/${name}`), parameters: { resume: 'timeInterval', amount: seconds, unit: 'seconds' } };
}

export function errorTriggerNode(name, position) {
  return { name, type: 'n8n-nodes-base.errorTrigger', typeVersion: NODE_VERSIONS.errorTrigger, position, parameters: {} };
}
