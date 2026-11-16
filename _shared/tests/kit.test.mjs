// Unit tests for the shared kit: stand-in framework, data service, model replay, lock, lint, builder, environment
// allowlist, module loader and the shared error workflow. No n8n, no network beyond 127.0.0.1.
//   node --test 'shared/tests/*.test.mjs'
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCodeNode } from '../lib/code-node.mjs';
import { dataService } from '../lib/data-service.mjs';
import { Flow, at, codeNode, httpNode, respondNode, scheduleNode, waitNode, webhookNode } from '../lib/flow.mjs';
import { freePort, neutralTmp } from '../lib/harness.mjs';
import { lintWorkflow } from '../lib/lint.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { modelReplay, ANTHROPIC_VERSION } from '../lib/model-replay.mjs';
import { createModules } from '../lib/modules.mjs';
import { buildN8nEnv } from '../lib/n8n-env.mjs';
import { slackAlerts } from '../lib/slack-alerts.mjs';
import { startStandin } from '../lib/standin.mjs';
import { build as buildErrorWorkflow } from '../error-workflow/build.mjs';

const kit = join(dirname(fileURLToPath(import.meta.url)), '..');
// Scratch folders are removed after the run even when a test fails.
const scratchDirs = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'crit-kit-test-')); scratchDirs.push(dir); return dir; };
after(() => { for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true }); });

async function withStandin(modules, fn, options = {}) {
  const standin = await startStandin({ modules, ...options });
  try { return await fn(standin, (path, init = {}) => fetch(`${standin.url}${path}`, init).then(async res => ({ status: res.status, json: await res.json().catch(() => null), headers: res.headers }))); } finally { await standin.close(); }
}
const post = (body, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const echo = { name: 'echo', init: () => ({ writes: 0 }), view: s => s, routes: [
  { method: 'POST', path: '/echo/write/:id', op: 'echo.write', idempotency: 'honor', handle: (req, s) => ({ status: 201, body: { id: req.params.id, n: ++s.writes } }) },
  { method: 'POST', path: '/echo/vendor', op: 'echo.vendor', idempotency: 'ignore', handle: (req, s) => ({ status: 200, body: { n: ++s.writes } }) },
  { method: 'GET', path: '/echo/file/bot:token/:path*', op: 'echo.file', auth: req => req.params.token === 'good', handle: req => ({ status: 200, raw: Buffer.from(req.params.path), contentType: 'text/plain' }) },
  { method: 'POST', path: '/echo/big', op: 'echo.big', handle: () => ({ status: 200, body: { ok: true } }) },
] };

// ------------------------------------------------------------------ stand-in framework

test('standin: Idempotency-Key replay, body mismatch 422, key required on honoring routes', () => withStandin([echo], async (standin, call) => {
  const first = await call('/echo/write/a', post({ x: 1 }, { 'idempotency-key': 'k1', 'x-run-id': '7' }));
  const again = await call('/echo/write/a', post({ x: 1 }, { 'idempotency-key': 'k1' }));
  const changed = await call('/echo/write/a', post({ x: 2 }, { 'idempotency-key': 'k1' }));
  const missing = await call('/echo/write/a', post({ x: 1 }));
  assert.deepEqual([first.status, first.json.n, again.json.n], [201, 1, 1]);
  assert.equal(changed.status, 422);
  assert.equal(missing.status, 400);
  assert.equal(standin.moduleState('echo').writes, 1);
  const log = standin.log();
  assert.equal(log[1].idempotent_replay, true);
  assert.deepEqual([log[0].idempotency_key, log[0].run_id], ['k1', '7']);
  assert.deepEqual([log[2].fault, log[3].fault], ['idempotency_key_body_mismatch', 'missing_idempotency_key']);
}));

test('standin: a vendor without idempotency logs the key and repeats the write', () => withStandin([echo], async (standin, call) => {
  await call('/echo/vendor', post({}, { 'idempotency-key': 'k' }));
  await call('/echo/vendor', post({}, { 'idempotency-key': 'k' }));
  assert.equal(standin.moduleState('echo').writes, 2);
}));

test('standin: faults by op, in order: refused, slow, after commit, malformed', () => withStandin([echo], async (standin, call) => {
  standin.control({ faults: [{ op: 'echo.write', status: 503, times: 2 }, { op: 'echo.vendor', delay_ms: 300 }, { op: 'echo.big', status: 504, after_commit: true }] });
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await call(`/echo/write/x${i}`, post({}, { 'idempotency-key': `k${i}` }))).status);
  assert.deepEqual(statuses, [503, 503, 201]);
  assert.equal(standin.moduleState('echo').writes, 1, 'refused calls commit nothing');
  const t0 = Date.now();
  assert.equal((await call('/echo/vendor', post({}))).status, 200);
  assert.ok(Date.now() - t0 >= 290);
  assert.equal((await call('/echo/big', post({}))).status, 504);
  assert.equal(standin.log().at(-1).fault, 'injected_after_commit');
  standin.control({ faults: [{ op: 'echo.big', malformed: true }] });
  const res = await fetch(`${standin.url}/echo/big`, post({}));
  assert.equal(await res.text(), '{"truncated": ');
}));

