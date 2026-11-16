// The kit's data service plus the calls invoicing needs. They share the data module's state (same module name,
// so the same tables), and the kit file is not changed:
//
//   POST  /data/v1/sequences/:name/next   { key }                     -> { value, outcome: allocated | existing, row }
//   PATCH /data/v1/rows/:table/:id        { expect?, set?, stamp?, guard? }
//                                         -> { outcome: changed | unchanged | conflict, row, changed } | 409 | 404
//   POST  /data/v1/rows/:table/guarded    { row, guard? }             -> 201 { outcome: stored, row } | 200 { outcome: conflict } | 409
//
// The sequence is gap-free by construction: one value per key, the next value is max + 1, allocated in one step
// (Postgres: an advisory lock per sequence name inside the insert transaction, see SPEC.md). The same key always
// gets the same value back, so a retry or a replay never takes a second number.
//
// The update is a compare-and-set: every `expect` field must hold its value (or one of the listed values) or the
// answer is 409 with the current row. If every `set` field already has its value (and every `stamp` column is
// already filled) the answer is 200 changed:false, which makes a replayed update a no-op. `stamp` fills the listed
// columns with the service's own clock, only while they are empty (coalesce), so a write body never carries a time.
// Writes keep a history (who changed what, when) on the row.
//
// The guard serializes every write that changes an invoice's money state (a payment or refund row, a void): it
// names a counter column (invoices.money_seq) and the value the caller read before deciding. The write is applied
// only if the counter still has that value, and the counter moves on by one in the same step; otherwise nothing is
// written and the answer is 200 { outcome: conflict } (not an HTTP error, so n8n does not retry the same stale
// request: the workflow reads again and decides again). One step here is one statement in Postgres (SPEC.md).
import { BASE_TABLES, dataService } from '../../_shared/lib/data-service.mjs';
import { bearer } from '../../_shared/lib/standin.mjs';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isEmpty = value => value === undefined || value === null;

