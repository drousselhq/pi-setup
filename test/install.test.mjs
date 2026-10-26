import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { apply, plan } from '../scripts/install.mjs';

function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-setup-install-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(path.join(source, 'prompts'), { recursive: true });
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'prompts', 'plan.md'), 'plan v1\n');
  fs.writeFileSync(path.join(source, 'settings.json'), '{"a":1}\n');
  fs.writeFileSync(path.join(source, 'run.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
  return { source, target };
}
const ops = (actions) => Object.fromEntries(actions.map((a) => [a.rel, a.op]));
const install = (source, target, opts) => {
  const p = plan(source, target, opts);
  assert.deepEqual(p.conflicts, []);
  apply(source, target, p.actions);
  return p;
};

test('a first install adds every file, keeps modes and records them', () => {
  const { source, target } = dirs();
  const p = install(source, target);
  assert.deepEqual(ops(p.actions), { 'prompts/plan.md': 'add', 'run.mjs': 'add', 'settings.json': 'add' });
  assert.equal(fs.readFileSync(path.join(target, 'prompts', 'plan.md'), 'utf8'), 'plan v1\n');
  assert.equal(fs.statSync(path.join(target, 'run.mjs')).mode & 0o777, 0o755);
  const manifest = JSON.parse(fs.readFileSync(path.join(target, '.pi-setup-install.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.files).sort(), ['prompts/plan.md', 'run.mjs', 'settings.json']);
});

test('identical files need no change, even without a manifest', () => {
  const { source, target } = dirs();
  fs.cpSync(source, target, { recursive: true });
  assert.deepEqual(new Set(plan(source, target).actions.map((a) => a.op)), new Set(['same']));
});

test('a change in the checkout updates a file installed unchanged', () => {
  const { source, target } = dirs();
  install(source, target);
  fs.writeFileSync(path.join(source, 'prompts', 'plan.md'), 'plan v2\n');
  const p = install(source, target);
  assert.equal(ops(p.actions)['prompts/plan.md'], 'update');
  assert.equal(fs.readFileSync(path.join(target, 'prompts', 'plan.md'), 'utf8'), 'plan v2\n');
});

test('a file changed in place is a conflict, and --force overwrites it', () => {
  const { source, target } = dirs();
  install(source, target);
  fs.writeFileSync(path.join(target, 'settings.json'), '{"a":2}\n'); // e.g. Pi updated it
  fs.writeFileSync(path.join(source, 'prompts', 'plan.md'), 'plan v2\n');
  const p = plan(source, target);
  assert.deepEqual(p.conflicts.map((c) => c.rel), ['settings.json']);
  assert.match(p.conflicts[0].reason, /changed in place/);
  const forced = install(source, target, { force: ['settings.json'] });
  assert.equal(ops(forced.actions)['settings.json'], 'update');
  assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), '{"a":1}\n');
});

test('a differing file never installed by the script is a conflict', () => {
  const { source, target } = dirs();
  fs.mkdirSync(path.join(target, 'prompts'));
  fs.writeFileSync(path.join(target, 'prompts', 'plan.md'), 'hand-made\n');
  assert.deepEqual(plan(source, target).conflicts.map((c) => [c.rel, c.reason]), [['prompts/plan.md', 'differs and was never installed by this script']]);
});

test('an AGENTS.md at the top of agent/ is refused', () => {
  const { source, target } = dirs();
  fs.writeFileSync(path.join(source, 'AGENTS.md'), 'x');
  assert.throws(() => plan(source, target), /global instructions/);
});

test('a file removed from the checkout is removed if unchanged, a conflict if changed', () => {
  const { source, target } = dirs();
  install(source, target);
  fs.rmSync(path.join(source, 'run.mjs'));
  assert.equal(ops(plan(source, target).actions)['run.mjs'], 'remove');
  fs.writeFileSync(path.join(target, 'run.mjs'), 'edited\n');
  assert.deepEqual(plan(source, target).conflicts.map((c) => c.rel), ['run.mjs']);
  fs.writeFileSync(path.join(target, 'run.mjs'), '#!/usr/bin/env node\n');
  install(source, target);
  assert.equal(fs.existsSync(path.join(target, 'run.mjs')), false);
});