test('standin: path params with a token segment and a rest path, auth, raw answers, redaction, unknown routes', () => withStandin([echo], async (standin, call) => {
  const good = await fetch(`${standin.url}/echo/file/botgood/photos/a.jpg`);
  assert.equal(await good.text(), 'photos/a.jpg');
  assert.equal((await fetch(`${standin.url}/echo/file/botbad/x`)).status, 401);
  assert.equal((await call('/nope')).status, 404);
  assert.deepEqual(standin.log().map(e => e.path), ['/echo/file/bot<token>/photos/a.jpg', '/echo/file/bot<token>/x', '/nope']);
}, { redact: [[/\/bot[^/]+/g, '/bot<token>']] }));

test('standin: a later route with the same method and path replaces an earlier one (an extension keeps its own call)', async () => {
  const base = dataService({ token: 't', tables: { things: { columns: ['name'], unique: [] } } });
  const extended = { ...base, routes: [...base.routes, { method: 'PATCH', path: '/data/v1/rows/:table/:id', op: 'ext.update', idempotency: 'honor', handle: () => ({ status: 200, body: { from: 'extension' } }) }] };
  await withStandin([extended], async (standin, call) => {
    const res = await call('/data/v1/rows/things/thing_1', { method: 'PATCH', headers: { 'content-type': 'application/json', ...auth('1', 'k') }, body: JSON.stringify({ set: { name: 'x' } }) });
    assert.deepEqual([res.status, res.json, standin.log()[0].op], [200, { from: 'extension' }, 'ext.update']);
  });
});

test('standin: long strings are logged as a length and a hash', () => withStandin([echo], async (standin, call) => {
  await call('/echo/big', post({ image: 'A'.repeat(5000), short: 'ok' }));
  assert.match(standin.log()[0].body.image, /^<5000 chars sha256:[0-9a-f]{16}>$/);
  assert.equal(standin.log()[0].body.short, 'ok');
}));

// ------------------------------------------------------------------ data service

const ds = (clock = () => Date.now()) => dataService({ token: 't', clock, tables: { things: { columns: ['name', 'kind'], unique: [['name']] } }, config: { demo: { threshold: 0.8 } } });
const auth = (run, key) => ({ authorization: 'Bearer t', ...(run ? { 'x-run-id': run } : {}), ...(key ? { 'idempotency-key': key } : {}) });

test('data service: auth, config, rows (unique, unknown column, unknown table, filter), per-table ops', () => withStandin([ds()], async (standin, call) => {
  assert.equal((await call('/data/v1/config/demo')).status, 401);
  assert.deepEqual((await call('/data/v1/config/demo', { headers: auth() })).json.config, { threshold: 0.8 });
  assert.equal((await call('/data/v1/config/none', { headers: auth() })).status, 404);
  const created = await call('/data/v1/rows/things', post({ row: { name: 'a', kind: 'x' } }, auth('11', 'k1')));
  assert.equal(created.status, 201);
  assert.equal(created.json.row.created_by_run, '11');
  assert.equal((await call('/data/v1/rows/things', post({ row: { name: 'a', kind: 'y' } }, auth('12', 'k2')))).status, 409);
  assert.equal((await call('/data/v1/rows/things', post({ row: { name: 'b', color: 'red' } }, auth('12', 'k3')))).status, 400);
  assert.equal((await call('/data/v1/rows/nothing', post({ row: {} }, auth('12', 'k4')))).status, 404);
  assert.equal((await call('/data/v1/rows/dead_letters', post({ row: { source: 's', workflow: 'w', reason: 'r', payload_sha256: 'h', payload: {} } }, auth('12', 'k5')))).status, 201);
  assert.equal((await call('/data/v1/rows/things?name=a', { headers: auth() })).json.rows.length, 1);
  assert.equal((await call('/data/v1/rows/things?color=a', { headers: auth() })).status, 400);
  assert.deepEqual(standin.log().map(e => e.op).slice(3, 6), ['data.insert.things', 'data.insert.things', 'data.insert.things']);
}));

test('data service ledger: claim, same-run retry, in flight, done, fail and reclaim, stale reclaim, holder-only complete', async () => {
  let now = 1_000_000;
  await withStandin([ds(() => now)], async (standin, call) => {
    const claim = (run, key = '1') => call('/data/v1/ledger/claim', post({ scope: 's', key, payload: { raw: true } }, auth(run))).then(r => r.json.outcome);
    assert.equal(await claim('10'), 'claimed');
    assert.equal(await claim('10'), 'claimed', 'a retried claim call by the same run');
    assert.equal(await claim('11'), 'in_flight');
    assert.equal((await call('/data/v1/ledger/complete', post({ scope: 's', key: '1', outcome: 'x' }, auth('11')))).status, 409);
    assert.equal((await call('/data/v1/ledger/complete', post({ scope: 's', key: '1', outcome: 'recorded', result: { id: 1 } }, auth('10')))).status, 200);
    assert.equal(await claim('12'), 'done');
    assert.equal(await claim('20', '2'), 'claimed');
    const released = await call('/data/v1/ledger/fail', post({ run_id: '20', error: 'boom' }, auth('99')));
    assert.deepEqual(released.json.released.map(e => [e.key, e.state]), [['2', 'failed']]);
    const retaken = await call('/data/v1/ledger/claim', post({ scope: 's', key: '2' }, auth('21')));
    assert.deepEqual([retaken.json.outcome, retaken.json.reclaimed, retaken.json.entry.attempts], ['claimed', 'after_failure', 2]);
    assert.equal(standin.moduleState('data').ledger.get('s:2').payload.raw, true, 'the stored payload survives a reclaim');
    assert.equal(await claim('30', '3'), 'claimed');
    now += 11 * 60 * 1000;
    const stale = await call('/data/v1/ledger/claim', post({ scope: 's', key: '3' }, auth('31')));
    assert.equal(stale.json.reclaimed, 'stale_claim');
    assert.equal((await call('/data/v1/ledger/claim', post({ scope: 's', key: '4' }, auth()))).status, 400, 'X-Run-Id is required');
  });
});

