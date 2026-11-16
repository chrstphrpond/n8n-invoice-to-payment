// Builds the one error workflow every CRIT workflow attaches: "CRIT · Alert on errors" (id critAlertErrors1).
//   node shared/error-workflow/build.mjs           write workflow/alert-on-errors.json and workflow/manifest.json
//   node shared/error-workflow/build.mjs --check   fail if the files on disk are stale
// It hands the failed run's ledger claims back (so a redelivery or replay is processed again), then posts the
// workflow name, failed node, the real error message and the execution link to the alerts Slack channel, which no
// monitored workflow posts to. Both calls are non-critical: an error workflow must not fail itself.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV, ERROR_WORKFLOW_ID, Flow, at, codeNode, errorTriggerNode, httpNode } from '../lib/flow.mjs';
import { createModules } from '../lib/modules.mjs';
import { writeOrCheck } from '../lib/build-output.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const lib = createModules([join(here, 'lib', 'alert.js')]);
export const NAME = 'CRIT · Alert on errors';
export const TIMEZONE = 'UTC';

const NOTES = {
  'Receive workflow error': 'Runs when any CRIT workflow that names this one as its error workflow fails.',
  'Describe failure': 'Workflow, failed node, error message (credentials stripped) and the execution link.',
  'Release failed run': 'Data service: hands back the ledger claims the failed run held, so a redelivery is processed again. Non-critical.',
  'Prepare alert': 'Slack text for the alerts channel. Ids and links only, no customer data. A claim whose sender never redelivers is reported as needing a replay by hand, not as released for redelivery.',
  'Post alert to Slack': 'chat.postMessage to ALERTS_SLACK_CHANNEL. Non-critical.',
  'Summarize alert': 'Records whether the release and the alert went through.',
};

export function build() {
  const f = new Flow({ id: ERROR_WORKFLOW_ID, name: NAME, timezone: TIMEZONE, notes: NOTES, errorWorkflow: false });
  f.sticky('Read me', [
    '## CRIT · Alert on errors',
    'The error workflow of every CRIT workflow (`settings.errorWorkflow`). It runs when a run fails after its retries.',
    '**What it does**: hands the failed run\'s ledger claims back to the data service (marked failed, so the same event can be processed again), then posts the workflow name, the failed node, the real error message and the execution link to the alerts channel (ALERTS_SLACK_CHANNEL), which the monitored workflows never post to. A claim taken with redelivers: false (the sender never sends the event again) is reported as needing a replay by hand.',
    '**Config** from env: DATA_SERVICE_BASE_URL and DATA_SERVICE_TOKEN, ALERTS_SLACK_BASE_URL, ALERTS_SLACK_TOKEN and ALERTS_SLACK_CHANNEL, N8N_EDITOR_BASE_URL for the link. 3 retries 5 seconds apart on both calls.',
    '**Not covered by any error workflow**: trigger failures, hung runs, runs killed for memory, and green runs that did nothing. A watchdog per workflow covers those.',
  ].join('\n\n'), [170, -360], 1540, 340, 4);
  f.section('1. Release and alert', 'Describe the failure, give the claims back, tell the alerts channel.', [0, 0], [5, 0]);

  f.add(errorTriggerNode('Receive workflow error', at(0, 0)));
  f.add(codeNode('Describe failure', at(1, 0), lib.codeSource('Describe failure', `
const failure = describeFailure(ctx, $env.N8N_EDITOR_BASE_URL);
return [{ json: { ...failure, idem_base: 'alert:' + failure.failed_run_id, req: { body: { run_id: failure.failed_run_id, error: failure.message } } } }];`)));
  f.add(httpNode('Release failed run', at(2, 0), {
    method: 'POST', url: `${ENV('DATA_SERVICE_BASE_URL')}/v1/ledger/fail`, runId: true, soft: true,
    headers: { Authorization: `=Bearer ${ENV('DATA_SERVICE_TOKEN')}` },
  }));
  f.add(codeNode('Prepare alert', at(3, 0), lib.codeSource('Prepare alert', `
const release = httpOutcome(response);
const released = release.ok && Array.isArray(response.released) ? response.released : [];
ctx.release_ok = release.ok;
ctx.release_error = release.error;
ctx.released = released.map(entry => (entry.redelivers === false ? { scope: entry.scope, key: entry.key, redelivers: false } : { scope: entry.scope, key: entry.key }));
ctx.req = { body: alertMessage($env.ALERTS_SLACK_CHANNEL, ctx, ctx.released) };
return [{ json: ctx }];`, { from: ['Describe failure'] })));
  f.add(httpNode('Post alert to Slack', at(4, 0), {
    method: 'POST', url: `${ENV('ALERTS_SLACK_BASE_URL')}/api/chat.postMessage`, write: true, soft: true,
    headers: { Authorization: `=Bearer ${ENV('ALERTS_SLACK_TOKEN')}` },
  }));
  f.add(codeNode('Summarize alert', at(5, 0), lib.codeSource('Summarize alert', `
const posted = httpOutcome(response);
return [{ json: { failed_run_id: ctx.failed_run_id, workflow_name: ctx.workflow_name, failed_node: ctx.failed_node, released: ctx.released, release_ok: ctx.release_ok, alert_posted: posted.ok, alert_error: posted.error } }];`, { from: ['Prepare alert'] })));

  f.chain('Receive workflow error', 'Describe failure', 'Release failed run', 'Prepare alert', 'Post alert to Slack', 'Summarize alert');
  f.connect('Release failed run', 'Prepare alert', 1);
  f.connect('Post alert to Slack', 'Summarize alert', 1);
  return f.json();
}

export const MANIFEST = {
  slug: 'error-workflow',
  workflows: [{ file: 'alert-on-errors.json', id: ERROR_WORKFLOW_ID, name: NAME, webhooks: [], readOnlyPostNodes: [] }],
  env: [],
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeOrCheck(join(here, 'workflow'), { 'alert-on-errors.json': build(), 'manifest.json': MANIFEST }, process.argv.includes('--check'));
}
