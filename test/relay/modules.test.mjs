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
// Code without comments, string text and template-literal text (the code in ${...} kept), so prose in
// messages does not count as use. Regular-expression literals are code: the relay's contain no quotes.
function code(src) {
  const end = (next, at) => { // fail at once, rather than loop, on an unterminated string or comment
    if (next <= 0 || next > src.length) throw new Error(`modules.test: cannot read the source near: ${src.slice(at, at + 60)}`);
    return next;
  };
  let out = '';
  const braces = []; // per open ${: the depth of plain { } inside it
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && src[i + 1] === '*') { i = end(src.indexOf('*/', i + 2) + 1, i); out += ' '; continue; }
    if (ch === "'" || ch === '"') { // a string: its text dropped
      i++;
      while (src[i] !== ch) i = end(i + (src[i] === '\\' ? 2 : 1), i);
      out += "''";
      continue;
    }
    if (ch === '`' || (ch === '}' && braces.length && braces.at(-1) === 0)) { // template text up to ` or ${
      if (ch === '}') braces.pop();
      i++;
      while (src[i] !== '`' && !(src[i] === '$' && src[i + 1] === '{')) i = end(i + (src[i] === '\\' ? 2 : 1), i);
      if (src[i] === '$') { braces.push(0); i++; out += ' '; } else out += "''";
      continue;
    }
    if (braces.length && ch === '{') braces[braces.length - 1]++;
    if (braces.length && ch === '}') braces[braces.length - 1]--;
    out += ch;
  }
  return out;
}

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

test('every name a relay module imports from another one is used', () => {
  const unused = [];
  for (const m of modules) {
    const body = code(source[m]).replace(/^import .*$/gm, '');
    for (const n of imported(source[m])) {
      // A use: the bare name, not a property (x.name); a spread (...name) counts.
      if (!new RegExp(`(?<![\\w$])(?<![^.]\\.)${n.replace('$', '\\$')}(?![\\w$])`).test(body)) unused.push(`${m} imports ${n} without using it`);
    }
  }
  assert.deepEqual(unused, []);
});

test('the module checks ignore names in strings, messages and comments, but not in template code', () => {
  const body = code(`const a = 'run'; const b = "valid"; // prompt\nconst c = \`Use run here \${valid(x)} \${y ? \`n \${prompt}\` : '{'} done\`;`);
  assert.doesNotMatch(body, /\brun\b/);
  assert.match(body, /valid\(x\)/);
  assert.match(body, /\bprompt\b/);
  assert.throws(() => code("const r = /'/;"), /cannot read the source near/);
});
