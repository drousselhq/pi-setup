import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

// ---------- an interrupted manifest write; the command line ----------

test('an install interrupted while writing the manifest keeps the previous one, and can be run again', () => {
  const { source, target } = dirs();
  install(source, target);
  fs.writeFileSync(path.join(source, 'prompts', 'plan.md'), 'plan v2\n');
  const real = fs.writeFileSync;
  fs.writeFileSync = (file, data, ...rest) => {
    if (/\.pi-setup-install\.json/.test(String(file))) { real(file, String(data).slice(0, 10), ...rest); throw new Error('ENOSPC: simulated'); }
    return real(file, data, ...rest);
  };
  try { assert.throws(() => apply(source, target, plan(source, target).actions), /simulated/); } finally { fs.writeFileSync = real; }
  const again = plan(source, target); // the previous manifest is intact: plan.md, already replaced, counts as unchanged
  assert.deepEqual(again.conflicts, []);
  apply(source, target, again.actions);
  assert.equal(fs.readFileSync(path.join(target, 'prompts', 'plan.md'), 'utf8'), 'plan v2\n');
});

test('an unreadable manifest is reported with what to do, not a parse error', () => {
  const { source, target } = dirs();
  install(source, target);
  fs.writeFileSync(path.join(target, '.pi-setup-install.json'), '{"source":');
  assert.throws(() => plan(source, target), /The install manifest .* is unreadable .* Restore it from a backup, or delete it/);
});

// The command line, on a copy of the script in a throwaway checkout: --pull writes into the checkout it runs from.
function cli() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-setup-cli-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'install.mjs'), path.join(root, 'scripts', 'install.mjs'));
  fs.mkdirSync(path.join(root, 'agent'));
  fs.writeFileSync(path.join(root, 'agent', 'a.md'), 'checkout\n');
  fs.mkdirSync(path.join(root, 'target'));
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts', 'install.mjs'), '--target', path.join(root, 'target'), ...args], { encoding: 'utf8' });
  return { root, run };
}

test('the command line: --check writes nothing, --check with --pull is refused, an unknown option is refused', () => {
  const { root, run } = cli();
  let r = run('--check');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /add +a\.md[\s\S]*1 change\(s\) would be installed\./);
  assert.deepEqual(fs.readdirSync(path.join(root, 'target')), [], 'nothing written');
  r = run();
  assert.equal(r.status, 0);
  fs.writeFileSync(path.join(root, 'target', 'a.md'), 'live\n');
  r = run('--check', '--pull', 'a.md');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--check writes nothing, but --pull copies installed files into the checkout: use one or the other/);
  assert.equal(fs.readFileSync(path.join(root, 'agent', 'a.md'), 'utf8'), 'checkout\n', 'the checkout is unchanged');
  r = run('--pull', 'a.md');
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'agent', 'a.md'), 'utf8'), 'live\n');
  assert.equal(run('--chek').status, 2);
});
