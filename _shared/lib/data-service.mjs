// Stand-in for the CRIT data service: the small HTTP service that owns every workflow's persistent state.
// n8n passes ids, not content; rows, the idempotency ledger, dead letters and per-workflow config live here.
// The API is shaped so a Postgres-backed service can replace this file without touching a workflow:
//
//   GET  /data/v1/config/:name                    one config document (table workflow_config)
//   POST /data/v1/ledger/claim                    { scope, key, payload?, ttl_seconds?, redelivers? }
//                                                 -> { outcome: claimed | in_flight | done, entry }
//                                                 ttl_seconds: 60 to 7200 (default 600), stored with the claim; an
//                                                 in-flight claim older than its own ttl_seconds is stale and taken over.
//                                                 redelivers: false says the sender never sends this event again (stored
//                                                 only when given; the error workflow's alert says so)
//   POST /data/v1/ledger/complete                 { scope, key, outcome, result? }  -> { entry }   (only the holder's run id)
//   POST /data/v1/ledger/fail                     { run_id, error }                 -> { released: [entry] }
//   GET  /data/v1/ledger?scope=&state=&before=&include_payload=   claims, oldest first -> { entries }  (op data.ledger_list)
//   GET  /data/v1/rows/:table?col=value&...       exact-match filter                -> { rows }            (op data.find.<table>)
//   POST /data/v1/rows/:table                     { row }                           -> 201 { row } | 409    (op data.insert.<table>)
//   PATCH /data/v1/rows/:table/:id                { set, expect? }  compare-and-set -> { row, changed } | 409 conflict | 404
//                                                                                                       (op data.update.<table>)
//   POST /data/v1/rows/:table/next                { row, column, scope?, key?, start? }  sequence insert
//                                                 -> 201 { row, value, outcome: allocated } | 200 { ..., outcome: existing }
//                                                                                                       (op data.next.<table>)
//
// Every call carries Authorization: Bearer <DATA_SERVICE_TOKEN>. Writes carry X-Run-Id (recorded as
// created_by_run / run_id); row inserts also carry Idempotency-Key (the framework replays a repeat). Ledger
// calls are idempotent on (scope, key, run id) by design and are not keyed: the ledger is the dedupe authority.
// Table shapes for a Postgres version are in the kit guide (KIT.md, "Data service").
import { bearer } from './standin.mjs';

const IN_FLIGHT_STALE_MS = 10 * 60 * 1000;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Every workflow gets the dead-letter table.
export const BASE_TABLES = {
  dead_letters: {
    columns: ['source', 'workflow', 'reason', 'payload_sha256', 'payload'],
    unique: [['workflow', 'payload_sha256']],
  },
};

