// Runs the invoicing stand-ins on a fixed local port for the n8n editor, with the placeholder tokens from env.sh
// (source it first):   ( . ./env.sh && node standins/serve.mjs )
// Ctrl-C stops it. Requests and state: GET /__log, GET /__state.
import { slackAlerts } from '../../_shared/lib/slack-alerts.mjs';
import { startStandin } from '../../_shared/lib/standin.mjs';
import { invoiceModules } from './index.mjs';

const env = process.env;
for (const name of ['STANDIN_PORT', 'DATA_SERVICE_TOKEN', 'ALERTS_SLACK_TOKEN', 'PDF_API_TOKEN', 'STORAGE_TOKEN', 'EMAIL_API_KEY', 'PAYMENTS_API_KEY']) {
  if (!env[name]) { console.error(`${name} is not set: run ( . ./env.sh && node standins/serve.mjs )`); process.exit(2); }
}
const secrets = { data: env.DATA_SERVICE_TOKEN, pdf: env.PDF_API_TOKEN, storage: env.STORAGE_TOKEN, email: env.EMAIL_API_KEY, payments: env.PAYMENTS_API_KEY };
const standin = await startStandin({ modules: [...invoiceModules({ secrets }), slackAlerts({ token: env.ALERTS_SLACK_TOKEN })], port: Number(env.STANDIN_PORT) });
console.log(`invoicing stand-ins on ${standin.url} (log: ${standin.url}/__log, state: ${standin.url}/__state). Ctrl-C to stop.`);
const stop = async () => { await standin.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
