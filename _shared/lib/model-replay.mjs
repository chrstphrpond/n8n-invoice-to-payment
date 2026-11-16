// Stand-in for the Anthropic Messages API that answers from hand-written fixture files: no model is called.
// The workflow's model step is a plain HTTP Request to {ANTHROPIC_BASE_URL}/v1/messages; in tests the base URL
// points here, in production at https://api.anthropic.com with a real key. Nothing else changes.
//
// It checks the request the way the real API would refuse it (key, version header, model, a JSON-schema
// output_config, a final user turn, no sampling parameters), then picks a fixture with resolveFixture(body),
// a function the workflow supplies (for example: hash the image in the request and look it up).
// Fixture file: fixtures/llm/<name>.json  { "synthetic": true, "note": "...", "response": { ...Messages API response } }
// The replayed answer gets the request's model and a stable message id.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ANTHROPIC_VERSION = '2026-10-21';

export function modelReplay({ fixturesDir, resolveFixture, model, prefix = '/anthropic', apiKey, apiVersion = ANTHROPIC_VERSION }) {
  const apiError = (status, type, message) => ({ status, body: { type: 'error', error: { type, message } } });
  return {
    name: 'model',
    init: () => ({ answered: [] }),
    view: s => s,
    routes: [{
      method: 'POST', path: `${prefix}/v1/messages`, op: 'anthropic.messages',
      auth: req => !apiKey || req.headers['x-api-key'] === apiKey,
      handle: (req, s) => {
        const body = req.body ?? {};
        const problems = [];
        if (req.headers['anthropic-version'] !== apiVersion) problems.push(`anthropic-version must be ${apiVersion}`);
        if (model && body.model !== model) problems.push(`unexpected model ${body.model}`);
        if (body.output_config?.format?.type !== 'json_schema' || typeof body.output_config.format.schema !== 'object') problems.push('output_config.format must be a json_schema');
        for (const banned of ['temperature', 'top_p', 'top_k']) if (banned in body) problems.push(`${banned} is not accepted`);
        if (body.tool_choice && ['any', 'tool'].includes(body.tool_choice.type)) problems.push('forced tool_choice is not supported for this model');
        if (!Array.isArray(body.messages) || body.messages.at(-1)?.role !== 'user') problems.push('messages must end with a user turn');
        if (!Number.isInteger(body.max_tokens)) problems.push('max_tokens is required');
        if (problems.length) return apiError(400, 'invalid_request_error', problems.join('; '));
        const name = resolveFixture(body);
        const file = name ? join(fixturesDir, `${name}.json`) : null;
        if (!file || !existsSync(file)) return apiError(500, 'api_error', `stand-in: no fixture for this request (${name ?? 'unresolved'})`);
        const fixture = JSON.parse(readFileSync(file, 'utf8'));
        s.answered.push(name);
        return { status: 200, body: { id: `msg_fixture_${name}`, type: 'message', role: 'assistant', model: body.model, ...fixture.response }, log: { fixture: name } };
      },
    }],
  };
}

// Content blocks of a request, flattened (for resolveFixture implementations).
export function requestBlocks(body) {
  return (body.messages ?? []).flatMap(message => (Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }]));
}
