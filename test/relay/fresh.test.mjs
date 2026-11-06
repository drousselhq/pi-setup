// --fresh <role>: the owner replaces the waiting worker with a new session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { FakeHerdr, StopRelay, TOPIC, changes, done, makeProject, standard } from './harness.mjs';

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';
const blocked = (c) => {
  c.write({ status: 'blocked', summary: 'stuck', question: 'Only a fresh session can continue.' });
  return c.later(() => { throw new StopRelay('Ctrl-C'); }); // the owner stops the relay while it waits
};

test('a blocked reviewer is replaced by a fresh session that reviews in full, with the owner\'s note, without the old record', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n === 1) { fs.writeFileSync(p.file('slices/S1/review.md'), 'contaminated notes\n'); return blocked(c); }
    return standard(c);
  });
  assert.equal(h.run(), 1);
  assert.equal(p.state().cur.pending.role, 'reviewer');
  assert.equal(h.run([TOPIC, '--fresh', 'reviewer', '--note', 'You may write the b files.']), 0);
  const reviewers = h.starts.filter((s) => s.role === 'reviewer');
  assert.equal(reviewers.length, 2);
  assert.equal(reviewers[1].resumed, false, 'a new session, not the old one resumed');
  assert.notEqual(reviewers[1].session, reviewers[0].session);
  const fresh = h.prompts.filter((c) => c.role === 'reviewer')[1];
  assert.match(fresh.text, /^\/review Read and execute the relay assignment/, 'the fresh session gets the template and a new assignment');
  assert.match(fresh.assignment(), /The owner replaced the previous reviewer session for this step: do a full, independent review/);
  assert.match(fresh.assignment(), /The owner's note: You may write the b files\./);
  assert.match(fresh.assignment(), /Review the implementation of this slice/);
  assert.ok(!fs.existsSync(p.file('slices/S1/review.md')) || !/contaminated/.test(p.read('slices/S1/review.md')));
  const aside = fs.readdirSync(p.relayDir).find((f) => f.endsWith('-reviewer-replaced-review.md'));
  assert.ok(aside, 'the old record is kept in relay/');
  assert.equal(fs.readFileSync(`${p.relayDir}/${aside}`, 'utf8'), 'contaminated notes\n');
  assert.ok(p.events().some((e) => e.type === 'fresh_session' && e.role === 'reviewer' && e.note === 'You may write the b files.'));
});

test('a fresh reviewer replacing one in a re-review does a full review', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n === 1) return c.write(changes('R1'));
    if (c.role === 'reviewer' && c.n === 2) return blocked(c);
    return standard(c);
  });
  assert.equal(h.run(), 1);
  assert.match(p.state().cur.pending.purpose, /^rereview/);
  assert.equal(h.run([TOPIC, '--fresh', 'reviewer']), 0);
  const fresh = h.prompts.filter((c) => c.role === 'reviewer')[2];
  assert.match(fresh.assignment(), /Review the implementation of this slice/);
  assert.doesNotMatch(fresh.assignment(), /Re-review those repairs/);
});

test('a fresh implementer keeps the record and restarts its step', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) { fs.writeFileSync(p.file('slices/S1/implementation.md'), 'progress\n'); return blocked(c); }
    return standard(c);
  });
  assert.equal(h.run(), 1);
  assert.equal(h.run([TOPIC, '--fresh', 'implementer']), 0);
  const fresh = h.prompts.filter((c) => c.role === 'implementer' && c.slice === 'S1')[1];
  assert.match(fresh.assignment(), /The owner replaced the previous implementer session for this step; its record is \S+implementation\.md/);
  assert.match(fresh.assignment(), /Implement slice S1/);
  assert.equal(p.read('slices/S1/implementation.md'), 'progress\n');
});

test('--fresh refuses a role that is not waiting, a non-worker role, and malformed options', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => (c.role === 'reviewer' && c.n === 1 ? blocked(c) : standard(c)));
  assert.equal(h.run(), 1);
  const cases = [
    [[TOPIC, '--fresh', 'implementer'], /--fresh implementer: the implementer has no step in progress \(the waiting step is the reviewer's\)/],
    [[TOPIC, '--fresh', 'advisor'], /--fresh takes a worker role/],
    [[TOPIC, '--note', 'x'], /--note is only used with --fresh/],
    [[TOPIC, '--fresh'], /--fresh needs a value/],
    [[TOPIC, '--frsh', 'reviewer'], /Unknown option --frsh/],
  ];
  for (const [args, message] of cases) {
    h.output = '';
    assert.equal(h.run(args), 2, args.join(' '));
    assert.match(h.output.replace(/[┃\s]+/g, ' '), message);
  }
  assert.equal(p.state().cur.pending.role, 'reviewer', 'nothing changed');
  assert.ok(h.output.length > 0);
});

