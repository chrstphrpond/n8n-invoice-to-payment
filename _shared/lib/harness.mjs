// The real-n8n end-to-end harness every workflow's tests/e2e.mjs uses.
//   1. takes the machine-wide e2e lock (one n8n test run at a time; see lock.mjs)
//   2. makes a fresh temporary N8N_USER_FOLDER and picks free ports (n8n and its task-runner broker)
//   3. starts the stand-in server in this process (the workflow's modules plus the alerts Slack stand-in)
//   4. imports and publishes the shared error workflow and the workflow's own files with the n8n CLI
//   5. starts `n8n start` bound to 127.0.0.1 with an allowlisted environment and waits for the webhooks
// stop() (also run on exit, Ctrl-C and crashes) kills n8n's whole process group, closes the stand-in, deletes the
// temp folder and releases the lock. Nothing here asserts anything about the workflow: the caller does.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCK_DIR, acquireLock } from './lock.mjs';
import { buildN8nEnv } from './n8n-env.mjs';
import { slackAlerts } from './slack-alerts.mjs';
import { startStandin } from './standin.mjs';

export const KIT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const N8N_VERSION = '2.42.6';
export const ALERTS_CHANNEL = '#crit-alerts';
export const TEMP_PREFIX = 'crit-n8n-e2e-';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Results files must not carry the per-user temp path (/var/folders/... on macOS): it is replaced by "<tmp>".
const TMP_ROOTS = [...new Set([tmpdir(), (() => { try { return realpathSync(tmpdir()); } catch { return tmpdir(); } })()])].sort((a, b) => b.length - a.length);
export function neutralTmp(text) {
  let out = String(text);
  for (const root of TMP_ROOTS) out = out.split(root.replace(/\/+$/, '')).join('<tmp>');
  return out;
}
export const LOCK_LABEL = neutralTmp(LOCK_DIR);

export function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'workflow', 'manifest.json'), 'utf8'));
}

// The global n8n (same binary as the local editor). N8N_BIN overrides.
export function n8nBinary() {
  const candidate = process.env.N8N_BIN || join(homedir(), 'Library/pnpm/bin/n8n');
  if (existsSync(candidate)) return candidate;
  const which = spawnSync('which', ['n8n'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  throw new Error(`n8n ${N8N_VERSION} not found. Install it: pnpm add -g n8n@${N8N_VERSION} --allow-build=sqlite3`);
}

export function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
  });
}

