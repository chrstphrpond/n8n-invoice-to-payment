// Runs one Code node of a generated workflow outside n8n with stand-in n8n globals, so the glue is unit-testable.
//   nodes:    output of other nodes by name: one item's json, or an array of item jsons for a node that returned
//             several items. $('Node').first(), .last(), .all() and .item work; a node not listed "did not run"
//             and $() throws.
//   input:    the item the node receives ($input.first().json), or an array of item jsons ($input.all()).
//   binary:   { data: Buffer } for getBinaryDataBuffer.
//   runIndex: $runIndex, the node's run number inside a loop (0 on the first run).
// Like n8n's Code node sandbox (the task runner), the code runs with URL and URLSearchParams undefined, so a unit
// test fails where n8n would ("URLSearchParams is not defined").
import { createRequire } from 'node:module';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const require = createRequire(import.meta.url);
export const SANDBOX_MISSING_GLOBALS = ['URL', 'URLSearchParams'];

const copy = value => JSON.parse(JSON.stringify(value));
function itemsAccessor(value) {
  const items = (Array.isArray(value) ? value : [value]).map(json => ({ json: copy(json) }));
  return {
    first: () => items[0],
    last: () => items[items.length - 1],
    all: () => items,
    get item() { return items[0]; },
  };
}

export async function runCodeNode(workflow, nodeName, { input = {}, nodes = {}, env = {}, executionId = '101', binary = {}, runIndex = 0 } = {}) {
  const node = workflow.nodes.find(candidate => candidate.name === nodeName);
  if (!node) throw new Error(`No node named ${nodeName}`);
  const lookup = name => {
    if (!(name in nodes)) throw new Error(`Node '${name}' hasn't been executed`);
    return itemsAccessor(nodes[name]);
  };
  const helpers = { getBinaryDataBuffer: async (_index, property) => { if (!binary[property]) throw new Error(`no binary ${property}`); return binary[property]; } };
  const run = new AsyncFunction('$', '$input', '$env', '$execution', '$runIndex', 'require', ...SANDBOX_MISSING_GLOBALS, node.parameters.jsCode);
  const items = await run.call({ helpers }, lookup, itemsAccessor(input), env, { id: executionId }, runIndex, require, ...SANDBOX_MISSING_GLOBALS.map(() => undefined));
  return items.map(item => item.json);
}
