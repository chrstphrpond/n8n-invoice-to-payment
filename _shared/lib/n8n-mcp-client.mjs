// A minimal stdio client for the n8n-mcp server in documentation mode.
// It never gets N8N_API_URL or N8N_API_KEY, so it cannot touch an n8n instance; telemetry is off.
// The server binary: N8N_MCP_BIN, or the machine copy in ~/.local/share/n8n-mcp.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function n8nMcpBin() {
  const bin = process.env.N8N_MCP_BIN || join(homedir(), '.local/share/n8n-mcp/node_modules/.bin/n8n-mcp');
  if (!existsSync(bin)) throw new Error(`n8n-mcp not found at ${bin}. Install it (documentation mode) or set N8N_MCP_BIN.`);
  return bin;
}

export async function openN8nMcp({ timeoutMs = 180000 } = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, MCP_MODE: 'stdio', N8N_MCP_TELEMETRY_DISABLED: 'true', LOG_LEVEL: 'error', DISABLE_CONSOLE_OUTPUT: 'true' };
  const child = spawn(n8nMcpBin(), [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let nextId = 0;
  const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    }
  });
  child.stderr.on('data', () => {});
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`n8n-mcp did not answer ${method} within ${timeoutMs / 1000}s`)), timeoutMs);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'crit-n8n-kit', version: '1.0.0' } });
  if (!init.result) { child.kill(); throw new Error(`n8n-mcp initialize failed: ${JSON.stringify(init.error)}`); }
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const listed = await request('tools/list', {});
  const tools = listed.result?.tools ?? [];
  return {
    server: init.result.serverInfo,
    tools,
    async call(name, args) {
      const answer = await request('tools/call', { name, arguments: args });
      if (!answer.result) throw new Error(`${name}: ${JSON.stringify(answer.error)}`);
      if (answer.result.structuredContent) return answer.result.structuredContent;
      const text = answer.result.content?.map(part => part.text ?? '').join('\n') ?? '';
      try { return JSON.parse(text); } catch { return text; }
    },
    close() { child.kill(); },
  };
}
