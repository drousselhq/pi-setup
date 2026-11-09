// Fault injection for the relay: kills it at every state save of a scenario and checks that restarting it
// completes the same work. The relay's clock advances 3 s at every prompt, as real work takes time, so
// windows that depend on a result file's age (a question older than a step's send time) are exercised. A kill is total: from that point every file change and every io call of the
// relay fails (the process is gone); only what reached the disk before counts. Each save is killed just
// before it (its data is lost) and just after it (it reached the disk, nothing later did).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FakeHerdr, TOPIC, makeProject } from './harness.mjs';

export class Killed extends Error {}

const MUTATING = ['writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'copyFileSync', 'mkdirSync', 'utimesSync', 'cpSync', 'rmdirSync'];

// Arms a kill at save `k` (`before` or `after`) of project `p`; `k` 0 counts saves without killing.
function arm(p, h, k, mode) {
  const real = Object.fromEntries([...MUTATING, 'openSync'].map((n) => [n, fs[n]]));
  // Compared by its ending: the relay sees the project through Git (/private/var/... on macOS), the test
  // through os.tmpdir() (/var/...).
  const isState = (to) => String(to).endsWith(`/.agents_work/${TOPIC}/relay/state.json`);
  let saves = 0;
  let dead = false;
  const alive = () => { if (dead) throw new Killed(`killed ${mode} save ${k}`); };
  for (const n of MUTATING) fs[n] = (...args) => { alive(); return real[n](...args); };
  fs.openSync = (file, flags = 'r', ...rest) => { if (flags !== 'r') alive(); return real.openSync(file, flags, ...rest); };
  fs.renameSync = (from, to) => {
    alive();
    if (!isState(to)) return real.renameSync(from, to);
    saves++;
    if (saves === k && mode === 'before') { dead = true; alive(); }
    real.renameSync(from, to);
    if (saves === k && mode === 'after') { dead = true; alive(); }
    return undefined;
  };
  const base = h.io();
  h.ioExtra = {
    herdr: (a) => { alive(); return h.handle(a); },
    git: (a, cwd) => { alive(); return base.git(a, cwd); },
    sleep: (ms) => { alive(); return base.sleep(ms); },
    notify: (...x) => { alive(); return base.notify(...x); },
    write: (t) => { alive(); return base.write(t); },
  };
  return {
    saves: () => saves,
    dead: () => dead,
    // The process is gone: later runs are new processes with the real file system and no kill armed.
    restore() { Object.assign(fs, real); h.ioExtra = {}; dead = false; k = 0; },
  };
}

// Every decision reply or note a worker received, whole (all its lines), in a prompt or in the assignment an
// initial prompt points to: "Owner decision D1 (recorded in <path>): <reply>" or "… D1 (<path>): <note>".
const delivered = (h) => h.prompts.flatMap((c) => [c.text, /relay assignment at /.test(c.text) ? c.assignment() : '']
  .flatMap((t) => [...t.matchAll(/((?:Owner|Council) decision D\d+) \((?:recorded in )?[^)]*\):\s*([\s\S]*?)(?=\n\n|$)/g)])
  .map((m) => `${c.slice}:${c.role} ${m[1]}: ${m[2].trim()}`));

