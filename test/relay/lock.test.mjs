// Taking over a stale lock: only under an exclusive guard, after reading the lock again, so two relays starting
// at the same moment cannot both run the topic, and one cannot remove the other's new lock.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeHerdr, StopRelay, makeProject, standard } from './harness.mjs';

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';
const flat = (h) => h.output.replace(/[┃\s]+/g, ' ');
const lockOf = (p) => p.file('relay/lock');
const DEAD = 424242;
const COMPETITOR = 515151;

function staleLock(p) {
  fs.mkdirSync(p.relayDir, { recursive: true });
  fs.writeFileSync(lockOf(p), String(DEAD));
}

test('a competitor that takes the stale lock over first keeps it: this relay stops and removes nothing', () => {
  const p = makeProject({ plan: ONE });
  staleLock(p);
  const h = new FakeHerdr(p, standard);
  // While this relay checks the stale lock's owner, another relay takes the lock over and is now running.
  h.ioExtra.processAlive = (pid) => {
    if (pid === DEAD) { fs.writeFileSync(lockOf(p), String(COMPETITOR)); return false; }
    return pid === COMPETITOR;
  };
  assert.equal(h.run(), 2);
  assert.match(flat(h), /Another relay \(pid 515151\) is running this topic/);
  assert.equal(fs.readFileSync(lockOf(p), 'utf8'), String(COMPETITOR), 'the competitor\'s lock is untouched');
  assert.ok(!fs.existsSync(`${lockOf(p)}.reclaim`), 'no guard left');
  assert.deepEqual(h.prompts, []);
});

test('a competitor that replaces an empty stale lock while this relay holds the guard keeps its new lock', () => {
  const p = makeProject({ plan: ONE });
  fs.mkdirSync(p.relayDir, { recursive: true });
  fs.writeFileSync(lockOf(p), ''); // a relay killed while writing its pid, over a minute ago
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lockOf(p), old, old);
  const h = new FakeHerdr(p, standard);
  const real = fs.writeFileSync;
  fs.writeFileSync = (file, ...rest) => {
    const r = real(file, ...rest);
    if (String(file).endsWith('/lock.reclaim')) { // meanwhile another relay replaces the lock: still empty, being written
      fs.rmSync(lockOf(p));
      real(lockOf(p), '');
    }
    return r;
  };
  try { assert.equal(h.run(), 2); } finally { fs.writeFileSync = real; }
  assert.match(flat(h), /Another relay is running this topic/);
  assert.ok(fs.existsSync(lockOf(p)), 'the competitor\'s new lock is not removed');
  assert.ok(!fs.existsSync(`${lockOf(p)}.reclaim`));
});

// A relay killed at a step of the takeover: every later file change and io call fails.
function killedAt(h, after) {
  const real = { writeFileSync: fs.writeFileSync, rmSync: fs.rmSync };
  let dead = false;
  const die = () => { if (dead) throw new StopRelay('killed'); };
  fs.writeFileSync = (file, ...rest) => { die(); const r = real.writeFileSync(file, ...rest); if (after(String(file), 'write')) dead = true; return r; };
  fs.rmSync = (file, ...rest) => { die(); const r = real.rmSync(file, ...rest); if (after(String(file), 'rm')) dead = true; return r; };
  const base = h.io();
  h.ioExtra = { herdr: (a) => { die(); return h.handle(a); }, write: (t) => { if (!dead) base.write(t); } };
  return () => { Object.assign(fs, real); h.ioExtra = {}; return dead; };
}

test('a relay killed during a takeover: the next start resumes or names the guard, never runs beside another', () => {
  for (const [step, after, expect] of [
    ['after taking the guard', (f, op) => op === 'write' && f.endsWith('/lock.reclaim'), 'named'],
    ['after removing the stale lock', (f, op) => op === 'rm' && f.endsWith('/relay/lock'), 'resumes'],
    ['after writing its own lock, before releasing the guard', (f, op) => op === 'write' && f.endsWith('/relay/lock'), 'named'],
  ]) {
    const p = makeProject({ plan: ONE });
    staleLock(p);
    const h = new FakeHerdr(p, standard);
    const restore = killedAt(h, after);
    let code;
    try { code = h.run(); } finally { assert.ok(restore(), `${step}: the kill happened`); }
    assert.equal(code, 1, step);
    h.output = '';
    if (expect === 'resumes') {
      assert.equal(h.run(), 0, `${step}: the next start takes the free lock`);
      assert.ok(!fs.existsSync(`${lockOf(p)}.reclaim`), `${step}: the orphaned guard is removed`);
    } else {
      assert.equal(h.run(), 2, step);
      assert.match(flat(h), /one was killed while taking over its lock\. Delete \S*lock\.reclaim/, step);
    }
  }
});

