// House-style checks on a workflow JSON. Returns a list of problems (empty = passes).
// Used by Flow.json() at build time and by shared/bin/validate.mjs on the files on disk (so an editor export that
// drifted from the rules is caught too).
export const VERBS = [
  'Accept', 'Add', 'Alert', 'Apply', 'Build', 'Check', 'Claim', 'Classify', 'Compose', 'Create', 'Decide', 'Describe',
  'Download', 'Extract', 'Fetch', 'Find', 'Format', 'Get', 'Hash', 'Load', 'Mark', 'Merge', 'Normalize', 'Notify',
  'Parse', 'Pick', 'Post', 'Prepare', 'Read', 'Receive', 'Record', 'Refuse', 'Release', 'Reply', 'Respond', 'Route',
  'Save', 'Score', 'Search', 'Send', 'Split', 'Store', 'Summarize', 'Update', 'Upload', 'Validate', 'Verify', 'Wait',
];

// verbs: extra verbs a workflow's manifest allows on top of VERBS (manifest "verbs": ["Expire", ...]).
// noRetryNodes: the manifest's documented exceptions to the retry rule, [{ node, reason }]: HTTP Request nodes that
// are paid calls without idempotency and may have retries off. Each needs a reason and must name an HTTP node.
export function lintWorkflow(workflow, { isErrorWorkflow = false, readOnlyPostNodes = [], verbs = [], noRetryNodes = [] } = {}) {
  const problems = [];
  const allowedVerbs = new Set([...VERBS, ...verbs]);
  const nodes = workflow.nodes ?? [];
  const byName = new Map(nodes.map(node => [node.name, node]));
  const connections = workflow.connections ?? {};
  const isSticky = node => node.type === 'n8n-nodes-base.stickyNote';
  const isTrigger = node => /Trigger$|\.webhook$/.test(node.type);

  if (!/^[A-Za-z0-9]{16}$/.test(workflow.id ?? '')) problems.push(`id must be 16 letters or digits (got ${JSON.stringify(workflow.id)})`);
  if (!String(workflow.name ?? '').startsWith('CRIT · ')) problems.push('name must start with "CRIT · "');
  if (!workflow.settings?.timezone) problems.push('settings.timezone is not set');
  if (workflow.settings?.executionOrder !== 'v1') problems.push('settings.executionOrder must be v1');
  if (!isErrorWorkflow && !workflow.settings?.errorWorkflow) problems.push('settings.errorWorkflow is not set');
  if (nodes.length !== byName.size) problems.push('node names are not unique');
  const noRetry = new Set();
  for (const entry of noRetryNodes) {
    const name = entry && typeof entry === 'object' ? entry.node : entry;
    if (!entry || typeof entry !== 'object' || typeof entry.reason !== 'string' || !entry.reason.trim()) problems.push(`noRetryNodes entry ${JSON.stringify(name ?? entry)}: needs { node, reason } with a reason`);
    else if (!byName.has(name)) problems.push(`noRetryNodes entry "${name}": no such node`);
    else if (byName.get(name).type !== 'n8n-nodes-base.httpRequest') problems.push(`noRetryNodes entry "${name}": not an HTTP Request node`);
    else noRetry.add(name);
  }

  const stickies = nodes.filter(isSticky);
  if (!stickies.some(node => node.name === 'Read me')) problems.push('no "Read me" sticky note');
  if (!stickies.some(node => /^\d+\. /.test(node.name))) problems.push('no numbered section sticky ("1. ...")');

  for (const node of nodes.filter(n => !isSticky(n))) {
    const verb = node.name.split(' ')[0];
    if (!allowedVerbs.has(verb)) problems.push(`"${node.name}": name must start with a verb from lint.mjs VERBS or the manifest's verbs`);
    if (!node.notes || !String(node.notes).trim()) problems.push(`"${node.name}": no note`);
    if (node.notesInFlow !== true) problems.push(`"${node.name}": notesInFlow is not true`);
    if (node.type === 'n8n-nodes-base.httpRequest') {
      if (!noRetry.has(node.name) && (node.retryOnFail !== true || node.maxTries !== 4 || node.waitBetweenTries !== 5000)) problems.push(`"${node.name}": needs retryOnFail, maxTries 4, waitBetweenTries 5000`);
      const method = node.parameters?.method ?? 'GET';
      const headers = node.parameters?.headerParameters?.parameters ?? [];
      const runId = headers.find(header => header.name === 'X-Run-Id');
      if (method !== 'GET' && !readOnlyPostNodes.includes(node.name) && !(runId && /\$execution\.id/.test(runId.value))) problems.push(`"${node.name}": a ${method} that changes state must send X-Run-Id = $execution.id`);
      const key = headers.find(header => header.name === 'Idempotency-Key');
      if (key && !String(key.value).endsWith(`:${node.name}`)) problems.push(`"${node.name}": Idempotency-Key must end with ":${node.name}"`);
    }
    if (node.onError === 'continueErrorOutput' && !(connections[node.name]?.main?.[1]?.length > 0)) problems.push(`"${node.name}": onError continueErrorOutput but output 1 is not wired`);
  }

  // Wiring: every target exists, no orphan nodes.
  const incoming = new Set();
  for (const [from, outputs] of Object.entries(connections)) {
    if (!byName.has(from)) problems.push(`connection from unknown node "${from}"`);
    for (const output of outputs.main ?? []) for (const link of output ?? []) {
      if (!byName.has(link.node)) problems.push(`"${from}" connects to unknown node "${link.node}"`);
      incoming.add(link.node);
    }
  }
  for (const node of nodes) if (!isSticky(node) && !isTrigger(node) && !incoming.has(node.name)) problems.push(`"${node.name}" has no incoming connection`);

  // Webhooks in responseNode mode: every path from the webhook must pass a Respond to Webhook node.
  const memo = new Map();
  const everyPathResponds = (name, passed, trail) => {
    const memoKey = `${name}|${passed}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    if (trail.has(name)) return true;
    const node = byName.get(name);
    const now = passed || node?.type === 'n8n-nodes-base.respondToWebhook';
    const next = (connections[name]?.main ?? []).flat().filter(Boolean).map(link => link.node);
    const nextTrail = new Set(trail).add(name);
    const result = next.length === 0 ? now : next.every(target => everyPathResponds(target, now, nextTrail));
    memo.set(memoKey, result);
    return result;
  };
  for (const hook of nodes.filter(node => node.type === 'n8n-nodes-base.webhook')) {
    if (hook.parameters?.responseMode !== 'responseNode') problems.push(`"${hook.name}": responseMode must be responseNode (answer deliberately)`);
    else if (!everyPathResponds(hook.name, false, new Set())) problems.push(`"${hook.name}": a path ends without a Respond to Webhook node`);
  }
  return problems;
}