test('data service ledger: ttl_seconds per claim (60 to 7200, default 600) decides when an in-flight claim is stale', async () => {
  let now = 5_000_000;
  await withStandin([ds(() => now)], async (standin, call) => {
    const claim = (run, key, extra = {}) => call('/data/v1/ledger/claim', post({ scope: 's', key, ...extra }, auth(run)));
    for (const bad of [59, 7201, 1.5, '600']) assert.equal((await claim('1', 'bad', { ttl_seconds: bad })).status, 400, `ttl ${bad}`);
    assert.equal((await claim('1', 'short', { ttl_seconds: 60 })).json.entry.ttl_seconds, 60);
    assert.equal((await claim('1', 'default')).json.entry.ttl_seconds, 600);
    now += 61 * 1000;
    const short = await claim('2', 'short');
    assert.deepEqual([short.json.outcome, short.json.reclaimed], ['claimed', 'stale_claim'], 'past its own 60 s');
    assert.equal((await claim('2', 'default')).json.outcome, 'in_flight', 'the default 600 s has not passed');
    now += 540 * 1000;
    assert.equal((await claim('3', 'default')).json.reclaimed, 'stale_claim');
    const long = await claim('4', 'long', { ttl_seconds: 7200 });
    assert.equal(long.json.entry.ttl_seconds, 7200);
    now += 3600 * 1000;
    assert.equal((await claim('5', 'long')).json.outcome, 'in_flight', 'an hour into a two-hour claim');
  });
});

test('data service ledger: redelivers: false is stored and comes back with the released claim; list, filter and seed claims', async () => {
  let now = Date.parse('2026-11-15T00:00:00Z');
  await withStandin([ds(() => now)], async (standin, call) => {
    assert.equal((await call('/data/v1/ledger/claim', post({ scope: 'tg', key: '1', redelivers: 'no' }, auth('10')))).status, 400);
    await call('/data/v1/ledger/claim', post({ scope: 'tg', key: '1', payload: { raw: 1 }, redelivers: false }, auth('10')));
    await call('/data/v1/ledger/claim', post({ scope: 'tg', key: '2' }, auth('10')));
    assert.equal(standin.moduleState('data').ledger.get('tg:2').redelivers, undefined, 'not stored when not given');
    const released = await call('/data/v1/ledger/fail', post({ run_id: '10', error: 'x' }, auth('99')));
    assert.deepEqual(released.json.released.map(e => [e.key, e.redelivers]), [['1', false], ['2', undefined]]);
    now += 60_000;
    await call('/data/v1/ledger/claim', post({ scope: 'tg', key: '3' }, auth('11')));
    await call('/data/v1/ledger/claim', post({ scope: 'other', key: '4' }, auth('11')));
    standin.control({ data: { ledger: [{ scope: 'tg', key: 'old', state: 'in_flight', claimed_at: '2026-11-14T00:00:00.000Z', payload: { raw: 'seeded' } }] } });
    const list = query => call(`/data/v1/ledger?${query}`, { headers: auth() }).then(r => r);
    assert.equal((await list('scope=tg')).status, 200);
    assert.deepEqual((await list('scope=tg')).json.entries.map(e => e.key), ['old', '1', '2', '3'], 'oldest change first');
    assert.deepEqual((await list('scope=tg&state=failed')).json.entries.map(e => e.key), ['1', '2']);
    assert.deepEqual((await list('state=in_flight,failed&before=2026-11-15T00:00:30.000Z')).json.entries.map(e => e.key), ['old', '1', '2']);
    assert.equal((await list('scope=tg&key=old')).json.entries[0].payload, undefined, 'no payload unless asked');
    assert.deepEqual((await list('scope=tg&key=old&include_payload=true')).json.entries[0].payload, { raw: 'seeded' });
    assert.equal((await list('state=lost')).status, 400);
    assert.equal((await list('before=yesterday')).status, 400);
    assert.equal((await call('/data/v1/ledger')).status, 401);
    const seededTakeOver = await call('/data/v1/ledger/claim', post({ scope: 'tg', key: 'old' }, auth('12')));
    assert.equal(seededTakeOver.json.reclaimed, 'stale_claim', 'a seeded claim older than its ttl is stale');
    assert.equal(standin.log().filter(e => e.op === 'data.ledger_list').length, 9);
  });
});

