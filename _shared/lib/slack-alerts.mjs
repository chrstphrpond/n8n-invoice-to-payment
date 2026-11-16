// Stand-in for the one Slack Web API method the shared error workflow uses: chat.postMessage to the alerts
// channel. Slack answers HTTP 200 with { ok: false, error } for its own errors, so does this stand-in.
// Slack does not honor Idempotency-Key; the stand-in logs the key and never replays it, like Slack.
import { bearer } from './standin.mjs';

export function slackAlerts({ token, prefix = '/slack' }) {
  return {
    name: 'slack',
    init: () => ({ messages: [], nextTs: 1 }),
    view: s => ({ messages: s.messages }),
    routes: [{
      method: 'POST', path: `${prefix}/api/chat.postMessage`, op: 'slack.post_message', idempotency: 'ignore', auth: bearer(token),
      handle: (req, s) => {
        const { channel, text } = req.body ?? {};
        if (!channel) return { status: 200, body: { ok: false, error: 'channel_not_found' } };
        if (!text && !req.body?.blocks) return { status: 200, body: { ok: false, error: 'no_text' } };
        const ts = `1790000000.${String(s.nextTs++).padStart(6, '0')}`;
        s.messages.push({ channel, text, blocks: req.body.blocks ?? null, ts });
        return { status: 200, body: { ok: true, channel: channel.startsWith('#') ? 'C0STANDIN01' : channel, ts } };
      },
    }],
  };
}
