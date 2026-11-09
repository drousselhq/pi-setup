// Acceptance tests written before implementation (`Needs: acceptance`): the acceptance worker's
// result is checked, its files are kept as originals, and later workers are told what changed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FakeHerdr, brief, decision, done, makeProject, standard } from './harness.mjs';

const roles = (h) => h.prompts.map((c) => `${c.slice}:${c.role}`);
const PLAN = (needs = 'acceptance') => `# Plan\n\n## S1: First\nNeeds: none\nAcceptance:\n- one\n\n## S2: Second\nNeeds: ${needs}\nAcceptance:\n- two\n`;
const write = (p, rel, text = `${rel}\n`) => {
  fs.mkdirSync(path.dirname(path.join(p.project, rel)), { recursive: true });
  fs.writeFileSync(path.join(p.project, rel), text);
};
const TESTS = ['tests/accept_a.txt', 'tests/accept_b.txt'];
const writeTests = (c) => { for (const t of TESTS) write(c.p, t); return c.write(done('tests written', { tests: TESTS })); };
// Implementers commit their slice file plus any acceptance tests, as their assignment asks.
const commitWork = (c) => {
  if (c.slice === 'FINAL') return c.write(done());
  const extra = c.slice === 'S2' ? TESTS.filter((t) => fs.existsSync(path.join(c.p.project, t))) : [];
  write(c.p, `${c.slice}.txt`);
  c.p.git('add', `${c.slice}.txt`, ...extra);
  c.p.git('commit', '-q', '-m', `work ${c.slice}`);
  return c.write(done());
};

test('acceptance runs after the architect, keeps the originals, and both later workers are told about the tests', () => {
  const p = makeProject({ plan: PLAN('acceptance, architecture') });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'acceptance') {
      const a = c.assignment();
      assert.match(c.text, /^\/acceptance /);
      assert.match(a, /Write only new files: the tests .* No Git writes\./);
      assert.match(a, /"tests": \["path\/of\/a\/new\/file"\]/);
      return writeTests(c);
    }
    if (c.role === 'implementer') return commitWork(c);
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.deepEqual(roles(h).slice(2, 6), ['S2:architect', 'S2:acceptance', 'S2:implementer', 'S2:reviewer']);
  const snap = p.file('slices/S2/acceptance-original');
  assert.deepEqual(fs.readdirSync(path.join(snap, 'tests')).sort(), ['accept_a.txt', 'accept_b.txt']);
  const impl = h.prompts.find((c) => c.slice === 'S2' && c.role === 'implementer');
  assert.match(impl.assignment(), /Acceptance tests for this slice were written .*tests\/accept_a\.txt, tests\/accept_b\.txt .*never an expected result/s);
  assert.match(impl.assignment(), /slices\/S2\/acceptance\.md/, 'the implementer is pointed to the acceptance record');
  const review = h.prompts.find((c) => c.slice === 'S2' && c.role === 'reviewer');
  assert.match(review.assignment(), /Relay comparison: unchanged since they were written\./);
  const started = p.events().find((e) => e.type === 'agent_start' && e.role === 'acceptance');
  assert.equal(started.model, 'test/reviewer', 'the acceptance worker defaults to the reviewer model');
  assert.deepEqual(p.events().find((e) => e.type === 'acceptance_recorded').tests, TESTS);
  assert.deepEqual(p.events().filter((e) => e.type === 'acceptance_compared').map((e) => [e.changed, e.missing]), [[[], []]]);
  assert.ok(!fs.existsSync(`${snap}.tmp`));
});

