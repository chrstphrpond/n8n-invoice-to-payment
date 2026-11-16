#!/usr/bin/env node
// The local n8n editor for one workflow folder. Called by the folder's start.sh, import.sh and export.sh after
// they source its env.sh:
//   node <kit>/bin/n8n-local.mjs start  <workflow dir>   n8n start, 127.0.0.1 only, allowlisted environment
//   node <kit>/bin/n8n-local.mjs import <workflow dir>   rebuild, import and publish the error workflow and the folder's workflows
//   node <kit>/bin/n8n-local.mjs export <workflow dir>   export what the editor holds to workflow/exported/ and diff it
// n8n never inherits the shell: it gets PATH, HOME, TMPDIR, LANG, N8N_* and the variables the kit and the
// folder's manifest name, nothing else (the same rule the tests use, shared/lib/n8n-env.mjs).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KIT_DIR, N8N_VERSION, n8nBinary, readManifest } from '../lib/harness.mjs';
import { KIT_N8N_SETTINGS, KIT_WORKFLOW_VARIABLES, buildN8nEnv } from '../lib/n8n-env.mjs';

const [command, target] = process.argv.slice(2);
if (!['start', 'import', 'export'].includes(command) || !target) {
  console.error('usage: node shared/bin/n8n-local.mjs start|import|export <workflow dir>   (source the folder\'s env.sh first)');
  process.exit(2);
}
const workflowDir = resolve(target);
const manifest = readManifest(workflowDir);
const errorDir = join(KIT_DIR, 'error-workflow');
if (!process.env.N8N_USER_FOLDER) { console.error('N8N_USER_FOLDER is not set: source the workflow folder\'s env.sh first (start.sh does).'); process.exit(2); }

const wanted = [...Object.keys(KIT_N8N_SETTINGS), ...KIT_WORKFLOW_VARIABLES, ...(manifest.env ?? []), ...Object.keys(process.env).filter(name => name.startsWith('N8N_'))];
const settings = Object.fromEntries(wanted.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
const env = buildN8nEnv({ ...settings, N8N_LISTEN_ADDRESS: '127.0.0.1', N8N_HOST: '127.0.0.1' }, manifest.env ?? []);
const bin = n8nBinary();
const n8n = args => {
  const proc = spawnSync(bin, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (proc.status !== 0) throw new Error(`n8n ${args.join(' ')} failed (${proc.status})`);
  return proc.stdout;
};

const version = n8n(['--version']).trim();
if (version !== N8N_VERSION) { console.error(`expected n8n ${N8N_VERSION}, found ${version}. Install: pnpm add -g n8n@${N8N_VERSION} --allow-build=sqlite3`); process.exit(1); }
mkdirSync(process.env.N8N_USER_FOLDER, { recursive: true });
const all = [...readManifest(errorDir).workflows.map(w => ({ ...w, dir: errorDir })), ...manifest.workflows.map(w => ({ ...w, dir: workflowDir }))];

if (command === 'start') {
  console.log(`n8n ${version} for ${manifest.slug}: http://127.0.0.1:${env.N8N_PORT ?? 5678} (data folder ${env.N8N_USER_FOLDER})`);
  const child = spawn(bin, ['start'], { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => process.exit(code ?? 0));
} else if (command === 'import') {
  execFileSync(process.execPath, [join(errorDir, 'build.mjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [join(workflowDir, 'workflow', 'build.mjs')], { stdio: 'inherit' });
  for (const workflow of all) process.stdout.write(n8n(['import:workflow', '--input', join(workflow.dir, 'workflow', workflow.file)]));
  for (const workflow of all) process.stdout.write(n8n(['publish:workflow', `--id=${workflow.id}`]));
  console.log('Imported and published. Restart n8n (./start.sh) for publishing to take effect.');
} else {
  const outDir = join(workflowDir, 'workflow', 'exported');
  mkdirSync(outDir, { recursive: true });
  for (const workflow of manifest.workflows) {
    const out = join(outDir, workflow.file);
    n8n(['export:workflow', '--pretty', `--id=${workflow.id}`, `--output=${out}`]);
    const raw = JSON.parse(readFileSync(out, 'utf8'));
    const exported = Array.isArray(raw) ? raw[0] : raw;
    // Keep the keys the generated file has (n8n adds version and timestamp metadata that is not part of the design).
    const generated = JSON.parse(readFileSync(join(workflowDir, 'workflow', workflow.file), 'utf8'));
    writeFileSync(out, `${JSON.stringify(Object.fromEntries(Object.keys(generated).map(key => [key, exported[key]])), null, 2)}\n`);
    console.log(`=== ${workflow.file}: editor export vs generated (fold real changes back into workflow/build.mjs)`);
    const diff = spawnSync('diff', ['-u', join(workflowDir, 'workflow', workflow.file), out], { encoding: 'utf8' });
    process.stdout.write(diff.stdout || 'no differences\n');
  }
}
