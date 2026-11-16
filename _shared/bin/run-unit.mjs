#!/usr/bin/env node
// Runs the kit's unit tests and one workflow folder's unit tests in one node --test process, prints the result and
// saves it to <workflow dir>/results/unit-tests.txt.
//   node shared/bin/run-unit.mjs <workflow dir>
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { KIT_DIR } from '../lib/harness.mjs';

const target = process.argv[2];
if (!target) { console.error('usage: node shared/bin/run-unit.mjs <workflow dir>'); process.exit(2); }
const workflowDir = resolve(target);
const testsIn = dir => readdirSync(dir).filter(file => file.endsWith('.test.mjs')).map(file => join(dir, file));
const files = [...testsIn(join(KIT_DIR, 'tests')), ...testsIn(join(workflowDir, 'tests'))];
const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
const output = `${run.stdout}${run.stderr}`;
process.stdout.write(output);
mkdirSync(join(workflowDir, 'results'), { recursive: true });
const header = `# node --test ${files.map(file => relative(process.cwd(), file)).join(' ')}\n# ${new Date().toISOString()}, Node ${process.version}\n\n`;
writeFileSync(join(workflowDir, 'results', 'unit-tests.txt'), header + output);
process.exitCode = run.status ?? 1;