test('without commits, changed and missing acceptance files are reported in every review message', () => {
  const p = makeProject({ plan: PLAN(), config: { commit: false } });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'acceptance') return writeTests(c);
    if (c.role === 'implementer' && c.slice === 'S2' && c.n === 1) { write(p, TESTS[0], 'weakened\n'); write(p, 'S2.txt'); return c.write(done()); }
    if (c.role === 'implementer' && c.slice === 'S2') { fs.rmSync(path.join(p.project, TESTS[1])); return c.write(done()); }
    if (c.role === 'implementer') { if (c.slice !== 'FINAL') write(p, `${c.slice}.txt`); return c.write(done()); }
    if (c.role === 'reviewer' && c.slice === 'S2' && c.n === 1) return c.write(done('no', { verdict: 'changes-required', blocking: ['R1'] }));
    return standard(c);
  });
  assert.equal(h.run(), 0);
  const reviews = h.prompts.filter((c) => c.slice === 'S2' && c.role === 'reviewer');
  assert.match(reviews[0].assignment(), /changed since they were written: tests\/accept_a\.txt\./);
  assert.match(reviews[1].text, /changed since they were written: tests\/accept_a\.txt; missing: tests\/accept_b\.txt\./);
  assert.equal(fs.readFileSync(p.file(`slices/S2/acceptance-original/${TESTS[0]}`), 'utf8'), `${TESTS[0]}\n`);
});

const INVALID = [
  ['no tests', () => ({ tests: [] }), /"tests" must list every file you created/],
  ['a duplicate', (p) => { write(p, TESTS[0]); return { tests: [TESTS[0], `./${TESTS[0]}`] }; }, /lists a file twice/],
  ['a missing file', () => ({ tests: ['tests/none.txt'] }), /tests\/none\.txt does not exist/],
  ['a path outside the project', () => ({ tests: ['../outside.txt'] }), /outside the project or unusable: "\.\.\/outside\.txt"/],
  ['an ignored file', (p) => { fs.appendFileSync(path.join(p.project, '.git/info/exclude'), '*.log\n'); write(p, 'tests/a.log'); return { tests: ['tests/a.log'] }; }, /tests\/a\.log is ignored by Git/],
  ['an existing file', (p) => { write(p, 'README.md', 'changed\n'); return { tests: ['README.md'] }; }, /README\.md existed before your step: write new files only/],
  ['an unlisted change', (p) => { write(p, TESTS[0]); write(p, 'README.md', 'helper\n'); return { tests: [TESTS[0]] }; }, /you changed files you did not list .*: README\.md/],
  ['a commit', (p) => { write(p, TESTS[0]); p.commit('other.txt'); return { tests: [TESTS[0]] }; }, /HEAD moved during your step: do not commit/],
];

for (const [name, make, why] of INVALID) {
  test(`an acceptance result with ${name} is reminded once with the reason, and a corrected result continues`, () => {
    const p = makeProject({ plan: PLAN() });
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'acceptance' && c.n === 1) return c.write(done('tests', make(p)));
      if (c.role === 'acceptance') {
        // Correct it: undo stray edits, then list exactly the new files.
        p.git('checkout', '--', 'README.md');
        fs.rmSync(path.join(p.project, 'tests'), { recursive: true, force: true });
        if (p.git('rev-parse', 'HEAD') !== p.state().cur.acceptanceStart.head) p.git('reset', '-q', '--hard', 'HEAD~1');
        return writeTests(c);
      }
      if (c.role === 'implementer') return commitWork(c);
      return standard(c);
    });
    assert.equal(h.run(), 0);
    const calls = h.prompts.filter((c) => c.role === 'acceptance');
    assert.equal(calls.length, 2);
    assert.match(calls[1].text, why);
    assert.deepEqual(p.state().slices.S2.status, 'done');
  });
}

