#!/usr/bin/env node
// Prints a node's live schema from n8n-mcp, so nodes are configured from the schema, never from memory.
//   node shared/bin/get-node.mjs nodes-base.httpRequest [detail] [mode]
//   node shared/bin/get-node.mjs --tools        lists the server's tools and their input schemas
import { openN8nMcp } from '../lib/n8n-mcp-client.mjs';

const [nodeType, detail = 'standard', mode] = process.argv.slice(2);
if (!nodeType) {
  console.error('usage: node shared/bin/get-node.mjs <nodeType> [minimal|standard|full] [mode] | --tools');
  process.exit(2);
}
const mcp = await openN8nMcp();
try {
  if (nodeType === '--tools') {
    for (const tool of mcp.tools) console.log(JSON.stringify({ name: tool.name, required: tool.inputSchema?.required, properties: Object.keys(tool.inputSchema?.properties ?? {}) }));
  } else {
    const args = { nodeType, detail };
    if (mode) args.mode = mode;
    console.log(JSON.stringify(await mcp.call('get_node', args), null, 2));
  }
} finally {
  mcp.close();
}