export function billingDataService({ token, tables, config, seed = {}, clock = () => Date.now(), prefix = '/data' }) {
  const base = dataService({ token, tables, config, clock, prefix });
  const auth = bearer(token);
  const iso = () => new Date(clock()).toISOString();
  const runOf = req => req.headers['x-run-id'] ?? null;
  const schema = { ...BASE_TABLES, ...tables };
  const columnsOf = name => schema[name]?.columns ?? null;
  const baseInit = base.init;
  const touch = (row, req, changedColumns) => {
    const at = iso();
    Object.assign(row, { updated_at: at, updated_by_run: runOf(req) });
    row.history = [...(row.history ?? []), { at, run: runOf(req), set: changedColumns }];
  };
  // A guard { column, expect }: the counter must be a whole number equal to expect. A missing counter is a
  // mismatch, as it would be against a NOT NULL column in a database (never treated as 0).
  const guardHolds = (row, guard) => Number.isSafeInteger(row[guard.column]) && row[guard.column] === guard.expect;
  const badGuard = guard => !guard || typeof guard !== 'object' || typeof guard.column !== 'string' || !Number.isSafeInteger(guard.expect);

  return {
    ...base,
    // Seed rows (the client list) are part of the service's state from the start.
    init: () => {
      const s = baseInit();
      for (const [table, rows] of Object.entries(seed)) for (const row of rows) s.tables[table].push({ id: `${table.replace(/s$/, '')}_${String(s.nextId++).padStart(4, '0')}`, ...row, created_at: '2026-10-01T00:00:00.000Z', created_by_run: 'seed' });
      return s;
    },
    routes: [
      ...base.routes,
      {
        method: 'POST', path: `${prefix}/v1/sequences/:name/next`, op: 'data.sequence_next', idempotency: 'none', auth,
        handle: (req, s) => {
          const name = req.params.name;
          const key = req.body?.key;
          if (!/^[a-z0-9-]{1,40}$/.test(name) || typeof key !== 'string' || !key || !runOf(req)) return { status: 400, body: { error: 'a sequence name, a key and X-Run-Id are required' } };
          const rows = s.tables.invoice_numbers;
          const existing = rows.find(row => row.sequence === name && row.key === key);
          if (existing) return { status: 200, body: { value: existing.value, outcome: 'existing', row: existing }, log: { outcome: 'existing', value: existing.value } };
          const value = rows.filter(row => row.sequence === name).reduce((max, row) => Math.max(max, row.value), 0) + 1;
          const row = { id: `invoice_number_${String(s.nextId++).padStart(4, '0')}`, sequence: name, value, key, created_at: iso(), created_by_run: runOf(req) };
          rows.push(row);
          return { status: 200, body: { value, outcome: 'allocated', row }, log: { outcome: 'allocated', value } };
        },
      },
      {
        method: 'PATCH', path: `${prefix}/v1/rows/:table/:id`, op: req => `data.update.${req.params.table}`, idempotency: 'honor', auth,
        handle: (req, s) => {
          const columns = columnsOf(req.params.table);
          if (!columns) return { status: 404, body: { error: 'unknown table' } };
          const row = s.tables[req.params.table].find(candidate => candidate.id === req.params.id);
          if (!row) return { status: 404, body: { error: 'no such row' } };
          const { set = {}, expect = {}, stamp = [], guard = null } = req.body ?? {};
          if (!set || typeof set !== 'object' || Array.isArray(set) || !Array.isArray(stamp) || (!Object.keys(set).length && !stamp.length)) return { status: 400, body: { error: 'body must be { set?: {...}, stamp?: [column], expect?: {...}, guard?: { column, expect } } with set or stamp' } };
          if (guard !== null && badGuard(guard)) return { status: 400, body: { error: 'guard must be { column, expect: integer }' } };
          const named = [...Object.keys(set), ...Object.keys(expect), ...stamp, ...(guard ? [guard.column] : [])];
          const unknown = named.filter(column => !columns.includes(column));
          if (unknown.length) return { status: 400, body: { error: `unknown column(s): ${unknown.join(', ')}` } };
          if (guard && guard.column in set) return { status: 400, body: { error: 'the guard column is moved on by the service, not set' } };
          if (guard && !guardHolds(row, guard)) return { status: 200, body: { outcome: 'conflict', changed: false, guard: { column: guard.column, expected: guard.expect, current: row[guard.column] ?? null }, row }, log: { outcome: 'guard_conflict' } };
          const toStamp = stamp.filter(column => isEmpty(row[column]));
          if (!guard && !toStamp.length && Object.entries(set).every(([column, value]) => same(row[column], value))) return { status: 200, body: { outcome: 'unchanged', row, changed: false }, log: { outcome: 'unchanged' } };
          const failed = Object.entries(expect).filter(([column, wanted]) => (Array.isArray(wanted) ? !wanted.some(value => same(row[column], value)) : !same(row[column], wanted)));
          if (failed.length) return { status: 409, body: { error: 'conflict', columns: failed.map(([column]) => column), row }, log: { outcome: 'conflict' } };
          const at = iso();
          Object.assign(row, set);
          for (const column of toStamp) row[column] = at;
          if (guard) row[guard.column] += 1;
          touch(row, req, [...Object.keys(set), ...toStamp, ...(guard ? [guard.column] : [])]);
          return { status: 200, body: { outcome: 'changed', row, changed: true }, log: { outcome: guard ? `changed_${guard.column}_${row[guard.column]}` : 'changed' } };
        },
      },
      {
        method: 'POST', path: `${prefix}/v1/rows/:table/guarded`, op: req => `data.insert.${req.params.table}`, idempotency: 'honor', auth,
        handle: (req, s) => {
          const table = schema[req.params.table];
          if (!table) return { status: 404, body: { error: 'unknown table' } };
          const { row, guard = null } = req.body ?? {};
          if (!row || typeof row !== 'object' || Array.isArray(row)) return { status: 400, body: { error: 'body must be { row: {...}, guard?: { table, id, column, expect } }' } };
          const unknown = Object.keys(row).filter(column => !table.columns.includes(column));
          if (unknown.length) return { status: 400, body: { error: `unknown column(s): ${unknown.join(', ')}` } };
          let holder = null;
          if (guard !== null) {
            if (badGuard(guard) || typeof guard.table !== 'string' || typeof guard.id !== 'string' || !columnsOf(guard.table)?.includes(guard.column)) return { status: 400, body: { error: 'guard must be { table, id, column, expect: integer } on a known column' } };
            if (guard.column in row || !table.columns.includes(guard.column)) return { status: 400, body: { error: `the row records ${guard.column} itself, from the guard` } };
            holder = s.tables[guard.table].find(candidate => candidate.id === guard.id);
            if (!holder) return { status: 404, body: { error: `no ${guard.table} row ${guard.id}` } };
            // The guard first: in Postgres the counter update finds no row and the insert never runs.
            if (!guardHolds(holder, guard)) return { status: 200, body: { outcome: 'conflict', guard: { table: guard.table, id: guard.id, column: guard.column, expected: guard.expect, current: holder[guard.column] ?? null } }, log: { outcome: 'guard_conflict' } };
          }
          for (const columns of table.unique ?? []) {
            const existing = s.tables[req.params.table].find(candidate => columns.every(column => String(candidate[column]) === String(row[column])));
            if (existing) return { status: 409, body: { error: 'unique_violation', columns, existing_id: existing.id } };
          }
          const stored = { id: `${req.params.table.replace(/s$/, '')}_${String(s.nextId++).padStart(4, '0')}`, ...row, created_at: iso(), created_by_run: runOf(req) };
          if (holder) {
            holder[guard.column] += 1;
            touch(holder, req, [guard.column]);
            stored[guard.column] = holder[guard.column];
          }
          s.tables[req.params.table].push(stored);
          return { status: 201, body: { outcome: 'stored', row: stored }, log: { outcome: holder ? `stored_${guard.column}_${holder[guard.column]}` : 'stored_unguarded' } };
        },
      },
    ],
  };
}