// tables: { name: { columns: [...], unique: [[col, ...], ...] } }   config: { name: document }
// clock: injectable for stale-claim tests.
export function dataService({ token, tables = {}, config = {}, prefix = '/data', clock = () => Date.now(), staleMs = IN_FLIGHT_STALE_MS } = {}) {
  const schema = { ...BASE_TABLES, ...tables };
  const auth = bearer(token);
  const iso = () => new Date(clock()).toISOString();
  const runOf = req => req.headers['x-run-id'] ?? null;
  const bad = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

  return {
    name: 'data',
    init: () => ({ tables: Object.fromEntries(Object.keys(schema).map(name => [name, []])), ledger: new Map(), config: JSON.parse(JSON.stringify(config)), nextId: 1 }),
    view: s => ({ tables: s.tables, ledger: [...s.ledger.values()], config: s.config }),
    // control: { config: { name: {...partial} }, rows: { table: [row] }, ledger: [entry] } seeds state for a scenario.
    // A seeded ledger entry needs scope, key and state; claimed_at (ISO) defaults to now, run_id to 'seed'.
    control: (s, input) => {
      for (const [name, doc] of Object.entries(input.config ?? {})) s.config[name] = { ...(s.config[name] ?? {}), ...doc };
      for (const [table, rows] of Object.entries(input.rows ?? {})) for (const row of rows) s.tables[table].push({ id: `${table}_${s.nextId++}`, ...row });
      for (const seeded of input.ledger ?? []) {
        const claimedAt = seeded.claimed_at ?? iso();
        const entry = { scope: seeded.scope, key: String(seeded.key), state: seeded.state ?? 'in_flight', run_id: seeded.run_id ?? 'seed', attempts: seeded.attempts ?? 1, payload: seeded.payload ?? null, ttl_seconds: seeded.ttl_seconds ?? Math.round(staleMs / 1000), claimed_at: claimedAt, claimed_ms: Date.parse(claimedAt), outcome: seeded.outcome ?? null, result: seeded.result ?? null, error: seeded.error ?? null };
        for (const extra of ['failed_at', 'completed_at', 'redelivers']) if (seeded[extra] !== undefined) entry[extra] = seeded[extra];
        s.ledger.set(`${entry.scope}:${entry.key}`, entry);
      }
    },
    routes: [
      {
        method: 'GET', path: `${prefix}/v1/config/:name`, op: 'data.get_config', auth,
        handle: (req, s) => (s.config[req.params.name] ? { status: 200, body: { name: req.params.name, config: s.config[req.params.name] } } : bad(404, 'unknown config')),
      },
      {
        method: 'POST', path: `${prefix}/v1/ledger/claim`, op: 'data.ledger_claim', idempotency: 'none', auth,
        handle: (req, s) => {
          const { scope, key, payload = null, ttl_seconds: ttlSeconds, redelivers } = req.body ?? {};
          const run = runOf(req);
          if (typeof scope !== 'string' || !scope || (typeof key !== 'string' && typeof key !== 'number') || !run) return bad(400, 'scope, key and X-Run-Id are required');
          if (ttlSeconds !== undefined && !(Number.isInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 7200)) return bad(400, 'ttl_seconds must be a whole number from 60 to 7200');
          if (redelivers !== undefined && typeof redelivers !== 'boolean') return bad(400, 'redelivers must be true or false');
          // The claim's lifetime: ttl_seconds when given (stored with the claim), else the default (600 s).
          const ttl = ttlSeconds ?? Math.round(staleMs / 1000);
          const id = `${scope}:${key}`;
          const entry = s.ledger.get(id);
          const now = clock();
          if (!entry) {
            const fresh = { scope, key: String(key), state: 'in_flight', run_id: run, attempts: 1, payload, ttl_seconds: ttl, claimed_at: iso(), claimed_ms: now, outcome: null, result: null, error: null };
            if (redelivers !== undefined) fresh.redelivers = redelivers;
            s.ledger.set(id, fresh);
            return { status: 200, body: { outcome: 'claimed', entry: publicEntry(fresh) }, log: { outcome: 'claimed' } };
          }
          if (entry.state === 'done') return { status: 200, body: { outcome: 'done', entry: publicEntry(entry) }, log: { outcome: 'done' } };
          // A retry of the claim call by the same run (its first answer was lost) is the same claim.
          if (entry.state === 'in_flight' && entry.run_id === run) return { status: 200, body: { outcome: 'claimed', entry: publicEntry(entry) }, log: { outcome: 'claimed' } };
          if (entry.state === 'in_flight' && now - entry.claimed_ms < (entry.ttl_seconds ?? Math.round(staleMs / 1000)) * 1000) return { status: 200, body: { outcome: 'in_flight', entry: publicEntry(entry) }, log: { outcome: 'in_flight' } };
          // failed, or in flight past the holder's ttl_seconds (the run died without reporting): take it over.
          const reason = entry.state === 'failed' ? 'after_failure' : 'stale_claim';
          Object.assign(entry, { state: 'in_flight', run_id: run, attempts: entry.attempts + 1, ttl_seconds: ttl, claimed_at: iso(), claimed_ms: now, reclaimed: reason, payload: payload ?? entry.payload });
          if (redelivers !== undefined) entry.redelivers = redelivers;
          return { status: 200, body: { outcome: 'claimed', reclaimed: reason, entry: publicEntry(entry) }, log: { outcome: `claimed_${reason}` } };
        },
      },
      {
        method: 'POST', path: `${prefix}/v1/ledger/complete`, op: 'data.ledger_complete', idempotency: 'none', auth,
        handle: (req, s) => {
          const { scope, key, outcome, result = null } = req.body ?? {};
          const entry = s.ledger.get(`${scope}:${key}`);
          if (!entry) return bad(404, 'no such claim');
          if (entry.run_id !== runOf(req)) return bad(409, 'claim is held by another run', { held_by: entry.run_id });
          if (entry.state === 'done') return { status: 200, body: { entry: publicEntry(entry) } };
          Object.assign(entry, { state: 'done', outcome: outcome ?? null, result, completed_at: iso() });
          return { status: 200, body: { entry: publicEntry(entry) } };
        },
      },
      {
        method: 'POST', path: `${prefix}/v1/ledger/fail`, op: 'data.ledger_fail', idempotency: 'none', auth,
        handle: (req, s) => {
          const { run_id: failedRun, error = null } = req.body ?? {};
          if (!failedRun) return bad(400, 'run_id is required');
          const released = [];
          for (const entry of s.ledger.values()) {
            if (entry.state === 'in_flight' && entry.run_id === String(failedRun)) {
              Object.assign(entry, { state: 'failed', failed_at: iso(), error: typeof error === 'string' ? error.slice(0, 500) : null, released_by_run: runOf(req) });
              released.push(publicEntry(entry));
            }
          }
          return { status: 200, body: { released } };
        },
      },
      {
        // For watchdogs and replay tools. state: one state or a comma list; before: ISO time, keeps entries whose
        // latest change (failed_at, else claimed_at) is older; include_payload=true adds the stored payload.
        method: 'GET', path: `${prefix}/v1/ledger`, op: 'data.ledger_list', auth,
        handle: (req, s) => {
          const { scope, state, before, key, include_payload: withPayload } = req.query;
          const states = state ? state.split(',') : null;
          if (states && states.some(item => !['in_flight', 'done', 'failed'].includes(item))) return bad(400, 'state must be in_flight, done or failed (or a comma list)');
          const beforeMs = before === undefined ? null : Date.parse(before);
          if (before !== undefined && !Number.isFinite(beforeMs)) return bad(400, 'before must be an ISO time');
          const changedMs = entry => Date.parse(entry.failed_at ?? entry.claimed_at);
          const entries = [...s.ledger.values()]
            .filter(entry => (!scope || entry.scope === scope) && (!key || entry.key === key) && (!states || states.includes(entry.state)) && (beforeMs === null || changedMs(entry) < beforeMs))
            .sort((a, b) => changedMs(a) - changedMs(b))
            .map(entry => ({ ...publicEntry(entry), ...(withPayload === 'true' ? { payload: entry.payload } : {}) }));
          return { status: 200, body: { entries } };
        },
      },
      {
        method: 'GET', path: `${prefix}/v1/rows/:table`, op: req => `data.find.${req.params.table}`, auth,
        handle: (req, s) => {
          const rows = s.tables[req.params.table];
          if (!rows) return bad(404, 'unknown table');
          const filters = Object.entries(req.query);
          const unknown = filters.map(([column]) => column).filter(column => !['id', ...schema[req.params.table].columns].includes(column));
          if (unknown.length) return bad(400, `unknown column(s): ${unknown.join(', ')}`);
          return { status: 200, body: { rows: rows.filter(row => filters.every(([column, value]) => String(row[column]) === value)) } };
        },
      },
      {
        method: 'POST', path: `${prefix}/v1/rows/:table`, op: req => `data.insert.${req.params.table}`, idempotency: 'honor', auth,
        handle: (req, s) => {
          const table = schema[req.params.table];
          if (!table) return bad(404, 'unknown table');
          const row = req.body?.row;
          if (!row || typeof row !== 'object' || Array.isArray(row)) return bad(400, 'body must be { row: {...} }');
          const unknown = Object.keys(row).filter(column => !table.columns.includes(column));
          if (unknown.length) return bad(400, `unknown column(s): ${unknown.join(', ')}`);
          for (const columns of table.unique ?? []) {
            const holder = s.tables[req.params.table].find(existing => columns.every(column => String(existing[column]) === String(row[column])));
            if (holder) return { status: 409, body: { error: 'unique_violation', columns, existing_id: holder.id } };
          }
          const stored = { id: `${req.params.table.replace(/s$/, '')}_${String(s.nextId++).padStart(4, '0')}`, ...row, created_at: iso(), created_by_run: runOf(req) };
          s.tables[req.params.table].push(stored);
          return { status: 201, body: { row: stored } };
        },
      },
      {
        // Compare-and-set: every `expect` column must hold its value (or one of the listed values) or the answer is
        // 409 conflict with the current row. If every `set` column already holds its value the answer is 200
        // changed:false, so a replayed update is a no-op. The row keeps updated_at, updated_by_run and a history.
        method: 'PATCH', path: `${prefix}/v1/rows/:table/:id`, op: req => `data.update.${req.params.table}`, idempotency: 'honor', auth,
        handle: (req, s) => {
          const table = schema[req.params.table];
          if (!table) return bad(404, 'unknown table');
          const row = s.tables[req.params.table].find(candidate => candidate.id === req.params.id);
          if (!row) return bad(404, 'no such row');
          const { set, expect = {} } = req.body ?? {};
          if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length || !expect || typeof expect !== 'object' || Array.isArray(expect)) return bad(400, 'body must be { set: {...}, expect?: {...} }');
          const unknown = [...Object.keys(set), ...Object.keys(expect)].filter(column => !table.columns.includes(column));
          if (unknown.length) return bad(400, `unknown column(s): ${unknown.join(', ')}`);
          if (Object.entries(set).every(([column, value]) => same(row[column], value))) return { status: 200, body: { row, changed: false }, log: { outcome: 'unchanged' } };
          const failed = Object.entries(expect).filter(([column, wanted]) => (Array.isArray(wanted) ? !wanted.some(value => same(row[column], value)) : !same(row[column], wanted)));
          if (failed.length) return { status: 409, body: { error: 'conflict', columns: failed.map(([column]) => column), row }, log: { outcome: 'conflict' } };
          // Unique keys that this update touches, as Postgres checks them (a null never collides).
          const candidate = { ...row, ...set };
          for (const columns of (table.unique ?? []).filter(cols => cols.some(column => column in set) && cols.every(column => candidate[column] !== null && candidate[column] !== undefined))) {
            const holder = s.tables[req.params.table].find(existing => existing !== row && columns.every(column => String(existing[column]) === String(candidate[column])));
            if (holder) return { status: 409, body: { error: 'unique_violation', columns, existing_id: holder.id } };
          }
          const at = iso();
          Object.assign(row, set, { updated_at: at, updated_by_run: runOf(req) });
          row.history = [...(row.history ?? []), { at, run: runOf(req), set: Object.keys(set) }];
          return { status: 200, body: { row, changed: true }, log: { outcome: 'changed' } };
        },
      },
      {
        // Sequence insert (counters, numbering): row[column] = the largest value of `column` among the rows that share
        // the `scope` columns with `row`, plus one (`start` for the first). A row that already matches `row` on the
        // `key` columns is answered as it is (outcome existing), so a retry never takes a second number.
        method: 'POST', path: `${prefix}/v1/rows/:table/next`, op: req => `data.next.${req.params.table}`, idempotency: 'honor', auth,
        handle: (req, s) => {
          const table = schema[req.params.table];
          if (!table) return bad(404, 'unknown table');
          const { row, column, scope = [], key = [], start = 1 } = req.body ?? {};
          if (!row || typeof row !== 'object' || Array.isArray(row) || typeof column !== 'string' || !Array.isArray(scope) || !Array.isArray(key) || !Number.isInteger(start)) return bad(400, 'body must be { row: {...}, column, scope?: [...], key?: [...], start?: integer }');
          const unknown = [...Object.keys(row), column, ...scope, ...key].filter(name => !table.columns.includes(name));
          if (unknown.length) return bad(400, `unknown column(s): ${[...new Set(unknown)].join(', ')}`);
          if (column in row) return bad(400, `${column} is allocated by the service; leave it out of row`);
          const rows = s.tables[req.params.table];
          const inScope = rows.filter(existing => scope.every(name => String(existing[name]) === String(row[name])));
          if (key.length) {
            const existing = inScope.find(candidate => key.every(name => String(candidate[name]) === String(row[name])));
            if (existing) return { status: 200, body: { row: existing, value: existing[column], outcome: 'existing' }, log: { outcome: 'existing', value: existing[column] } };
          }
          const value = inScope.reduce((max, existing) => (Number.isFinite(Number(existing[column])) ? Math.max(max, Number(existing[column])) : max), start - 1) + 1;
          const candidate = { ...row, [column]: value };
          for (const columns of table.unique ?? []) {
            const holder = rows.find(existing => columns.every(name => String(existing[name]) === String(candidate[name])));
            if (holder) return { status: 409, body: { error: 'unique_violation', columns, existing_id: holder.id } };
          }
          const stored = { id: `${req.params.table.replace(/s$/, '')}_${String(s.nextId++).padStart(4, '0')}`, ...candidate, created_at: iso(), created_by_run: runOf(req) };
          rows.push(stored);
          return { status: 201, body: { row: stored, value, outcome: 'allocated' }, log: { outcome: 'allocated', value } };
        },
      },
    ],
  };
}

function publicEntry(entry) {
  const { claimed_ms: _ms, payload: _payload, ...rest } = entry;
  return rest;
}
