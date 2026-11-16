// The environment n8n is started with: an allowlist, never a copy of the caller's environment.
// Workflows read their config with $env, which needs N8N_BLOCK_ENV_ACCESS_IN_NODE=false; that lets any Code node
// read every variable n8n has, so n8n must only have what it needs. shared/bin/n8n-local.sh applies the same rule
// with `env -i` for the local editor.
export const SYSTEM_VARIABLES = ['PATH', 'HOME', 'TMPDIR', 'LANG'];

// Settings every CRIT n8n gets: 127.0.0.1 only, telemetry, version checks, templates and personalisation off,
// execution history pruned, env access for $env config, crypto for hashes and timing-safe compares.
export const KIT_N8N_SETTINGS = {
  N8N_HOST: '127.0.0.1',
  N8N_LISTEN_ADDRESS: '127.0.0.1',
  N8N_SECURE_COOKIE: 'false',
  N8N_DIAGNOSTICS_ENABLED: 'false',
  N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
  N8N_TEMPLATES_ENABLED: 'false',
  N8N_PERSONALIZATION_ENABLED: 'false',
  EXECUTIONS_DATA_PRUNE: 'true',
  EXECUTIONS_DATA_MAX_AGE: '168',
  EXECUTIONS_DATA_PRUNE_MAX_COUNT: '500',
  EXECUTIONS_DATA_HARD_DELETE_BUFFER: '0',
  N8N_BLOCK_ENV_ACCESS_IN_NODE: 'false',
  NODE_FUNCTION_ALLOW_BUILTIN: 'crypto',
};

// Variables the shared error workflow reads.
export const KIT_WORKFLOW_VARIABLES = ['GENERIC_TIMEZONE', 'DATA_SERVICE_BASE_URL', 'DATA_SERVICE_TOKEN', 'ALERTS_SLACK_BASE_URL', 'ALERTS_SLACK_TOKEN', 'ALERTS_SLACK_CHANNEL'];

// settings: every variable set on purpose. A name that is neither N8N_*, a kit variable, a system variable
// nor in `allowed` (the workflow manifest's env list) is a bug, so it throws.
export function buildN8nEnv(settings, allowed = [], system = process.env) {
  const ok = name => name.startsWith('N8N_') || SYSTEM_VARIABLES.includes(name) || KIT_WORKFLOW_VARIABLES.includes(name) || allowed.includes(name) || name in KIT_N8N_SETTINGS;
  const env = {};
  for (const name of SYSTEM_VARIABLES) if (system[name] !== undefined) env[name] = system[name];
  for (const [name, value] of Object.entries({ ...KIT_N8N_SETTINGS, ...settings })) {
    if (!ok(name)) throw new Error(`${name} is not on the n8n environment allowlist (add it to the workflow manifest's env list)`);
    if (value !== undefined && value !== null) env[name] = String(value);
  }
  return env;
}
