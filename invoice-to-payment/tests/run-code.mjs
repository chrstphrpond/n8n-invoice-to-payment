// Runs one Code node of a generated workflow outside n8n, like the kit's runCodeNode, with multi-item support:
//   input:  one item's json, or { items: [json, ...] } for a node that takes several
//   nodes:  { 'Node name': json | { items: [json, ...] } } for $('Node').first() / .all()
//   binary: { data: Buffer } for this.helpers.getBinaryDataBuffer and $input.first().binary
//   runIndex: n8n's $runIndex (how many times this node already ran in the execution)
// Returns the output items as { json, pairedItem, binary }.
import { createRequire } from 'node:module';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const require = createRequire(import.meta.url);
const copy = value => JSON.parse(JSON.stringify(value));
const itemsOf = value => (value && Array.isArray(value.items) ? value.items : [value]).map(json => ({ json: copy(json) }));

export async function runCode(workflow, nodeName, { input = {}, nodes = {}, env = {}, executionId = '101', binary = null, runIndex = 0 } = {}) {
  const node = workflow.nodes.find(candidate => candidate.name === nodeName);
  if (!node) throw new Error(`No node named ${nodeName}`);
  const lookup = name => {
    if (!(name in nodes)) throw new Error(`Node '${name}' hasn't been executed`);
    const items = itemsOf(nodes[name]);
    return { first: () => items[0], all: () => items, itemMatching: index => items[index] };
  };
  const inputItems = itemsOf(input).map((item, index) => ({ ...item, pairedItem: { item: index }, ...(binary ? { binary: Object.fromEntries(Object.keys(binary).map(key => [key, { mimeType: 'application/pdf', fileName: 'x.pdf' }])) } : {}) }));
  const helpers = { getBinaryDataBuffer: async (_index, property) => { if (!binary || !binary[property]) throw new Error(`no binary ${property}`); return binary[property]; } };
  const run = new AsyncFunction('$', '$input', '$env', '$execution', '$runIndex', 'require', node.parameters.jsCode);
  const out = await run.call({ helpers }, lookup, { first: () => inputItems[0], all: () => inputItems }, env, { id: executionId }, runIndex, require);
  return out;
}

export const jsonOf = items => items.map(item => item.json);