test('data service update: compare-and-set with expect, no-op replay, 409 conflict, unique keys, history', () => withStandin([ds()], async (standin, call) => {
  const id = (await call('/data/v1/rows/things', post({ row: { name: 'a', kind: 'draft' } }, auth('1', 'i1')))).json.row.id;
  await call('/data/v1/rows/things', post({ row: { name: 'b', kind: 'draft' } }, auth('1', 'i2')));
  const patch = (body, key, run = '2', target = id) => call(`/data/v1/rows/things/${target}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...auth(run, key) }, body: JSON.stringify(body) });
  const first = await patch({ set: { kind: 'sent' }, expect: { kind: 'draft' } }, 'u1');
  assert.deepEqual([first.status, first.json.changed, first.json.row.kind, first.json.row.updated_by_run], [200, true, 'sent', '2']);
  assert.equal((await patch({ set: { kind: 'sent' }, expect: { kind: 'draft' } }, 'u1')).json.changed, true, 'same key, same body: the first answer again');
  const again = await patch({ set: { kind: 'sent' }, expect: { kind: 'draft' } }, 'u2');
  assert.deepEqual([again.status, again.json.changed], [200, false], 'a new key that changes nothing is a no-op');
  const conflict = await patch({ set: { kind: 'archived' }, expect: { kind: ['draft', 'queued'] } }, 'u3');
  assert.deepEqual([conflict.status, conflict.json.error, conflict.json.columns, conflict.json.row.kind], [409, 'conflict', ['kind'], 'sent']);
  assert.equal((await patch({ set: { kind: 'archived' }, expect: { kind: ['sent'] } }, 'u4')).json.row.kind, 'archived');
  assert.equal((await patch({ set: { name: 'b' } }, 'u5')).json.error, 'unique_violation');
  assert.equal((await patch({ set: { colour: 'red' } }, 'u6')).status, 400);
  assert.equal((await patch({ set: {} }, 'u7')).status, 400);
  assert.equal((await patch({ set: { kind: 'x' } }, 'u8', '2', 'thing_9999')).status, 404);
  assert.equal((await patch({ set: { kind: 'x' } })).status, 400, 'Idempotency-Key is required');
  const row = standin.state().data.tables.things.find(r => r.id === id);
  assert.deepEqual(row.history.map(h => h.set), [['kind'], ['kind']]);
  assert.deepEqual(standin.log().filter(e => e.method === 'PATCH').map(e => e.op), Array(10).fill('data.update.things'));
}));

test('data service sequence insert: next value per scope, a repeated key gets its first value, start, unique keys', async () => {
  const seq = dataService({ token: 't', tables: { numbers: { columns: ['series', 'value', 'ref'], unique: [['series', 'value']] } } });
  await withStandin([seq], async (standin, call) => {
    const next = (body, key) => call('/data/v1/rows/numbers/next', post(body, auth('1', key)));
    const a = await next({ row: { series: 'inv-2026', ref: 'A' }, column: 'value', scope: ['series'], key: ['ref'], start: 1001 }, 'k1');
    const b = await next({ row: { series: 'inv-2026', ref: 'B' }, column: 'value', scope: ['series'], key: ['ref'], start: 1001 }, 'k2');
    const other = await next({ row: { series: 'cn-2026', ref: 'A' }, column: 'value', scope: ['series'], key: ['ref'] }, 'k3');
    const repeat = await next({ row: { series: 'inv-2026', ref: 'A' }, column: 'value', scope: ['series'], key: ['ref'], start: 1001 }, 'k4');
    assert.deepEqual([a.status, a.json.value, a.json.outcome, b.json.value, other.json.value], [201, 1001, 'allocated', 1002, 1]);
    assert.deepEqual([repeat.status, repeat.json.value, repeat.json.outcome, repeat.json.row.id], [200, 1001, 'existing', a.json.row.id]);
    assert.equal((await next({ row: { series: 'x', value: 5 }, column: 'value' }, 'k5')).status, 400, 'the service allocates the value');
    assert.equal((await next({ row: { series: 'x' }, column: 'nope' }, 'k6')).status, 400);
    assert.equal(standin.state().data.tables.numbers.length, 3);
    assert.deepEqual(standin.log().map(e => e.op), Array(6).fill('data.next.numbers'));
  });
});

test('model replay: refuses requests the real API would refuse, answers from the fixture otherwise', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'one.json'), JSON.stringify({ synthetic: true, note: 'n', response: { content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' } }));
  const replay = modelReplay({ fixturesDir: dir, model: 'claude-opus-5-5', apiKey: 'k', resolveFixture: body => body.metadata?.user_id ?? null });
  const good = { model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }], output_config: { format: { type: 'json_schema', schema: {} } }, metadata: { user_id: 'one' } };
  const headers = { 'x-api-key': 'k', 'anthropic-version': ANTHROPIC_VERSION };
  await withStandin([replay], async (standin, call) => {
    const ok = await call('/anthropic/v1/messages', post(good, headers));
    assert.deepEqual([ok.status, ok.json.id, ok.json.model, ok.json.content[0].text], [200, 'msg_fixture_one', 'claude-opus-5-5', '{}']);
    for (const [patch, pattern] of [[{ temperature: 0 }, /temperature/], [{ tool_choice: { type: 'tool', name: 'x' } }, /forced tool_choice/], [{ output_config: {} }, /json_schema/], [{ model: 'other' }, /unexpected model/]]) {
      const res = await call('/anthropic/v1/messages', post({ ...good, ...patch }, headers));
      assert.equal(res.status, 400);
      assert.match(res.json.error.message, pattern);
    }
    assert.equal((await call('/anthropic/v1/messages', post(good, { ...headers, 'anthropic-version': '2023-06-01' }))).status, 400);
    assert.equal((await call('/anthropic/v1/messages', post(good, { 'anthropic-version': ANTHROPIC_VERSION }))).status, 401);
    assert.equal((await call('/anthropic/v1/messages', post({ ...good, metadata: { user_id: 'two' } }, headers))).status, 500);
  });
  rmSync(dir, { recursive: true, force: true });
});

test('slack alerts stand-in: ok false like Slack for a missing channel, keys never replayed', () => withStandin([slackAlerts({ token: 's' })], async (standin, call) => {
  const h = { authorization: 'Bearer s', 'idempotency-key': 'a' };
  assert.equal((await call('/slack/api/chat.postMessage', post({ text: 'x' }, h))).json.error, 'channel_not_found');
  await call('/slack/api/chat.postMessage', post({ channel: '#crit-alerts', text: 'x' }, h));
  await call('/slack/api/chat.postMessage', post({ channel: '#crit-alerts', text: 'x' }, h));
  assert.equal(standin.state().slack.messages.length, 2);
}));

// ------------------------------------------------------------------ lock

test('lock: one holder at a time, released on release(), a dead holder is taken over', async () => {
  const base = scratch();
  const dir = join(base, 'e2e.lock');
  const release = await acquireLock({ dir, label: 'first', log: null });
  assert.ok(existsSync(join(dir, 'owner.json')));
  await assert.rejects(acquireLock({ dir, label: 'second', timeoutMs: 600, pollMs: 100, log: null }), /still held by pid/);
  release();
  assert.ok(!existsSync(dir));
  // A lock left by a process that no longer exists.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  mkdirSync(dir);
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: Number(dead.stdout), label: 'crashed run' }));
  const takeOver = await acquireLock({ dir, label: 'third', timeoutMs: 2000, pollMs: 50, log: null });
  takeOver();
  assert.ok(!existsSync(dir));
  rmSync(base, { recursive: true, force: true });
});

test('lock: release() tells whether this run removed its own lock, not just whether the directory is gone', async () => {
  const base = scratch();
  const dir = join(base, 'e2e.lock');
  const release = await acquireLock({ dir, label: 'mine', log: null });
  assert.equal(release(), true);
  assert.equal(release.releasedOwn, true);
  assert.equal(release(), true, 'a second call changes nothing');
  // Someone else's lock in the same place: releasing ours must not remove theirs, and says false.
  const other = await acquireLock({ dir, label: 'mine again', log: null });
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid + 100000, label: 'a waiting run that took over' }));
  assert.equal(other(), false);
  assert.ok(existsSync(dir), 'the other holder keeps its lock');
  rmSync(base, { recursive: true, force: true });
});

test('harness: results text carries <tmp> instead of the per-user temp path', () => {
  const text = `lock ${join(tmpdir(), 'crit-n8n-e2e.lock')} and ${join(tmpdir(), 'crit-n8n-e2e-x', '.n8n', 'config')}`;
  assert.equal(neutralTmp(text), 'lock <tmp>/crit-n8n-e2e.lock and <tmp>/crit-n8n-e2e-x/.n8n/config');
  assert.doesNotMatch(neutralTmp(text), /\/var\/folders|\/tmp\/crit/);
});

test('lock: two processes started together take turns', async () => {
  const base = scratch();
  const dir = join(base, 'e2e.lock');
  const lockModule = join(kit, 'lib', 'lock.mjs');
  const script = `import { acquireLock } from ${JSON.stringify(lockModule)};
const release = await acquireLock({ dir: ${JSON.stringify(dir)}, label: process.argv[1], pollMs: 50, log: null });
const t0 = Date.now(); await new Promise(r => setTimeout(r, 400)); release(); console.log(t0 + ' ' + Date.now());`;
  const file = join(base, 'hold.mjs');
  writeFileSync(file, script);
  const run = label => new Promise(resolve => { let out = ''; const child = spawn(process.execPath, [file, label]); child.stdout.on('data', d => { out += d; }); child.on('exit', () => resolve(out.trim().split(' ').map(Number))); });
  const [a, b] = await Promise.all([run('a'), run('b')]);
  const [first, second] = a[0] < b[0] ? [a, b] : [b, a];
  assert.ok(second[0] >= first[1], `the second holder started (${second[0]}) after the first released (${first[1]})`);
  rmSync(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ builder, lint, environment, modules

const notes = new Proxy({}, { get: (_, name) => `note for ${String(name)}` });
function tinyFlow() {
  const f = new Flow({ id: 'critTinyFlow0001', name: 'CRIT · Tiny', timezone: 'UTC', notes });
  f.sticky('Read me', 'x', at(0, -1), 100, 100);
  f.sticky('1. Only section', 'x', at(0, -1), 100, 100);
  f.add(webhookNode('Receive request', at(0, 0), { path: 'tiny' }));
  f.add(httpNode('Store thing', at(1, 0), { method: 'POST', url: 'http://127.0.0.1/x', write: true, soft: true }));
  f.add(respondNode('Respond 200 ok', at(2, 0), '{}', 200));
  f.chain('Receive request', 'Store thing', 'Respond 200 ok');
  f.connect('Store thing', 'Respond 200 ok', 1);
  return f;
}

test('flow + lint: a small workflow that follows the house style passes', () => {
  const json = tinyFlow().json();
  assert.deepEqual(lintWorkflow(json), []);
  const store = json.nodes.find(n => n.name === 'Store thing');
  assert.deepEqual([store.retryOnFail, store.maxTries, store.waitBetweenTries, store.onError], [true, 4, 5000, 'continueErrorOutput']);
  assert.deepEqual(store.parameters.headerParameters.parameters.map(h => h.value), ['={{ $json.idem_base }}:Store thing', '={{ $execution.id }}']);
});

test('lint: each house rule is enforced', () => {
  const broken = mutate => { const json = JSON.parse(JSON.stringify(tinyFlow().json())); mutate(json); return lintWorkflow(json).join('\n'); };
  assert.match(broken(j => { j.id = 'short'; }), /16 letters/);
  assert.match(broken(j => { j.name = 'Tiny'; }), /CRIT · /);
  assert.match(broken(j => { delete j.settings.timezone; }), /timezone/);
  assert.match(broken(j => { delete j.settings.errorWorkflow; }), /errorWorkflow/);
  assert.match(broken(j => { j.nodes = j.nodes.filter(n => n.name !== 'Read me'); }), /Read me/);
  assert.match(broken(j => { j.nodes = j.nodes.filter(n => n.name !== '1. Only section'); }), /numbered section/);
  assert.match(broken(j => { j.nodes[2].name = 'Thing store'; }), /start with a verb/);
  assert.match(broken(j => { j.nodes[3].notes = ''; }), /no note/);
  assert.match(broken(j => { j.nodes[3].notesInFlow = false; }), /notesInFlow/);
  assert.match(broken(j => { j.nodes[3].maxTries = 3; }), /maxTries 4/);
  assert.match(broken(j => { j.nodes[3].parameters.headerParameters.parameters.pop(); }), /X-Run-Id/);
  assert.match(broken(j => { j.connections['Store thing'].main.pop(); }), /output 1 is not wired/);
  assert.match(broken(j => { j.connections['Store thing'].main = [[]]; }), /no incoming connection|without a Respond/);
  assert.match(broken(j => { j.nodes[2].parameters.responseMode = 'lastNode'; }), /responseNode/);
});

test('lint: a manifest verbs list extends the built-in verbs; Flow takes the same list', () => {
  const named = verbs => lintWorkflow(JSON.parse(JSON.stringify(tinyFlow().json()).replaceAll('Store thing', 'Expire thing')), { verbs }).join('\n');
  assert.match(named([]), /"Expire thing": name must start with a verb/);
  assert.equal(named(['Expire']), '');
  const f = new Flow({ id: 'critTinyFlow0002', name: 'CRIT · Tiny', timezone: 'UTC', notes, verbs: ['Expire'] });
  f.sticky('Read me', 'x', at(0, -1), 100, 100);
  f.sticky('1. Only section', 'x', at(0, -1), 100, 100);
  f.add(scheduleNode('Receive tick', at(0, 0), { field: 'minutes', minutesInterval: 15 }));
  f.add(waitNode('Wait a moment', at(1, 0), 2));
  f.add(codeNode('Expire drafts', at(2, 0), 'return [];'));
  f.chain('Receive tick', 'Wait a moment', 'Expire drafts');
  const json = f.json();
  assert.deepEqual(json.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote').map(n => [n.type, n.typeVersion]), [['n8n-nodes-base.scheduleTrigger', 1.4], ['n8n-nodes-base.wait', 1.1], ['n8n-nodes-base.code', 2]]);
  assert.deepEqual(json.nodes.find(n => n.name === 'Wait a moment').parameters, { resume: 'timeInterval', amount: 2, unit: 'seconds' });
});

test('lint: noRetryNodes [{ node, reason }] lets a named HTTP node skip retries; no reason or an unknown node is a problem; every other node keeps 3 retries', () => {
  const json = tinyFlow().json();
  const once = JSON.parse(JSON.stringify(json));
  Object.assign(once.nodes[3], httpNode('Store thing', at(1, 0), { method: 'POST', url: 'http://127.0.0.1/x', write: true, soft: true, retry: false }), { notes: 'n', notesInFlow: true, id: once.nodes[3].id });
  assert.equal(once.nodes[3].retryOnFail, false);
  assert.match(lintWorkflow(once).join('\n'), /needs retryOnFail/);
  const reason = 'paid per call, no idempotency key: a retry after a lost answer pays twice';
  assert.deepEqual(lintWorkflow(once, { noRetryNodes: [{ node: 'Store thing', reason }] }), [], 'a listed node with a reason may have retries off');
  assert.deepEqual(lintWorkflow(json, { noRetryNodes: [{ node: 'Store thing', reason }] }), [], 'listing a node that still retries is allowed');
  assert.match(lintWorkflow(once, { noRetryNodes: [{ node: 'Store thing', reason: ' ' }] }).join('\n'), /"Store thing".*needs \{ node, reason \} with a reason/);
  assert.match(lintWorkflow(once, { noRetryNodes: ['Store thing'] }).join('\n'), /needs \{ node, reason \} with a reason/);
  assert.match(lintWorkflow(json, { noRetryNodes: [{ node: 'Store nothing', reason }] }).join('\n'), /"Store nothing": no such node/);
  assert.match(lintWorkflow(json, { noRetryNodes: [{ node: 'Receive request', reason }] }).join('\n'), /not an HTTP Request node/);
  const two = JSON.parse(JSON.stringify(once));
  two.nodes.push({ ...JSON.parse(JSON.stringify(once.nodes[3])), name: 'Store other', id: 'x' });
  two.connections['Store thing'].main[0].push({ node: 'Store other', type: 'main', index: 0 });
  two.connections['Store other'] = { main: [[{ node: 'Respond 200 ok', type: 'main', index: 0 }], [{ node: 'Respond 200 ok', type: 'main', index: 0 }]] };
  assert.match(lintWorkflow(two, { noRetryNodes: [{ node: 'Store thing', reason }] }).join('\n'), /"Store other": needs retryOnFail/, 'every other HTTP node is still held to the rule');
});

test('code node helper: $() and $input have first, last and all over several items, $runIndex, and no URL or URLSearchParams', async () => {
  const workflow = { nodes: [
    { name: 'Count', parameters: { jsCode: "return [{ json: { n: $input.all().length, last: $input.last().json.v, prepared: $('Prep').all().map(i => i.json.k), first: $('Prep').first().json.k, lastPrep: $('Prep').last().json.k, run: $runIndex } }];" } },
    { name: 'Uses URL', parameters: { jsCode: "return [{ json: { q: new URLSearchParams('a=1').get('a') } }];" } },
    { name: 'Uses URL class', parameters: { jsCode: "return [{ json: { host: new URL('http://x').host } }];" } },
  ] };
  const [out] = await runCodeNode(workflow, 'Count', { input: [{ v: 1 }, { v: 2 }, { v: 3 }], nodes: { Prep: [{ k: 'a' }, { k: 'b' }] }, runIndex: 2 });
  assert.deepEqual(out, { n: 3, last: 3, prepared: ['a', 'b'], first: 'a', lastPrep: 'b', run: 2 });
  await assert.rejects(runCodeNode(workflow, 'Uses URL'), /URLSearchParams is not a constructor/);
  await assert.rejects(runCodeNode(workflow, 'Uses URL class'), /URL is not a constructor/);
  const dir = scratch();
  writeFileSync(join(dir, 'u.js'), "function parseQuery(text) { return new URLSearchParams(text).get('a'); }");
  assert.throws(() => createModules([join(dir, 'u.js')]).load().parseQuery('a=1'), /URLSearchParams is not a constructor/);
});

test('flow: refuses a bad id, a bad name and a node without a note', () => {
  assert.throws(() => new Flow({ id: 'x', name: 'CRIT · a', timezone: 'UTC', notes }), /16 letters/);
  assert.throws(() => new Flow({ id: 'critTinyFlow0001', name: 'a', timezone: 'UTC', notes }), /CRIT · /);
  const f = new Flow({ id: 'critTinyFlow0001', name: 'CRIT · a', timezone: 'UTC', notes: {} });
  assert.throws(() => f.add(codeNode('Check x', at(0, 0), 'return [];')), /Missing note/);
});

test('n8n env: allowlist only, nothing inherited but PATH, HOME, TMPDIR, LANG', () => {
  const env = buildN8nEnv({ N8N_PORT: 1, DATA_SERVICE_TOKEN: 't', MY_VAR: 'x' }, ['MY_VAR'], { PATH: '/bin', HOME: '/h', SECRET: 's' });
  assert.equal(env.SECRET, undefined);
  assert.deepEqual([env.PATH, env.N8N_PORT, env.MY_VAR, env.N8N_BLOCK_ENV_ACCESS_IN_NODE, env.N8N_DIAGNOSTICS_ENABLED], ['/bin', '1', 'x', 'false', 'false']);
  assert.throws(() => buildN8nEnv({ OTHER: 'x' }), /not on the n8n environment allowlist/);
});

test('modules: unique names enforced, only the modules a Code node needs are inlined', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'a.js'), 'function alpha() { return 1; }\nconst ALPHA = 2;');
  writeFileSync(join(dir, 'b.js'), 'function beta() { return alpha() + 1; }');
  writeFileSync(join(dir, 'c.js'), 'function gamma() { return 3; }');
  const lib = createModules([join(dir, 'a.js'), join(dir, 'b.js'), join(dir, 'c.js')]);
  assert.equal(lib.load().beta(), 2);
  const source = lib.codeSource('Check it', 'return [{ json: { v: beta() } }];');
  assert.match(source, /a\.js/);
  assert.doesNotMatch(source, /c\.js|ctx\.js/);
  assert.match(lib.codeSource('Check it', 'return [{ json: ctx }];', { from: ['Prepare it'] }), /function ctxFrom/);
  writeFileSync(join(dir, 'd.js'), 'function alpha() {}');
  assert.throws(() => createModules([join(dir, 'a.js'), join(dir, 'd.js')]), /Duplicate top-level names across modules: alpha/);
  rmSync(dir, { recursive: true, force: true });
});

test('harness: free ports are distinct numbers', async () => {
  const [a, b] = await Promise.all([freePort(), freePort()]);
  assert.ok(Number.isInteger(a) && a > 0 && Number.isInteger(b));
});

// ------------------------------------------------------------------ the shared error workflow

const errorWorkflow = buildErrorWorkflow();
const alertLib = createModules([join(kit, 'error-workflow/lib/alert.js')]).load();

test('error workflow: generated file is fresh and passes the lint as an error workflow', () => {
  execFileSync(process.execPath, [join(kit, 'error-workflow/build.mjs'), '--check'], { stdio: 'pipe' });
  assert.deepEqual(lintWorkflow(errorWorkflow, { isErrorWorkflow: true }), []);
  assert.equal(errorWorkflow.id, 'critAlertErrors1');
  assert.equal(errorWorkflow.settings.errorWorkflow, undefined);
});

test('error workflow: failure description, link fallback, credentials stripped from the message', () => {
  const trigger = { execution: { id: '42', error: { message: 'request to http://x/bot123456:ABC-def_9/getFile failed, Bearer abc.def and token=xyz' }, lastNodeExecuted: 'Store expense row' }, workflow: { id: 'critReceiptScan1', name: 'CRIT · Scan receipts' } };
  const failure = alertLib.describeFailure(trigger, 'http://127.0.0.1:5691/');
  assert.equal(failure.execution_url, 'http://127.0.0.1:5691/workflow/critReceiptScan1/executions/42');
  assert.equal(failure.failed_node, 'Store expense row');
  assert.doesNotMatch(failure.message, /123456:ABC|abc\.def|xyz/);
  const text = alertLib.alertText(failure, [{ scope: 'telegram_update', key: '9' }]);
  assert.match(text, /^Workflow failed: CRIT · Scan receipts\nFailed node: Store expense row\nError: .*\nExecution: http.*\nReleased for redelivery: telegram_update:9$/);
  const manual = alertLib.alertText(failure, [{ scope: 'telegram_update', key: '9', redelivers: false }, { scope: 'job', key: '2' }]);
  assert.match(manual, /\nReleased for redelivery: job:2\nHanded back, but the sender does not redeliver: telegram_update:9\. Nothing runs it again by itself/);
  assert.doesNotMatch(manual, /Released for redelivery: telegram/);
  assert.equal(alertLib.describeFailure({ execution: { id: '1', url: 'http://n8n/x' }, workflow: {} }, '').execution_url, 'http://n8n/x');
});

test('error workflow glue: a failed release still sends the alert; a failed alert is recorded', async () => {
  const described = { failed_run_id: '42', workflow_name: 'W', failed_node: 'N', message: 'm', execution_url: 'u', idem_base: 'alert:42' };
  const [prepared] = await runCodeNode(errorWorkflow, 'Prepare alert', { input: { error: { message: 'ECONNREFUSED' } }, nodes: { 'Describe failure': described }, env: { ALERTS_SLACK_CHANNEL: '#crit-alerts' } });
  assert.deepEqual([prepared.release_ok, prepared.req.body.channel], [false, '#crit-alerts']);
  assert.match(prepared.req.body.text, /No claim was held/);
  const [summary] = await runCodeNode(errorWorkflow, 'Summarize alert', { input: { ok: false, error: 'channel_not_found' }, nodes: { 'Prepare alert': prepared } });
  assert.deepEqual([summary.alert_posted, summary.alert_error], [false, 'channel_not_found']);
  const [withClaims] = await runCodeNode(errorWorkflow, 'Prepare alert', { input: { released: [{ scope: 'telegram_update', key: '9', state: 'failed', redelivers: false }, { scope: 'job', key: '2', state: 'failed' }] }, nodes: { 'Describe failure': described }, env: { ALERTS_SLACK_CHANNEL: '#crit-alerts' } });
  assert.deepEqual(withClaims.released, [{ scope: 'telegram_update', key: '9', redelivers: false }, { scope: 'job', key: '2' }]);
  assert.match(withClaims.req.body.text, /Released for redelivery: job:2\nHanded back, but the sender does not redeliver: telegram_update:9/);
});
