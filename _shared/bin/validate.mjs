#!/usr/bin/env node
// Validates a workflow folder's workflows, plus the shared error workflow they attach:
//   1. the house-style lint on the JSON on disk (shared/lib/lint.mjs)
//   2. n8n-mcp validate_workflow, profile runtime, then strict (documentation mode, no n8n instance)
//   3. a connections report: every node's outputs and targets, error outputs (main[1]) called out
// Writes <workflow dir>/results/n8n-mcp-validation.json and <workflow dir>/results/connections.txt.
// Fails on any lint problem or any validate_workflow error; warnings are kept in the results.
//   node shared/bin/validate.mjs <workflow dir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KIT_DIR, readManifest } from '../lib/harness.mjs';
import { lintWorkflow } from '../lib/lint.mjs';
import { openN8nMcp } from '../lib/n8n-mcp-client.mjs';

const target = process.argv[2];
if (!target) { console.error('usage: node shared/bin/validate.mjs <workflow dir>'); process.exit(2); }
const workflowDir = resolve(target);
const resultsDir = join(workflowDir, 'results');
mkdirSync(resultsDir, { recursive: true });

const sets = [
  { dir: join(KIT_DIR, 'error-workflow'), manifest: readManifest(join(KIT_DIR, 'error-workflow')), isErrorWorkflow: true },
  { dir: workflowDir, manifest: readManifest(workflowDir), isErrorWorkflow: false },
];

export function connectionsReport(workflow) {
  const lines = [`# ${workflow.name} (${workflow.id})`];
  for (const node of workflow.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote')) {
    const outputs = workflow.connections[node.name]?.main ?? [];
    const soft = node.onError === 'continueErrorOutput';
    if (!outputs.length) { lines.push(`${node.name}  ->  (end)`); continue; }
    outputs.forEach((links, index) => {
      const label = soft && index === 1 ? 'error output' : `output ${index}`;
      lines.push(`${node.name}  [${label}]  ->  ${(links ?? []).map(link => link.node).join(', ') || '(not wired)'}`);
    });
  }
  return lines.join('\n');
}

const report = { tool: 'validate_workflow', profiles: ['runtime', 'strict'], server: null, generated_at: new Date().toISOString(), results: {} };
const connections = [];
let failed = false;
const mcp = await openN8nMcp();
report.server = mcp.server;
try {
  for (const set of sets) {
    for (const entry of set.manifest.workflows) {
      const workflow = JSON.parse(readFileSync(join(set.dir, 'workflow', entry.file), 'utf8'));
      const lint = lintWorkflow(workflow, { isErrorWorkflow: set.isErrorWorkflow, readOnlyPostNodes: entry.readOnlyPostNodes ?? [], verbs: set.manifest.verbs ?? [], noRetryNodes: entry.noRetryNodes ?? [] });
      const result = { id: workflow.id, name: workflow.name, lint };
      for (const profile of report.profiles) result[profile] = await mcp.call('validate_workflow', { workflow, options: { profile } });
      report.results[entry.file] = result;
      connections.push(connectionsReport(workflow));
      const nodeCount = workflow.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote').length;
      for (const profile of report.profiles) {
        const data = result[profile];
        const errors = data.errors ?? [];
        const bad = errors.length > 0 || data.valid === false;
        console.log(`${bad ? 'FAIL' : 'ok  '} ${entry.file} ${profile}: valid=${data.valid}, ${errors.length} error(s), ${(data.warnings ?? []).length} warning(s), ${nodeCount} nodes`);
        for (const error of errors) console.log(`  error: ${error.node ?? error.nodeName ?? ''} ${error.message ?? JSON.stringify(error)}`);
        if (bad) failed = true;
      }
      console.log(`${lint.length ? 'FAIL' : 'ok  '} ${entry.file} house-style lint: ${lint.length} problem(s)`);
      for (const problem of lint) console.log(`  lint: ${problem}`);
      if (lint.length) failed = true;
    }
  }
} finally {
  mcp.close();
  writeFileSync(join(resultsDir, 'n8n-mcp-validation.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(resultsDir, 'connections.txt'), `${connections.join('\n\n')}\n`);
}
if (failed) { console.error('FAIL: see results/n8n-mcp-validation.json'); process.exitCode = 1; }
else console.log(`PASS: n8n-mcp ${report.server?.version} validate_workflow (runtime and strict) found no errors; lint clean. Results: results/n8n-mcp-validation.json, results/connections.txt`);
