// Pure logic for "CRIT · Alert on errors" (inlined into its Code nodes, unit-tested in shared/tests).
// Input is n8n's Error Trigger item: { execution: { id, url, error: { message }, lastNodeExecuted, mode }, workflow: { id, name } }.

// Error messages can carry a URL or a header; strip anything shaped like a credential before it leaves n8n.
function redactSecrets(text) {
  return String(text == null ? '' : text)
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer <redacted>')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '<redacted key>')
    .replace(/(x-api-key|authorization|api[_-]?key|token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2<redacted>');
}

function describeFailure(trigger, editorBaseUrl) {
  const execution = (trigger && trigger.execution) || {};
  const workflow = (trigger && trigger.workflow) || {};
  const runId = execution.id == null ? '' : String(execution.id);
  const base = String(editorBaseUrl || '').replace(/\/+$/, '');
  const url = execution.url || (base && workflow.id && runId ? base + '/workflow/' + workflow.id + '/executions/' + runId : null);
  const error = execution.error || {};
  return {
    failed_run_id: runId,
    workflow_id: workflow.id || null,
    workflow_name: workflow.name || 'unknown workflow',
    failed_node: execution.lastNodeExecuted || (error.node && error.node.name) || 'unknown node',
    // n8n's message for an HTTP failure is generic ("The service was not able to process your request"); the
    // description carries what the service answered.
    message: redactSecrets([error.message, error.description].filter(Boolean).join(': ') || 'no error message').slice(0, 400),
    execution_url: url,
    mode: execution.mode || null,
  };
}

// released: the claims the data service handed back for the failed run ([{ scope, key, redelivers? }]).
// A claim taken with redelivers: false belongs to a sender that never sends the event again (Telegram after a 2xx,
// Slack after its 200, an internal call after its 202), so the alert must not promise a redelivery for it.
function alertText(failure, released) {
  const lines = [
    'Workflow failed: ' + failure.workflow_name,
    'Failed node: ' + failure.failed_node,
    'Error: ' + failure.message,
    'Execution: ' + (failure.execution_url || 'run ' + failure.failed_run_id + ' (no editor URL set)'),
  ];
  const claims = released || [];
  const name = entry => entry.scope + ':' + entry.key;
  const redelivered = claims.filter(entry => entry.redelivers !== false).map(name);
  const manual = claims.filter(entry => entry.redelivers === false).map(name);
  if (!claims.length) lines.push('No claim was held by this run.');
  if (redelivered.length) lines.push('Released for redelivery: ' + redelivered.join(', '));
  if (manual.length) lines.push('Handed back, but the sender does not redeliver: ' + manual.join(', ') + '. Nothing runs it again by itself: replay it by hand or act on it again (the workflow README says how).');
  return lines.join('\n');
}

function alertMessage(channel, failure, released) {
  return { channel: channel, text: alertText(failure, released), unfurl_links: false };
}
