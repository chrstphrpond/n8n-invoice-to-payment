// Writes generated workflow files, or with check=true fails (exit code 1) when a file on disk is stale.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export function writeOrCheck(dir, files, check = false) {
  mkdirSync(dir, { recursive: true });
  let stale = false;
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    const text = `${JSON.stringify(content, null, 2)}\n`;
    if (check) {
      let current = '';
      try { current = readFileSync(target, 'utf8'); } catch { /* missing counts as stale */ }
      if (current !== text) { console.error(`${relative(process.cwd(), target)} is stale; rebuild it`); stale = true; }
    } else {
      writeFileSync(target, text);
      const nodes = Array.isArray(content.nodes) ? ` (${content.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote').length} nodes, ${content.nodes.filter(n => n.type === 'n8n-nodes-base.stickyNote').length} sticky notes)` : '';
      console.log(`wrote ${relative(process.cwd(), target)}${nodes}`);
    }
  }
  if (stale) process.exitCode = 1;
  return !stale;
}
