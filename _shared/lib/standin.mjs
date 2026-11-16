// Stand-in server framework: one local HTTP server that answers for the vendor APIs and the data service a
// workflow calls during tests. Modules contribute routes; the framework adds what every module needs:
//   - a request log (op, method, path, query, body, status, fault, Idempotency-Key, X-Run-Id, body hash)
//   - fault injection per op (status, delay, after-commit, malformed body), consumed in order
//   - Idempotency-Key replay for routes that honor it: same key + same body = the first answer again;
//     same key + different body = 422 (never a silent replay)
//   - control routes for tools that are not in-process: GET /__log, GET /__state, POST /__control, POST /__reset
// Zero dependencies. Binds 127.0.0.1 by default.
//
// Module shape:
//   { name, init() -> moduleState, view(moduleState) -> JSON for /__state, routes: [route] }
// Route shape:
//   { method, path, op, idempotency, auth(req) -> boolean, handle(req, moduleState, ctx) -> answer }
//   op: a name for the log and for faults, or a function of the request (for example one op per table)
//   path: '/data/v1/rows/:table', '/telegram/bot:token/getFile', '/telegram/file/bot:token/:path*'
//   idempotency: 'honor' (writes; the key is required and replayed), 'ignore' (the vendor has no such
//                feature: the key is logged, never replayed), 'none' (state-changing but not keyed, e.g. a
//                ledger that is the dedupe authority itself), or undefined for reads
//   answer: { status, body } (JSON), or { status, raw: Buffer, contentType }, plus optional headers
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function compilePath(pattern) {
  const names = [];
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)(\*)?/g, (_, name, rest) => {
    names.push(name);
    return rest ? '(.+)' : '([^/]+)';
  });
  const regex = new RegExp(`^${source}$`);
  return path => {
    const match = regex.exec(path);
    if (!match) return null;
    return Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
  };
}

// Long strings (base64 images, large prompts) are logged as a length and a hash, not their content.
function compactForLog(value, limit = 2000) {
  if (typeof value === 'string') return value.length > limit ? `<${value.length} chars sha256:${sha256(value).slice(0, 16)}>` : value;
  if (Array.isArray(value)) return value.map(item => compactForLog(item, limit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactForLog(item, limit)]));
  return value;
}

