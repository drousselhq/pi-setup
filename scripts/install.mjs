#!/usr/bin/env node
// Installs agent/ from this checkout into the Pi agent directory (default ~/.pi/agent).
//
// The install target is live: every Pi session and relay run uses it. The checkout is where changes are
// made and committed; installing is the release step. A manifest in the target records what was last
// installed, so a file changed in place (by hand, by an agent, or by Pi itself, e.g. settings.json) is
// detected instead of silently overwritten. Nothing is written unless every file can be applied.
//
//   node scripts/install.mjs              install, stopping on any drifted file
//   node scripts/install.mjs --check      show what would change, write nothing
//   node scripts/install.mjs --pull FILE  copy the installed FILE back into the checkout (to commit it)
//   node scripts/install.mjs --force FILE overwrite the drifted installed FILE with the checkout's version
//   --target DIR                          install somewhere else (used by the tests)
//
// FILE is a path relative to agent/, e.g. settings.json or prompts/plan.md. --pull and --force can repeat.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(REPO, 'agent');
const MANIFEST = '.pi-setup-install.json';

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out.sort();
}

function parseArgs(argv) {
  const opts = { check: false, target: path.join(os.homedir(), '.pi', 'agent'), pull: [], force: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--target') opts.target = path.resolve(argv[++i]);
    else if (a === '--pull') opts.pull.push(argv[++i]);
    else if (a === '--force') opts.force.push(argv[++i]);
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  for (const f of [...opts.pull, ...opts.force]) if (!f || f.startsWith('-')) throw new Error('--pull and --force need a file path');
  return opts;
}

function diff(a, b) {
  const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--', a, b], { encoding: 'utf8' });
  return r.stdout.trim();
}

// Decides, per file, what installing would do. Returns { actions, conflicts }.
export function plan(source, target, { force = [] } = {}) {
  const manifestFile = path.join(target, MANIFEST);
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const installed = manifest?.files ?? {};
  const actions = [];
  const conflicts = [];
  const files = listFiles(source);
  // Pi loads these from the agent directory as global instructions for every session.
  const global = files.filter((rel) => /^(AGENTS(\.override)?|CLAUDE)\.md$/i.test(rel));
  if (global.length) throw new Error(`${global.join(', ')} in agent/ would become global instructions for every Pi session; remove it.`);
  for (const rel of files) {
    const src = path.join(source, rel);
    const dst = path.join(target, rel);
    const s = sha(src);
    if (!fs.existsSync(dst)) { actions.push({ rel, op: 'add', hash: s }); continue; }
    const d = sha(dst);
    if (d === s) { actions.push({ rel, op: 'same', hash: s }); continue; }
    // Installed content differs from the checkout. Safe only if it is exactly what was last installed.
    if (installed[rel] === d || force.includes(rel)) actions.push({ rel, op: 'update', hash: s });
    else conflicts.push({ rel, reason: installed[rel] ? 'changed in place since the last install' : 'differs and was never installed by this script' });
  }
  for (const rel of Object.keys(installed)) {
    if (files.includes(rel)) continue;
    const dst = path.join(target, rel);
    if (!fs.existsSync(dst)) continue;
    if (sha(dst) === installed[rel] || force.includes(rel)) actions.push({ rel, op: 'remove' });
    else conflicts.push({ rel, reason: 'removed from the checkout but changed in place since the last install' });
  }
  return { actions, conflicts };
}

export function apply(source, target, actions) {
  for (const { rel, op } of actions) {
    const dst = path.join(target, rel);
    if (op === 'remove') { fs.rmSync(dst); continue; }
    if (op !== 'add' && op !== 'update') continue;
    const src = path.join(source, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.pi-setup-tmp`;
    fs.copyFileSync(src, tmp);
    fs.chmodSync(tmp, fs.statSync(src).mode & 0o777);
    fs.renameSync(tmp, dst); // atomic: a relay that already loaded the old file keeps running
  }
  const files = Object.fromEntries(actions.filter((a) => a.op !== 'remove').map((a) => [a.rel, a.hash]));
  const commit = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'agent'], { encoding: 'utf8' }).stdout.trim() !== '';
  const manifest = { source: REPO, commit: commit + (dirty ? '+uncommitted' : ''), installedAt: new Date().toISOString(), files };
  fs.writeFileSync(path.join(target, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  if (!fs.existsSync(opts.target)) throw new Error(`Target ${opts.target} does not exist.`);
  for (const rel of opts.pull) {
    const from = path.join(opts.target, rel);
    if (!fs.existsSync(from)) throw new Error(`Nothing installed at ${from}.`);
    fs.mkdirSync(path.dirname(path.join(SOURCE, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(SOURCE, rel));
    console.log(`pulled ${rel} into the checkout; review and commit it, then install`);
  }
  if (opts.pull.length) return 0;

  const { actions, conflicts } = plan(SOURCE, opts.target, { force: opts.force });
  const changes = actions.filter((a) => a.op !== 'same');
  for (const a of changes) console.log(`${a.op.padEnd(6)} ${a.rel}`);
  if (conflicts.length) {
    for (const c of conflicts) {
      console.log(`\nDRIFTED ${c.rel}: ${c.reason}`);
      const d = diff(path.join(SOURCE, c.rel), path.join(opts.target, c.rel));
      if (d) console.log(d.split('\n').map((l) => `  ${l}`).join('\n'));
    }
    console.log(`\nNothing was installed. For each drifted file, either keep the installed version`
      + ` (--pull FILE, then commit it) or replace it with the checkout's version (--force FILE).`);
    return 1;
  }
  if (opts.check) { console.log(changes.length ? `${changes.length} change(s) would be installed.` : 'Up to date.'); return 0; }
  apply(SOURCE, opts.target, actions);
  console.log(changes.length ? `Installed ${changes.length} change(s) into ${opts.target}.` : `Up to date (${opts.target}).`);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (e) { console.error(`install: ${e.message}`); process.exitCode = 2; }
}
