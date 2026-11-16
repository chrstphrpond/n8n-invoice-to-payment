// Captures the n8n canvas of each invoicing workflow from a throwaway local editor, for docs/.
//   node invoice-to-payment/scripts/capture-canvas.mjs [width height]
// 1. a fresh temporary N8N_USER_FOLDER, free ports, the folder's env.sh placeholders (no real secret, no stand-in
//    needed: the canvas only draws the workflow)
// 2. imports and publishes the workflows with the kit's n8n-local.mjs, starts n8n on 127.0.0.1
// 3. creates a local owner (placeholder address on .example, random password) and takes its session cookie
// 4. headless Google Chrome with a fresh temporary profile, driven over the DevTools protocol (Node's WebSocket),
//    opens each workflow and saves a PNG screenshot to docs/<file>-canvas.png
// 5. stops Chrome and n8n (whole process groups) and deletes the temporary folder, also on failure
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, sleep } from '../../_shared/lib/harness.mjs';
import { MANIFEST } from '../workflow/build.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(here, '..', 'docs');
const [width = 2400, height = 1500] = process.argv.slice(2).map(Number);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const temp = mkdtempSync(join(tmpdir(), 'crit-invoice-canvas-'));
const procs = [];
const cleanup = () => {
  for (const proc of procs) if (proc.exitCode === null) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(temp, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1));

const n8nPort = await freePort();
const brokerPort = await freePort();
const chromePort = await freePort();
const env = { ...process.env, N8N_USER_FOLDER: join(temp, 'n8n'), N8N_PORT: String(n8nPort), N8N_RUNNERS_BROKER_PORT: String(brokerPort) };
const local = command => ['-c', `. ./env.sh && N8N_EDITOR_BASE_URL=http://127.0.0.1:${n8nPort} exec node ../_shared/bin/n8n-local.mjs ${command} .`];
const imported = spawnSync('sh', local('import'), { cwd: here, env, encoding: 'utf8' });
if (imported.status !== 0) throw new Error(`import failed:\n${imported.stdout}\n${imported.stderr}`);

const n8n = spawn('sh', local('start'), { cwd: here, env, detached: true, stdio: 'ignore' });
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
let target;
for (let i = 0; !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up */ }
  if (i > 60) throw new Error('Chrome did not start');
  await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const waiting = new Map();
ws.onmessage = message => { const data = JSON.parse(message.data); if (waiting.has(data.id)) { waiting.get(data.id)(data); waiting.delete(data.id); } };
const cdp = (method, params = {}) => new Promise(resolve => { const n = ++id; waiting.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });

await cdp('Page.enable');
await cdp('Network.enable');
const [name, value] = cookie.split('=');
await cdp('Network.setCookie', { name, value, domain: '127.0.0.1', path: '/', httpOnly: true });
await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
for (const workflow of MANIFEST.workflows) {
  await cdp('Page.navigate', { url: `${base}/workflow/${workflow.id}` });
  await sleep(9000);
  // Close anything that opened over the canvas, then fit the whole workflow in view (n8n shortcut "1").
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(width / 2), y: Math.round(height / 2) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: '1', code: 'Digit1', text: '1', windowsVirtualKeyCode: 49 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 });
  await sleep(1500);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  const out = join(docs, workflow.file.replace(/\.json$/, '-canvas.png'));
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`saved ${out}`);
}
ws.close();
process.exit(0);
