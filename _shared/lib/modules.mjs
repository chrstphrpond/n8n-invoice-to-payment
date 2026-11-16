// Pure-logic modules, loaded two ways from the same source:
//   - inlined into n8n Code nodes by the workflow's build script (codeNode below), and
//   - evaluated in Node for unit tests (load), so tests exercise exactly what n8n runs.
// Convention: plain .js files, no import/export, top-level declarations start at column 0
// (`function name`, `async function name`, `const NAME =`), and names are unique across all modules.
// require() is available for Node built-ins n8n allows (NODE_FUNCTION_ALLOW_BUILTIN=crypto).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const KIT_CODE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'code');
const DECLARATION = /^(?:async\s+)?function\s+(\w+)|^const\s+(\w+)\s*=/gm;

// files: absolute paths, in dependency order. The kit's ctx.js is always available.
export function createModules(files) {
  const all = [join(KIT_CODE_DIR, 'ctx.js'), ...files];
  const modules = all.map(path => {
    const source = readFileSync(path, 'utf8').trim();
    return { path, name: basename(path), source, names: [...source.matchAll(DECLARATION)].map(m => m[1] ?? m[2]) };
  });
  const names = modules.flatMap(module => module.names);
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  if (duplicates.length) throw new Error(`Duplicate top-level names across modules: ${[...new Set(duplicates)].join(', ')}`);
  const sourceOf = selected => selected.map(module => `// ---- ${module.name} ----\n${module.source}`).join('\n\n');

  // The modules a body needs: any module whose top-level names it uses, and their own dependencies.
  const resolve = bodyText => {
    const selected = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      const text = `${bodyText}\n${sourceOf(modules.filter(module => selected.has(module)))}`;
      for (const module of modules) {
        if (selected.has(module)) continue;
        if (module.names.some(name => new RegExp(`\\b${name}\\b`).test(text))) { selected.add(module); changed = true; }
      }
    }
    return modules.filter(module => selected.has(module));
  };

  return {
    modules,
    // Every top-level function and constant, evaluated in Node, with URL and URLSearchParams undefined as in n8n's
    // Code node sandbox (a module that uses them fails here too, not only in n8n).
    load() {
      return new Function('require', 'URL', 'URLSearchParams', `${sourceOf(modules)}\nreturn { ${names.join(', ')} };`)(require, undefined, undefined);
    },
    // Code node source: the modules the body needs, then the body. `from` names the node(s) whose output is the
    // working context (ctx); without it ctx is a copy of the input item. `response` is always the input item.
    codeSource(nodeName, body, { from = null } = {}) {
      const prelude = from
        ? `const ctx = ctxFrom($, ${JSON.stringify(from)});\nconst response = $input.first().json;`
        : 'const ctx = JSON.parse(JSON.stringify($input.first().json));\nconst response = ctx;';
      const glue = `// ---- ${nodeName} ----\n${prelude}\n${body.trim()}`;
      const needed = resolve(glue);
      return needed.length ? `${sourceOf(needed)}\n\n${glue}` : glue;
    },
  };
}