// Runs a scenario until it completes: a run that stops on purpose (exit 2) is followed by `afterStop`
// arguments once (e.g. --fresh), a killed run by a plain restart. Returns what the oracle compares.
function drive(s, k, mode) {
  const p = makeProject({ plan: s.plan ?? null, config: s.config ?? {} });
  const ctx = { p };
  const h = new FakeHerdr(p, (c) => s.worker(c, ctx));
  ctx.h = h;
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const handle = h.handle.bind(h);
  h.handle = (a) => { if (a[0] === 'agent' && a[1] === 'prompt') offset += 3000; return handle(a); };
  const kill = arm(p, h, k, mode);
  const codes = [];
  let args = [TOPIC];
  try {
    for (let i = 0; i < 8; i++) {
      let code;
      try { code = h.run(args); } catch (e) { if (!(e instanceof Killed)) throw e; code = 'killed'; }
      if (kill.dead()) code = 'killed';
      if (code === 'killed') kill.restore();
      codes.push(code);
      if (code === 0) break;
      args = code === 2 && s.afterStop && !codes.slice(0, -1).includes(2) ? s.afterStop : [TOPIC];
    }
  } finally {
    kill.restore();
    Date.now = realNow;
  }
  const stops = p.events().filter((e) => e.type === 'run_stop' && e.kind === 'stop').map((e) => e.reason.slice(0, 60));
  const decisions = fs.existsSync(p.file('decisions.md')) ? p.read('decisions.md').replace(/^(## D\d+) · [\d-]+ ·/gm, '$1 ·') : '';
  const sessions = {}; // distinct sessions per slice:role that received prompts
  for (const c of h.prompts) (sessions[`${c.slice}:${c.role}`] ??= new Set()).add(c.session);
  return {
    p, h, codes, saves: kill.saves(), stops, decisions,
    slices: Object.keys(p.state().slices).sort(),
    // slice:role:purpose of every step, from its result file's name (repairs and re-reviews stay distinct)
    steps: new Set(h.prompts.map((c) => `${c.slice}:${c.role}:${(c.resultPath ?? '').replace(/^.*\/\d+-[a-z0-9]+-|\.result\.json$/g, '')}`)),
    delivered: new Set(delivered(h)),
    sessions: Object.fromEntries(Object.entries(sessions).map(([k, v]) => [k, v.size])),
    advise: h.prompts.filter((c) => c.role === 'advisor' && c.text.startsWith('/advise')).length,
    open: [...h.agents.entries()].filter(([, a]) => a.alive).map(([n]) => n),
  };
}

// The sweep: the uninterrupted run, then a kill before and after every one of its saves.
export function sweep(s) {
  const ref = drive(s, 0, 'none');
  assert.equal(ref.codes.at(-1), 0, `${s.name}: the uninterrupted scenario completes (exits ${ref.codes.join(', ')})`);
  assert.ok(ref.saves > 10, `${s.name}: the sweep counts the relay's saves (${ref.saves})`);
  assert.deepEqual(ref.open, [], `${s.name}: the uninterrupted scenario leaves no tab open`);
  s.check?.(ref, 'uninterrupted');
  for (let k = 1; k <= ref.saves; k++) {
    for (const mode of ['before', 'after']) {
      const at = `${s.name}: killed ${mode} save ${k} of ${ref.saves}`;
      const got = drive(s, k, mode);
      assert.equal(got.codes.at(-1), 0, `${at}: completes after restarting (exits ${got.codes.join(', ')})`);
      assert.ok(got.codes.slice(0, -1).every((c) => c === 2 || c === 'killed'), `${at}: no unexpected error (${got.codes.join(', ')})`);
      // A stop can be missing (the kill lost its record after the state was saved), never repeated or new.
      assert.ok(got.stops.length <= ref.stops.length && got.stops.every((x) => ref.stops.includes(x)),
        `${at}: only the scenario's own stops (${got.stops.join(' | ')})`);
      assert.deepEqual(got.slices, ref.slices, `${at}: every slice done`);
      assert.equal(got.decisions, ref.decisions, `${at}: each decision recorded once, with its full text`);
      for (const step of ref.steps) assert.ok(got.steps.has(step), `${at}: ${step} ran`);
      for (const d of ref.delivered) assert.ok(got.delivered.has(d), `${at}: delivered verbatim: ${d}`);
      for (const [who, n] of Object.entries(ref.sessions)) {
        assert.ok((got.sessions[who] ?? 0) <= n, `${at}: ${who} kept its session(s) (${got.sessions[who]} > ${n})`);
      }
      assert.ok(got.advise <= ref.advise, `${at}: no brief asked twice (${got.advise} > ${ref.advise})`);
      assert.deepEqual(got.open, [], `${at}: no tab left open`);
      s.check?.(got, at);
    }
  }
  return ref;
}