// workflowDir: the workflow folder (holds workflow/manifest.json). modules({ secrets }): stand-in modules (include
// dataService). env({ url, secrets }): the workflow's own variables. redact: stand-in log path redactions.
export function createHarness({ workflowDir, modules, env = () => ({}), redact = [], timezone = 'UTC', label }) {
  const manifest = readManifest(workflowDir);
  const kitManifest = readManifest(join(KIT_DIR, 'error-workflow'));
  const resultsDir = join(workflowDir, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const secrets = {
    data: `test-data-${randomBytes(12).toString('hex')}`,
    slack: `test-slack-${randomBytes(12).toString('hex')}`,
    random: name => `test-${name}-${randomBytes(12).toString('hex')}`,
  };
  const h = { manifest, secrets, resultsDir, ports: {}, standin: null, userFolder: null, n8nLogPath: null };
  let n8nProc = null;
  let logFd;
  let release = null;
  let lockReleasedOwn = false;
  let n8nEnv = null;
  const bin = n8nBinary();

  const killGroupSync = () => {
    if (n8nProc?.pid && n8nProc.exitCode === null) { try { process.kill(-n8nProc.pid, 'SIGKILL'); } catch { /* gone */ } }
  };
  const cleanupSync = () => {
    killGroupSync();
    if (logFd !== undefined) { try { closeSync(logFd); } catch { /* closed */ } logFd = undefined; }
    if (h.userFolder) { rmSync(h.userFolder, { recursive: true, force: true }); }
    if (release) { lockReleasedOwn = release() === true; release = null; }
  };
  const onExit = () => cleanupSync();
  const onSignal = signal => { cleanupSync(); process.exit(signal === 'SIGINT' ? 130 : 143); };

  h.cli = (args, label) => {
    const proc = spawnSync(bin, args, { env: n8nEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000 });
    if (label) writeFileSync(join(resultsDir, `${label}.stdout.txt`), neutralTmp((proc.stdout ?? '').split('\n').filter(line => !/migration/i.test(line)).join('\n')));
    if (proc.error || proc.status !== 0) throw new Error(`n8n ${args.join(' ')} failed (${proc.status}): ${proc.error?.message ?? proc.stderr ?? proc.stdout}`);
    return proc.stdout;
  };

  h.start = async () => {
    release = await acquireLock({ label: label ?? `${manifest.slug} e2e` });
    process.on('exit', onExit);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    h.userFolder = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    h.n8nLogPath = join(h.userFolder, 'n8n-server.log');
    h.standin = await startStandin({ modules: [...modules({ secrets }), slackAlerts({ token: secrets.slack })], redact });
    h.ports.n8n = await freePort();
    h.ports.broker = await freePort();
    const url = h.standin.url;
    n8nEnv = buildN8nEnv({
      N8N_USER_FOLDER: h.userFolder,
      N8N_PORT: h.ports.n8n,
      N8N_RUNNERS_BROKER_PORT: h.ports.broker,
      N8N_EDITOR_BASE_URL: `http://127.0.0.1:${h.ports.n8n}`,
      GENERIC_TIMEZONE: timezone,
      DATA_SERVICE_BASE_URL: `${url}/data`, DATA_SERVICE_TOKEN: secrets.data,
      ALERTS_SLACK_BASE_URL: `${url}/slack`, ALERTS_SLACK_TOKEN: secrets.slack, ALERTS_SLACK_CHANNEL: ALERTS_CHANNEL,
      ...env({ url, secrets }),
    }, manifest.env ?? []);

    const version = h.cli(['--version']).trim();
    if (version !== N8N_VERSION) throw new Error(`expected n8n ${N8N_VERSION}, found ${version}`);
    h.n8nVersion = version;
    const all = [...kitManifest.workflows.map(w => ({ ...w, dir: join(KIT_DIR, 'error-workflow') })), ...manifest.workflows.map(w => ({ ...w, dir: workflowDir }))];
    for (const workflow of all) h.cli(['import:workflow', '--input', join(workflow.dir, 'workflow', workflow.file)], `import-${workflow.file.replace(/\.json$/, '')}`);
    for (const workflow of all) h.cli(['publish:workflow', `--id=${workflow.id}`], `publish-${workflow.file.replace(/\.json$/, '')}`);
    const listing = h.cli(['list:workflow']);
    for (const workflow of all) if (!listing.includes(`${workflow.id}|${workflow.name}`)) throw new Error(`n8n does not list ${workflow.id}|${workflow.name}:\n${listing}`);

    logFd = openSync(h.n8nLogPath, 'w');
    n8nProc = spawn(bin, ['start'], { env: n8nEnv, detached: true, stdio: ['ignore', logFd, logFd] });
    h.n8nPid = n8nProc.pid;
    const deadline = Date.now() + 180000;
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${h.ports.n8n}/healthz`)).ok) break; } catch { /* not up yet */ }
      if (n8nProc.exitCode !== null) throw new Error(`n8n exited early (${n8nProc.exitCode}):\n${h.serverLog().slice(-3000)}`);
      if (Date.now() > deadline) throw new Error('n8n did not become healthy within 180 s');
      await sleep(500);
    }
    // Production webhooks register after /healthz: an empty probe gets anything but 404 once they are live.
    for (const workflow of manifest.workflows) {
      for (const hook of workflow.webhooks ?? []) {
        for (;;) {
          try {
            const res = await fetch(`http://127.0.0.1:${h.ports.n8n}/webhook/${hook.path}`, { method: hook.method ?? 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
            if (res.status !== 404) break;
          } catch { /* retry */ }
          if (Date.now() > deadline) throw new Error(`webhook ${hook.path} never registered`);
          await sleep(300);
        }
      }
    }
    h.standin.reset();
  };

  // POST to a production webhook path; returns { status, json, text, headers }.
  h.post = async (path, payload, headers = {}, { raw } = {}) => {
    const res = await fetch(`http://127.0.0.1:${h.ports.n8n}/webhook/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ?? JSON.stringify(payload), signal: AbortSignal.timeout(300000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep the text */ }
    return { status: res.status, json, text, headers: Object.fromEntries(res.headers) };
  };

  // Polls until check() returns a truthy value (returned), or throws after timeoutMs.
  h.waitFor = async (check, { timeoutMs = 120000, intervalMs = 200, what = 'condition' } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
      await sleep(intervalMs);
    }
  };
  // Waits until the stand-in log has not grown for quietMs.
  h.settle = async (quietMs = 1500) => {
    let last = -1;
    let since = Date.now();
    for (;;) {
      const count = h.standin.log().length;
      if (count !== last) { last = count; since = Date.now(); }
      if (Date.now() - since >= quietMs) return;
      await sleep(100);
    }
  };

  h.serverLog = () => { try { return readFileSync(h.n8nLogPath, 'utf8'); } catch { return ''; } };

  h.stop = async () => {
    if (n8nProc?.pid && n8nProc.exitCode === null) {
      try { process.kill(-n8nProc.pid, 'SIGTERM'); } catch { /* gone */ }
      for (let i = 0; i < 60 && n8nProc.exitCode === null; i++) await sleep(250);
    }
    await h.standin?.close();
    cleanupSync();
    process.off('exit', onExit);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };

  // True once stop() (or the exit handler) removed this run's own lock: the owner pid was this process. Use it for
  // the summary's cleanup record instead of checking that the lock directory is gone, which a waiting run may
  // already have re-created.
  h.lockReleased = () => lockReleasedOwn;

  // Processes still running in n8n's process group (n8n and its task runner); should be none after stop().
  h.leftovers = () => {
    if (!h.n8nPid) return [];
    const ps = execFileSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' });
    return ps.split('\n').map(line => line.trim()).filter(line => line && Number(line.split(/\s+/)[1]) === h.n8nPid);
  };
  return h;
}
