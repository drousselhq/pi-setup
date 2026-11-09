// "Complete" means complete: the final verification states its outcome, counts only for the files it verified
// in a run the relay saw, runs again after new work, and a completed topic does not claim to cover later changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { FakeHerdr, StopRelay, TOPIC, accept, done, makeProject, standard } from './harness.mjs';

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';
const flat = (h) => h.output.replace(/[┃\s]+/g, ' ');
const roles = (h) => h.prompts.map((c) => `${c.slice}:${c.role}:${(c.resultPath ?? '').replace(/^.*\/\d+-[a-z0-9]+-|\.result\.json$/g, '')}`);
const final = (extra = {}) => done('verified', { verification: 'pass', ...extra });

test('a final verification result must state its outcome: the reminder names the field', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'FINAL' && c.n === 1) {
      assert.match(c.assignment(), /"verification": "pass \| fail", +\/\/ with status done: the project's full verification on the candidate as you leave it/);
      return c.write(done('verified'));
    }
    if (c.role === 'implementer' && c.slice === 'FINAL') {
      assert.match(c.text, /Your result file is invalid \("verification" must be "pass" or "fail"/);
      return c.write(final());
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
});

test('a failing final verification stops the relay instead of announcing completion; re-running retries it in the same session', () => {
  const p = makeProject({ plan: ONE });
  let fixed = false;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'FINAL') {
      if (!fixed) return c.write(done('3 tests fail', { verification: 'fail', checks: ['npm test → fail (3 failing)'] }));
      assert.match(c.text, /Your full verification failed \(3 tests fail\)\. The owner may have fixed the cause or decided something meanwhile/);
      return c.write(final());
    }
    return standard(c);
  });
  assert.equal(h.run(), 2);
  assert.match(flat(h), /FINAL: the final verification failed: 3 tests fail\./);
  assert.ok(!p.events().some((e) => e.type === 'run_complete'));
  assert.equal(p.state().slices.FINAL, undefined);
  fixed = true;
  h.output = '';
  assert.equal(h.run(), 0);
  assert.equal(h.starts.filter((s) => s.role === 'implementer').length, 2, 'S1 and FINAL: the retry used the same FINAL session');
  assert.match(flat(h), /All slices are done and the final verification passed\./);
  assert.equal(p.events().find((e) => e.type === 'run_complete').verification, 'pass');
});

test('a slice added after the final verification runs, and the final verification runs again after it', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, standard);
  assert.equal(h.run(), 0);
  fs.appendFileSync(p.file('plan.md'), '\n## S2: More\nNeeds: none\nAcceptance:\n- y\n');
  const before = h.prompts.length;
  assert.equal(h.run(), 0);
  assert.deepEqual(roles(h).slice(before), ['S2:implementer:implement', 'S2:reviewer:review', 'FINAL:implementer:final']);
  assert.ok(p.events().some((e) => e.type === 'final_invalidated' && e.slice === 'S2'));
});

test('a completed topic run again reports completion only while the files are as verified', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, standard);
  assert.equal(h.run(), 0);
  const prompts = h.prompts.length;
  assert.equal(h.run(), 0, 'unchanged: completion as before');
  assert.equal(p.events().filter((e) => e.type === 'run_complete').length, 2);
  p.commit('later.txt', 'the owner works on\n'); // a change after the final verification
  h.output = '';
  assert.equal(h.run(), 0);
  assert.equal(h.prompts.length, prompts, 'nothing started');
  assert.match(flat(h), /already complete, for an earlier state .*The final verification of this topic covered the state of .*; the checkout has changed since, so it does not cover the current state\. To verify the current state, add a slice to \S+plan\.md \(the final verification runs again after it\), or start a new topic\./);
  assert.equal(p.events().filter((e) => e.type === 'run_complete').length, 2, 'no completion for the current state');
  assert.equal(p.events().at(-1).type, 'run_already_complete');
});

test('committing verified content does not count as a change (commit: false)', () => {
  const p = makeProject({ plan: ONE, config: { commit: false } });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1') { fs.writeFileSync(`${p.project}/work.txt`, 'work\n'); return c.write(done()); }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  p.git('add', 'work.txt');
  p.git('commit', '-q', '-m', 'the owner commits the verified work');
  h.output = '';
  assert.equal(h.run(), 0);
  assert.match(flat(h), /complete All slices are done and the final verification passed/);
});