test('the blocked notice tells the owner about --fresh', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => (c.role === 'reviewer' && c.n === 1 ? blocked(c) : c.role === 'implementer' ? standard(c) : c.write(done())));
  assert.equal(h.run(), 1);
  assert.match(h.output.replace(/[┃\s]+/g, ' '), new RegExp(`pi-relay ${TOPIC} --fresh reviewer`));
});

// ---------- after a compaction-limit stop ----------

const runaway = (c, partial) => {
  if (partial) fs.writeFileSync(c.p.file(partial), 'partial notes\n');
  fs.appendFileSync(c.session, '{"type":"compaction"}\n{"type":"compaction"}\n'); // over the limit, no result
};
const flat = (h) => h.output.replace(/[┃\s]+/g, ' ');

test('after a reviewer\'s compaction-limit stop, --fresh replaces the queued retry: note, full review, record set aside', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => (c.role === 'reviewer' && c.n === 1 ? runaway(c, 'slices/S1/review.md') : standard(c)));
  assert.equal(h.run(), 2);
  const stop = flat(h);
  assert.match(stop, new RegExp(`use pi-relay ${TOPIC} --fresh reviewer --note "..." \\(the partial review record is then set aside`));
  assert.match(stop, /S1 already has commits or changes, so no slice can be inserted before it/);
  assert.doesNotMatch(stop, /split it in plan\.md/);
  assert.equal(p.state().cur.pending, null);
  assert.equal(p.state().cur.queued.retryOf, 'runaway');
  h.output = '';
  assert.equal(h.run([TOPIC, '--fresh', 'implementer']), 2, 'the queued retry is the reviewer\'s');
  assert.match(flat(h), /the implementer has no step in progress \(the waiting step is the reviewer's\)/);
  assert.equal(h.run([TOPIC, '--fresh', 'reviewer', '--note', 'Do not transcribe.']), 0);
  const reviewers = h.starts.filter((s) => s.role === 'reviewer');
  assert.equal(reviewers.length, 2);
  assert.equal(reviewers[1].resumed, false);
  const fresh = h.prompts.filter((c) => c.role === 'reviewer')[1];
  assert.match(fresh.assignment(), /The owner replaced the previous reviewer session for this step: do a full, independent review/);
  assert.match(fresh.assignment(), /The owner's note: Do not transcribe\./);
  const aside = fs.readdirSync(p.relayDir).find((f) => f.endsWith('-reviewer-replaced-review.md'));
  assert.equal(fs.readFileSync(`${p.relayDir}/${aside}`, 'utf8'), 'partial notes\n');
  assert.ok(p.events().some((e) => e.type === 'fresh_session' && e.note === 'Do not transcribe.'));
});

test('after a reviewer\'s compaction-limit stop, a plain re-run retries in a new session that keeps the partial record', () => {
  const p = makeProject({ plan: ONE });
  let seen = null;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n === 1) return runaway(c, 'slices/S1/review.md');
    if (c.role === 'reviewer' && c.n === 2) seen = p.read('slices/S1/review.md');
    return standard(c);
  });
  assert.equal(h.run(), 2);
  assert.equal(h.run(), 0);
  assert.equal(seen, 'partial notes\n');
  const reviewers = h.starts.filter((s) => s.role === 'reviewer');
  assert.equal(reviewers.length, 2);
  assert.notEqual(reviewers[1].session, reviewers[0].session);
  assert.doesNotMatch(h.prompts.filter((c) => c.role === 'reviewer')[1].assignment(), /The owner replaced/);
});

test('a compaction-limit stop before any change suggests splitting the slice', () => {
  const p = makeProject({ plan: ONE, config: { escalation: { enabled: false } } });
  const h = new FakeHerdr(p, (c) => (c.role === 'implementer' && c.n === 1 ? runaway(c) : standard(c)));
  assert.equal(h.run(), 2);
  const stop = flat(h);
  assert.match(stop, /split it in plan\.md first \(S1 has no commits or changes yet\)/);
  assert.match(stop, new RegExp(`--fresh implementer --note "\\.\\.\\."\\. `));
  assert.doesNotMatch(stop, /partial review record/);
});

test('a planner\'s compaction-limit stop gives no slice advice, since there is no slice yet', () => {
  const p = makeProject({ plan: null });
  const h = new FakeHerdr(p, (c) => (c.role === 'planner' ? runaway(c) : standard(c)));
  assert.equal(h.run(), 2);
  const stop = flat(h);
  assert.match(stop, new RegExp(`--fresh planner --note "\\.\\.\\."\\. `));
  assert.doesNotMatch(stop, /split it|already has commits/);
});