// redact: [[RegExp, replacement]] applied to logged paths (for example a bot token inside a URL path).
// A route with the same method and path as an earlier one replaces it: a workflow that extends a kit module (for
// example the data service, with ...base.routes first and its own after) keeps its own version of a call.
export async function startStandin({ modules, host = '127.0.0.1', port = 0, redact = [] } = {}) {
  const declared = modules.flatMap(module => module.routes.map(route => ({ ...route, module: module.name, match: compilePath(route.path) })));
  const routes = declared.filter((route, i) => !declared.slice(i + 1).some(later => later.method === route.method && later.path === route.path));
  const state = {};
  const reset = () => {
    state.log = [];
    state.faults = [];
    state.idem = new Map();
    state.seq = 0;
    state.modules = Object.fromEntries(modules.map(module => [module.name, module.init ? module.init() : {}]));
  };
  reset();
  const redactPath = path => redact.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), path);

  // faults: [{ op, status?, times = 1, delay_ms?, after_commit?, malformed?, body?, headers? }]
  //   status set:      the call is refused with that status and nothing is committed (unless after_commit)
  //   status not set:  the call is answered normally (and committed), after delay_ms: a slow answer
  const control = (input = {}) => {
    for (const fault of input.faults ?? []) state.faults.push({ ...fault, remaining: fault.times ?? 1 });
    for (const module of modules) if (module.control && input[module.name] !== undefined) module.control(state.modules[module.name], input[module.name]);
    return { ok: true, faults: state.faults.filter(fault => fault.remaining > 0).length };
  };
  const takeFault = op => {
    const fault = state.faults.find(item => item.op === op && item.remaining > 0);
    if (fault) fault.remaining -= 1;
    return fault ?? null;
  };
  const view = () => Object.fromEntries(modules.map(module => [module.name, module.view ? clone(module.view(state.modules[module.name])) : null]));

  async function dispatch(req, raw) {
    const url = new URL(req.url, 'http://standin.local');
    const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), value]));
    let body = null;
    const isJson = raw.length > 0 && !/^multipart\//.test(headers['content-type'] ?? '');
    if (isJson) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = { _unparsed: raw.toString('utf8').slice(0, 200) }; } }
    const path = url.pathname;
    let params = null;
    const route = routes.find(candidate => candidate.method === req.method && (params = candidate.match(path)));
    const request = { method: req.method, path, params: params ?? {}, query: Object.fromEntries(url.searchParams), body, raw, headers };
    const key = headers['idempotency-key'] ?? null;
    const op = !route ? 'unknown' : typeof route.op === 'function' ? route.op(request) : route.op;
    const entry = {
      seq: state.seq++, at_ms: Date.now(), op, method: req.method, path: redactPath(path),
      query: request.query, body: compactForLog(body), status: null, fault: null, idempotency_key: key,
      run_id: headers['x-run-id'] ?? null, raw_sha256: raw.length ? sha256(raw) : null,
    };
    state.log.push(entry);
    if (!route) {
      entry.status = 404; entry.fault = 'unknown_route';
      return { status: 404, body: { error: `stand-in: no route for ${req.method} ${redactPath(path)}` } };
    }
    if (route.auth && !route.auth(request)) {
      entry.status = 401; entry.fault = 'unauthorized';
      return { status: 401, body: { error: 'stand-in: missing or wrong credentials' } };
    }
    const moduleState = state.modules[route.module];
    const fault = takeFault(op);
    const refuses = fault && fault.status !== undefined && !fault.after_commit;
    let answer;
    if (refuses) {
      answer = { status: fault.status, body: fault.body ?? { error: `stand-in injected ${fault.status}` }, headers: fault.headers };
      entry.fault = `injected_${fault.status}`;
    } else if (route.idempotency === 'honor') {
      if (!key) {
        answer = { status: 400, body: { error: 'stand-in: Idempotency-Key header is required on this write' } };
        entry.fault = 'missing_idempotency_key';
      } else {
        const slot = `${op}|${key}`;
        const earlier = state.idem.get(slot);
        if (earlier && earlier.raw_sha256 !== entry.raw_sha256) {
          answer = { status: 422, body: { error: 'stand-in: Idempotency-Key reused with a different request body' } };
          entry.fault = 'idempotency_key_body_mismatch';
        } else if (earlier) {
          answer = clone(earlier.answer);
          entry.idempotent_replay = true;
        } else {
          answer = await route.handle(request, moduleState, { entry });
          if (answer.status < 500) state.idem.set(slot, { raw_sha256: entry.raw_sha256, answer: clone(answer) });
        }
      }
    } else {
      answer = await route.handle(request, moduleState, { entry });
    }
    if (fault && fault.after_commit && fault.status !== undefined) {
      entry.fault = 'injected_after_commit';
      answer = { status: fault.status, body: fault.body ?? { error: `stand-in injected ${fault.status} after commit` } };
    }
    if (fault && !entry.fault && fault.delay_ms) entry.fault = `delayed_${fault.delay_ms}ms`;
    entry.status = answer.status;
    if (answer.log) Object.assign(entry, answer.log);
    return { ...answer, delayMs: fault?.delay_ms ?? 0, malformed: Boolean(fault?.malformed) };
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const send = (status, payload, extraHeaders = {}, contentType = 'application/json') => {
        if (res.writableEnded || res.destroyed) return;
        try {
          res.writeHead(status, { 'content-type': contentType, ...extraHeaders });
          res.end(payload);
        } catch { /* the client went away (a timeout on its side) */ }
      };
      const url = new URL(req.url, 'http://standin.local');
      if (url.pathname.startsWith('/__')) {
        if (url.pathname === '/__log') return send(200, JSON.stringify(state.log));
        if (url.pathname === '/__state') return send(200, JSON.stringify(view()));
        if (url.pathname === '/__reset' && req.method === 'POST') { reset(); return send(200, '{"ok":true}'); }
        if (url.pathname === '/__control' && req.method === 'POST') return send(200, JSON.stringify(control(raw.length ? JSON.parse(raw.toString('utf8')) : {})));
        return send(404, '{"error":"unknown control route"}');
      }
      let answer;
      try {
        answer = await dispatch(req, raw);
      } catch (error) {
        answer = { status: 500, body: { error: `stand-in crashed: ${error.message}` } };
      }
      if (answer.delayMs) await new Promise(resolve => setTimeout(resolve, answer.delayMs));
      if (answer.malformed) return send(200, '{"truncated": ');
      if (answer.raw) return send(answer.status, answer.raw, answer.headers ?? {}, answer.contentType ?? 'application/octet-stream');
      return send(answer.status, JSON.stringify(answer.body ?? null), answer.headers ?? {});
    });
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    log: () => clone(state.log),
    state: () => view(),
    moduleState: name => state.modules[name],
    control,
    reset,
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}

// Helpers for assertions on a request log.
export const opsOf = (log, filter = () => true) => log.filter(filter).map(entry => entry.op);
export const callsTo = (log, op) => log.filter(entry => entry.op === op);
export const bearer = token => req => req.headers.authorization === `Bearer ${token}`;
