#!/usr/bin/env node
// Captures the n8n canvas of each workflow of one folder from a throwaway local editor, for the docs.
//   node shared/bin/capture-canvas.mjs <workflow dir> [--docs <dir>] [--only <file,...>] [--size 2400x1500]
// Writes <docs>/<slug>-<workflow file name>-canvas.png per workflow (<slug>-canvas.png when the file name is the slug).
// <docs> defaults to the docs/ folder beside the kit (the repository root's docs/).
//   1. a fresh temporary folder: N8N_USER_FOLDER and the Chrome profile live there; free ports
//   2. the folder's env.sh (placeholders only; the canvas needs no stand-in), then the kit's n8n-local.mjs import
//      (rebuild, import, publish) and start, n8n on 127.0.0.1
//   3. a local owner (placeholder address on .example, random password) for the session cookie
//   4. headless Google Chrome (never Microsoft Edge) with that fresh profile, over the DevTools protocol: opens each
//      workflow, fits it to the view (n8n shortcut "1") and saves a PNG
//   5. stops Chrome and n8n (whole process groups) and deletes the temporary folder, also on failure
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { KIT_DIR, freePort, readManifest, sleep } from '../lib/harness.mjs';

const args = process.argv.slice(2);
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const target = args[0];
if (!target || target.startsWith('--')) { console.error('usage: node shared/bin/capture-canvas.mjs <workflow dir> [--docs <dir>] [--only <file,...>] [--size 2400x1500]'); process.exit(2); }
const workflowDir = resolve(target);
const docs = resolve(option('--docs') ?? join(KIT_DIR, '..', 'docs'));
const only = option('--only') ? new Set(option('--only').split(',')) : null;
const [width, height] = (option('--size') ?? '2400x1500').split('x').map(Number);
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.error(`Google Chrome not found at ${CHROME} (set CHROME_BIN)`); process.exit(2); }
const manifest = readManifest(workflowDir);

export function canvasFileName(slug, file) {
  const name = basename(file, '.json');
  return name === slug ? `${slug}-canvas.png` : `${slug}-${name}-canvas.png`;
}

const temp = mkdtempSync(join(tmpdir(), 'crit-canvas-'));
const procs = [];
const cleanup = () => {
  for (const proc of procs) if (proc.exitCode === null && proc.signalCode === null) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(temp, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1));

const n8nPort = await freePort();
const brokerPort = await freePort();
const chromePort = await freePort();
const env = { ...process.env, N8N_USER_FOLDER: join(temp, 'n8n'), N8N_PORT: String(n8nPort), N8N_RUNNERS_BROKER_PORT: String(brokerPort) };
const local = join(KIT_DIR, 'bin', 'n8n-local.mjs');
const sh = command => ['-c', `. ./env.sh && N8N_EDITOR_BASE_URL=http://127.0.0.1:${n8nPort} exec node "${local}" ${command} .`];
const imported = spawnSync('sh', sh('import'), { cwd: workflowDir, env, encoding: 'utf8' });
if (imported.status !== 0) throw new Error(`import failed:\n${imported.stdout}\n${imported.stderr}`);

const n8n = spawn('sh', sh('start'), { cwd: workflowDir, env, detached: true, stdio: 'ignore' });
procs.push(n8n);
const base = `http://127.0.0.1:${n8nPort}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up */ }
  if (i > 360) throw new Error('n8n did not start');
  await sleep(500);
}
await sleep(2000);
const owner = await fetch(`${base}/rest/owner/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@crit-local.example', firstName: 'CRIT', lastName: 'Local', password: `Local-${randomBytes(9).toString('hex')}9` }) });
const cookie = (owner.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).find(c => c.startsWith('n8n-auth='));
if (!owner.ok || !cookie) throw new Error(`owner setup failed: ${owner.status} ${await owner.text()}`);

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${join(temp, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--window-size=${width},${height}`, 'about:blank'], { detached: true, stdio: 'ignore' });
procs.push(chrome);
let page;
for (let i = 0; !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up */ }
  if (i > 60) throw new Error('Chrome did not start');
  await sleep(250);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
let id = 0;
const waiting = new Map();
ws.onmessage = message => { const data = JSON.parse(message.data); if (waiting.has(data.id)) { waiting.get(data.id)(data); waiting.delete(data.id); } };
const cdp = (method, params = {}) => new Promise(done => { const n = ++id; waiting.set(n, done); ws.send(JSON.stringify({ id: n, method, params })); });
const key = async (k, code, keyCode, text) => {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode });
};

await cdp('Page.enable');
await cdp('Network.enable');
const [cookieName, cookieValue] = cookie.split('=');
await cdp('Network.setCookie', { name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/', httpOnly: true });
await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
mkdirSync(docs, { recursive: true });
for (const workflow of manifest.workflows) {
  if (only && !only.has(workflow.file)) continue;
  await cdp('Page.navigate', { url: `${base}/workflow/${workflow.id}` });
  await sleep(9000);
  await key('Escape', 'Escape', 27);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(width / 2), y: Math.round(height / 2) });
  await key('1', 'Digit1', 49, '1');
  await sleep(1500);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  const out = join(docs, canvasFileName(manifest.slug, workflow.file));
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`saved ${out}`);
}
ws.close();
process.exit(0);
