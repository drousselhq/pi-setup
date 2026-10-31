// Every name a relay module uses from another module must be imported. The behaviour tests do not reach
// every path, so this catches a missing import (a ReferenceError at run time) statically.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent', 'relay', 'lib');
const modules = fs.readdirSync(LIB).filter((f) => f.endsWith('.mjs'));
const source = Object.fromEntries(modules.map((m) => [m, fs.readFileSync(path.join(LIB, m), 'utf8')]));
const exported = (src) => [...src.matchAll(/^export (?:async )?(?:function|const|let|class) ([\w$]+)/gm)].map((m) => m[1]);
const imported = (src) => new Set([...src.matchAll(/^import \{([^}]+)\} from '\.\/[\w-]+\.mjs';/gm)].flatMap((m) => m[1].split(',').map((x) => x.trim())));
// Code without comments and single-quoted strings, so prose does not count as use.
const code = (src) => src.replace(/'(?:\\.|[^'\\\n])*'/g, "''").replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('every cross-module name a relay module uses is imported', () => {
  const owners = {};
  for (const m of modules) for (const n of exported(source[m])) owners[n] = m;
  const missing = [];
  for (const m of modules) {
    const own = new Set(exported(source[m]));
    const imp = imported(source[m]);
    const body = code(source[m]).replace(/^import .*$/gm, '');
    for (const [n, owner] of Object.entries(owners)) {
      if (owner === m || own.has(n) || imp.has(n)) continue;
      // A use: the bare name, not a property (x.name) or an object key (name: value).
      const use = new RegExp(`(?<![\\w$.])${n.replace('$', '\\$')}(?![\\w$])(?!\\s*:(?!:))`);
      const locals = new RegExp(`\\b(?:const|let|var|function)\\s+${n}\\b|[(,]\\s*${n}\\s*[,)=]|\\bfor \\(const ${n}\\b`);
      if (use.test(body) && !locals.test(body)) missing.push(`${m} uses ${n} from ${owner}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the relay README shows the plan format the planner is given', async () => {
  const { PLAN_FORMAT } = await import(path.join(LIB, 'plan.mjs'));
  assert.ok(fs.readFileSync(path.join(LIB, '..', 'README.md'), 'utf8').includes(PLAN_FORMAT));
});

test('runtime.mjs imports no other relay module', () => {
  assert.equal(imported(source['runtime.mjs']).size, 0);
});