test('a guard left by a relay killed while taking the lock over: another starting relay is waited for, a dead one is named', () => {
  for (const [guardPid, alive, message] of [
    [COMPETITOR, true, /Another relay \(pid 515151\) is starting this topic/],
    [DEAD, false, /No relay is running this topic, but one was killed while taking over its lock\. Delete \S*lock\.reclaim and start pi-relay tt again\./],
  ]) {
    const p = makeProject({ plan: ONE });
    staleLock(p);
    fs.writeFileSync(`${lockOf(p)}.reclaim`, String(guardPid));
    const h = new FakeHerdr(p, standard);
    h.ioExtra.processAlive = (pid) => pid === guardPid && alive;
    assert.equal(h.run(), 2);
    assert.match(flat(h), message);
    assert.equal(fs.readFileSync(lockOf(p), 'utf8'), String(DEAD), 'the lock is not touched without the guard');
  }
});

test('a normal takeover of a stale lock leaves no guard behind', () => {
  const p = makeProject({ plan: ONE });
  staleLock(p);
  const h = new FakeHerdr(p, standard);
  assert.equal(h.run(), 0, 'the stale lock is taken over');
  assert.ok(!fs.existsSync(`${lockOf(p)}.reclaim`));
});

// Two real processes reclaim the same stale lock at the same moment, many times: exactly one may hold it.
const CHILD = `
import fs from 'node:fs';
const [lib, dir, barrier] = process.argv.slice(2);
const rt = await import(lib + '/runtime.mjs');
const { realIo } = await import(lib + '/io.mjs');
const { acquireLock } = await import(lib + '/store.mjs');
rt.setIo({ ...realIo, sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) });
Object.assign(rt.ctx, { relayDir: dir, project: dir, topic: 'tt' });
while (!fs.existsSync(barrier)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
try {
  acquireLock();
  console.log('acquired');
  // Hold the lock until the other process has decided (the test then creates the release file).
  while (!fs.existsSync(barrier + '.release')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
} catch (e) { console.log('stopped ' + e.message); }
`;

test('two processes reclaiming the same stale lock at once: exactly one holds it, every time', async () => {
  const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent', 'relay', 'lib');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-relay-lock-'));
  const child = path.join(root, 'child.mjs');
  fs.writeFileSync(child, CHILD);
  for (let round = 0; round < 12; round++) {
    const dir = path.join(root, `r${round}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'lock'), '999999'); // a relay that is no longer running
    const barrier = path.join(dir, 'go');
    const outs = ['', ''];
    const decided = () => outs.every((o) => o.includes('\n'));
    const runs = [0, 1].map((k) => new Promise((resolve) => {
      const c = spawn(process.execPath, [child, lib, dir, barrier]);
      c.stdout.on('data', (d) => {
        outs[k] += d;
        if (decided() && !fs.existsSync(`${barrier}.release`)) fs.writeFileSync(`${barrier}.release`, ''); // both decided
      });
      c.on('close', () => { // a process that crashed without deciding must not keep the other holding the lock
        if (!outs[k].includes('\n')) outs[k] += 'crashed\n';
        if (decided() && !fs.existsSync(`${barrier}.release`)) fs.writeFileSync(`${barrier}.release`, '');
        resolve(outs[k].trim());
      });
    }));
    await new Promise((r) => setTimeout(r, 150)); // both are waiting at the barrier
    fs.writeFileSync(barrier, '');
    const results = await Promise.all(runs);
    assert.equal(results.filter((r) => r === 'acquired').length, 1, `round ${round}: ${results.join(' | ')}`);
  }
});