test('a final verification read after a restart is not evidence: it is run once more', () => {
  const p = makeProject({ plan: ONE });
  let stop = true;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'FINAL' && stop) { // it passes, but the relay is stopped before reading it
      c.write(final());
      throw new StopRelay('Ctrl-C');
    }
    return standard(c);
  });
  assert.equal(h.run(), 1);
  stop = false;
  assert.equal(h.run(), 0);
  const verify = h.prompts.find((c) => c.slice === 'FINAL' && /full verification again/.test(c.text));
  assert.match(verify.text, /the relay did not see the last full verification finish in this run/);
});

test('files changed after a passing verification get one more verification; changed again, the relay stops naming them', () => {
  const p = makeProject({ plan: ONE });
  let edits = 0;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'FINAL') { p.commit(`final-${c.n}.txt`); return c.write(final()); } // fixes something, verifies
    if (c.role === 'reviewer' && c.slice === 'FINAL') { // a reviewer that edits files (it must not)
      fs.writeFileSync(`${p.project}/edited-${++edits}.txt`, 'x\n');
      return c.write(accept());
    }
    return standard(c);
  });
  assert.equal(h.run(), 2);
  const verify = h.prompts.filter((c) => c.slice === 'FINAL' && c.role === 'implementer')[1];
  assert.match(verify.text, /the candidate changed after the last full verification \(edited-1\.txt\)/);
  assert.match(flat(h), /FINAL: the candidate changed after the last full verification \(edited-2\.txt\), again after one more verification/);
  assert.equal(p.state().slices.FINAL, undefined);
});

test('the relay\'s own records do not change the verified candidate, even where .agents_work/ is not ignored', () => {
  const p = makeProject({ plan: ONE });
  fs.writeFileSync(`${p.project}/.git/info/exclude`, '');
  // A FINAL that changes files is reviewed: the relay writes its records between the verification and the
  // review's acceptance, and the candidate must be the same at both.
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'FINAL') { if (!fs.existsSync(`${p.project}/final.txt`)) p.commit('final.txt'); return c.write(final()); }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.ok(h.prompts.some((c) => c.slice === 'FINAL' && c.role === 'reviewer'), 'the FINAL step was reviewed');
  assert.ok(!h.prompts.some((c) => /full verification again/.test(c.text)), 'no extra verification');
  h.output = '';
  assert.equal(h.run(), 0);
  assert.match(flat(h), /complete All slices are done and the final verification passed/, 'a re-run still finds the files as verified');
});

for (const fresh of [false, true]) {
  test(`a pass from before a restart does not finish the final verification${fresh ? ' (restarted with --fresh reviewer)' : ''}`, () => {
    const p = makeProject({ plan: ONE });
    let stop = true;
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'implementer' && c.slice === 'FINAL') { if (!fs.existsSync(`${p.project}/final.txt`)) p.commit('final.txt'); return c.write(final()); }
      if (c.role === 'reviewer' && c.slice === 'FINAL' && stop) { c.write(accept()); throw new StopRelay('Ctrl-C'); } // accepted, then stopped
      return standard(c);
    });
    assert.equal(h.run(), 1);
    stop = false;
    assert.equal(h.run(fresh ? [TOPIC, '--fresh', 'reviewer'] : [TOPIC]), 0);
    const again = h.prompts.find((c) => c.slice === 'FINAL' && c.role === 'implementer' && /full verification again/.test(c.text));
    assert.match(again.text, /the relay did not see the last full verification finish in this run/);
  });
}

for (const [flags, tag] of [[['--assume-unchanged'], 'h'], [['--skip-worktree'], 'S'], [['--assume-unchanged', '--skip-worktree'], 's']]) {
  test(`an edit hidden from Git by ${flags.join(' and ')} still counts as a change to the verified files`, () => {
    const p = makeProject({ plan: ONE });
    const h = new FakeHerdr(p, standard);
    assert.equal(h.run(), 0);
    for (const flag of flags) p.git('update-index', flag, 'README.md');
    fs.writeFileSync(`${p.project}/README.md`, 'edited after the verification\n');
    h.output = '';
    assert.equal(h.run(), 0);
    assert.match(flat(h), /already complete, for an earlier state/);
    assert.match(p.git('ls-files', '-v', 'README.md'), new RegExp(`^${tag} `), 'the real index keeps its flags');
  });
}

test('a final verification recorded by an earlier relay version (no candidate) does not claim the current state', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, standard);
  assert.equal(h.run(), 0);
  const st = p.state();
  delete st.slices.FINAL.tree;
  fs.writeFileSync(p.file('relay/state.json'), JSON.stringify(st));
  h.output = '';
  assert.equal(h.run([TOPIC]), 0);
  assert.match(flat(h), /already complete, for an earlier state/);
});
