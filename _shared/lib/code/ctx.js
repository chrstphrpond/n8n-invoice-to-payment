// Kit helpers injected into Code nodes (plain JS, no imports; top-level names must be unique across modules).
// Context plumbing: an HTTP Request node replaces the item with the response, so the Code node after it reloads
// the working context from the node that prepared the request ($('Prepare ...')). On a path where a candidate
// node did not run, $() throws, and the next candidate is tried.
function ctxFrom($, names) {
  for (const name of names) {
    try {
      const item = $(name).first();
      if (item && item.json) return JSON.parse(JSON.stringify(item.json));
    } catch (error) {
      // that node did not run on this path
    }
  }
  throw new Error('Context not found in any of: ' + names.join(', '));
}

// Reads an HTTP Request node's output: a normal JSON answer, or the item n8n puts on the error output
// ({ error: ... }). An API that answers 200 with { ok: false } (Slack, Telegram) counts as a failure too.
function httpOutcome(response) {
  if (!response || typeof response !== 'object') return { ok: false, error: 'empty response' };
  if (response.error) {
    const err = response.error;
    const message = typeof err === 'string' ? err : (err.message || err.description || JSON.stringify(err));
    return { ok: false, error: String(message).slice(0, 300) };
  }
  if (response.ok === false) return { ok: false, error: String(response.description || response.error || 'ok: false').slice(0, 300) };
  return { ok: true, error: null };
}