test('a crash after the snapshot keeps the first snapshot on replay; a stale temporary copy is replaced', () => {
  const p = makeProject({ plan: PLAN() });
  let crash = true;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'acceptance') {
      fs.mkdirSync(p.file('slices/S2/acceptance-original.tmp/junk'), { recursive: true }); // left by an interrupted copy
      return writeTests(c);
    }
    if (c.role === 'implementer') return commitWork(c);
    return standard(c);
  });
  const snap = p.file('slices/S2/acceptance-original');
  const io = h.io.bind(h);
  h.io = () => {
    const real = io();
    return { ...real, git: (args, cwd) => {
      // The first working-tree listing after the snapshot is the re-baseline: fail it once, as a crash would.
      if (crash && fs.existsSync(snap) && args[0] === 'ls-files' && args[1] === '-o') { crash = false; throw new Error('crash'); }
      return real.git(args, cwd);
    } };
  };
  assert.equal(h.run(), 1);
  assert.equal(p.state().cur.pending.role, 'acceptance', 'the result stays pending');
  write(p, TESTS[0], 'edited after the crash\n');
  assert.equal(h.run(), 0);
  assert.equal(fs.readFileSync(path.join(snap, TESTS[0]), 'utf8'), `${TESTS[0]}\n`, 'the original copy is not taken again');
  assert.deepEqual(fs.readdirSync(snap), ['tests']);
  assert.ok(!fs.existsSync(`${snap}.tmp`));
  const review = h.prompts.find((c) => c.slice === 'S2' && c.role === 'reviewer');
  assert.match(review.assignment(), /changed since they were written: tests\/accept_a\.txt\./);
});

const SLICE = { title: 'Make the fixture', acceptance: ['fixture.txt exists'] };
const askForPrerequisite = (c) => c.write({
  status: 'needs-decision', summary: 'need a fixture', question: 'Fixture first?',
  options: [{ label: 'Fixture first', consequence: 'f', slice: SLICE }, { label: 'Stop', consequence: 's' }], recommended: 1, reason: 'r',
});

test('a slice with acceptance tests can be set aside: the prerequisite is told they are not its work, and the resumed worker hears of changes', () => {
  const p = makeProject({ plan: PLAN() });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'acceptance') return writeTests(c);
    if (c.role === 'implementer' && c.slice === 'S2' && c.n === 1) return askForPrerequisite(c);
    if (c.role === 'advisor') {
      assert.match(c.assignment(), /a prerequisite slice can be inserted before it/);
      c.write(brief());
      return c.answer(decision({ slice: SLICE, replies: { implementer: 'Fixture first.' } }));
    }
    if (c.role === 'implementer' && c.slice === 'S1B') {
      assert.match(c.assignment(), /Acceptance tests of set-aside slice S2: tests\/accept_a\.txt, tests\/accept_b\.txt\. Never stage, edit, delete or make them pass\./);
      write(p, TESTS[1], 'touched by the prerequisite\n');
    }
    if (c.role === 'implementer') return commitWork(c);
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.deepEqual(roles(h).filter((r) => !r.startsWith('S1:')).slice(0, 7),
    ['S2:acceptance', 'S2:implementer', 'S2:advisor', 'S1B:implementer', 'S1B:reviewer', 'S2:implementer', 'S2:reviewer']);
  const resumed = h.prompts.filter((c) => c.slice === 'S2' && c.role === 'implementer')[1];
  assert.match(resumed.text, /While this slice was set aside, its acceptance tests were changed since they were written: tests\/accept_b\.txt\./);
});

test('any other change still prevents setting a slice with acceptance tests aside', () => {
  const p = makeProject({ plan: PLAN() });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'acceptance') return writeTests(c);
    if (c.role === 'implementer' && c.slice === 'S2' && c.n === 1) { write(p, 'started.txt'); return askForPrerequisite(c); }
    if (c.role === 'advisor') {
      assert.match(c.assignment(), /A prerequisite slice cannot be added now: S2 already has commits or changes since it started, so it cannot be set aside\. Do not offer that option\./);
      c.write(brief());
      return c.answer(decision({ slice: SLICE }));
    }
    if (c.role === 'implementer') return commitWork(c);
    return standard(c);
  });
  assert.equal(h.run(), 2);
  assert.match(p.log(), /S2 already has commits or changes/);
});
