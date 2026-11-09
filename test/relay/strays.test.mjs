// Uncommitted work (commit: true): a worker that leaves changes made during its slice uncommitted is asked once
// to commit what belongs to the slice; changes still left stop the relay, and no slice is recorded done with them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FakeHerdr, StopRelay, brief, decision, done, finished, makeProject, standard } from './harness.mjs';

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';
const flat = (h) => h.output.replace(/[┃\s]+/g, ' ');
const write = (p, rel, text = `${rel}\n`) => {
  fs.mkdirSync(path.dirname(path.join(p.project, rel)), { recursive: true });
  fs.writeFileSync(path.join(p.project, rel), text);
};

test('a change left uncommitted is committed after one request, then the slice is reviewed', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) { p.commit('s1.txt'); write(p, 'loose.txt'); return c.write(done()); }
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 2) {
      assert.match(c.text, /^These changes are not committed: loose\.txt\. Commit those that belong to this slice \(explicit paths\)\. Leave anything else untouched and list it in your summary\./);
      p.git('add', 'loose.txt');
      p.git('commit', '-q', '-m', 'loose');
      return c.write(done());
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.deepEqual(h.prompts.map((c) => `${c.slice}:${c.role}`).slice(0, 3), ['S1:implementer', 'S1:implementer', 'S1:reviewer']);
});

test('a change still uncommitted after the request stops the relay with the list; once dealt with, a re-run continues', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) { p.commit('s1.txt'); write(p, 'notes/draft.md'); return c.write(done()); }
    if (c.role === 'implementer' && c.slice === 'S1') return c.write(done('left notes/draft.md: not this slice\'s'));
    return standard(c);
  });
  assert.equal(h.run(), 2);
  assert.match(flat(h), /S1: changes made during this slice are still not committed: notes\/draft\.md\. Commit those that belong to the slice; commit or stash the others \(your own edits during the slice show up here too\)\./);
  assert.equal(p.state().slices.S1, undefined);
  fs.rmSync(`${p.project}/notes`, { recursive: true }); // the owner removes his draft
  const before = h.prompts.length;
  assert.equal(h.run(), 0);
  assert.equal(h.prompts[before].role, 'reviewer', 'the re-run continues from the worker\'s result: no second request');
});

test('no request without a commit setting, for changes made before the slice, or for a final step that changes nothing', () => {
  // commit: false: the work stays uncommitted by design.
  let p = makeProject({ plan: ONE, config: { commit: false } });
  let h = new FakeHerdr(p, (c) => (c.role === 'implementer' && c.slice === 'S1' ? (write(p, 'work.txt'), c.write(done())) : standard(c)));
  assert.equal(h.run(), 0);
  assert.ok(!h.prompts.some((c) => /are not committed/.test(c.text)));
  // The owner's change from before the run is not the slice's.
  p = makeProject({ plan: ONE });
  write(p, 'mine.txt', 'the owner\'s\n');
  h = new FakeHerdr(p, standard);
  assert.equal(h.run(), 0);
  assert.ok(!h.prompts.some((c) => /are not committed/.test(c.text)));
  assert.ok(fs.existsSync(`${p.project}/mine.txt`));
});

test('the slice\'s own acceptance tests count when left uncommitted', () => {
  const p = makeProject({ plan: '# Plan\n\n## S1: Only\nNeeds: acceptance\nAcceptance:\n- x\n' });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'acceptance') { write(p, 'tests/accept.txt'); return c.write(done('tests written', { tests: ['tests/accept.txt'] })); }
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) { p.commit('s1.txt'); return c.write(done()); } // forgets the tests
    if (c.role === 'implementer' && c.slice === 'S1') {
      assert.match(c.text, /These changes are not committed: tests\/accept\.txt\./);
      p.git('add', 'tests/accept.txt');
      p.git('commit', '-q', '-m', 'tests');
      return c.write(done());
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.ok(h.prompts.some((c) => /These changes are not committed: tests\/accept\.txt\./.test(c.text)), 'the worker was asked to commit its tests');
});

test('a set-aside slice\'s acceptance tests are not the prerequisite slice\'s leftovers', () => {
  const p = makeProject({ plan: '# Plan\n\n## S1: First\nNeeds: none\nAcceptance:\n- one\n\n## S2: Second\nNeeds: acceptance\nAcceptance:\n- two\n' });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'acceptance') { write(p, 'tests/s2.txt'); return c.write(done('tests written', { tests: ['tests/s2.txt'] })); }
    if (c.role === 'implementer' && c.slice === 'S2' && c.n === 1) {
      return c.write({ status: 'needs-decision', summary: 's', question: 'Prepare first?', options: [{ label: 'Prepare', consequence: 'p' }, { label: 'Go on', consequence: 'g' }], recommended: 1, reason: 'r' });
    }
    if (c.role === 'implementer' && c.slice === 'S2') { p.git('add', 'tests/s2.txt'); p.commit('s2.txt'); return c.write(done()); }
    if (c.role === 'advisor') { c.write(brief()); return c.answer(decision({ slice: { title: 'Prepare', acceptance: ['prepared'] } })); }
    if (c.role === 'implementer') { if (c.slice !== 'FINAL') p.commit(`${c.slice}.txt`); return c.write(finished(c)); }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.ok(!h.prompts.some((c) => c.slice === 'S1B' && /are not committed/.test(c.text)), 'the prerequisite slice was not asked about S2\'s tests');
  assert.deepEqual(Object.keys(p.state().slices).sort(), ['FINAL', 'S1', 'S1B', 'S2']);
});

// ---------- in the final verification ----------

const final = (extra = {}) => done('verified', { verification: 'pass', ...extra });

test('in the final verification, a commit step that also changes a file gets one more verification; one that only commits does not', () => {
  for (const changes of [true, false]) {
    const p = makeProject({ plan: ONE });
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'implementer' && c.slice === 'FINAL' && c.n === 1) { write(p, 'loose.txt'); return c.write(final()); }
      if (c.role === 'implementer' && c.slice === 'FINAL' && /are not committed: loose\.txt/.test(c.text)) {
        p.git('add', 'loose.txt');
        p.git('commit', '-q', '-m', 'loose');
        if (changes) p.commit('README.md', 'touched while committing\n'); // e.g. a hook that reformats
        return c.write(final()); // repeats its last outcome, as asked
      }
      return standard(c);
    });
    assert.equal(h.run(), 0);
    const again = h.prompts.filter((c) => c.slice === 'FINAL' && /full verification again/.test(c.text));
    if (changes) assert.match(again[0]?.text ?? '', /the candidate changed after the last full verification \(README\.md\)/);
    else assert.equal(again.length, 0, 'committing alone does not change the verified files');
  }
});

test('in the final verification, a commit step\'s result read after a restart is not evidence', () => {
  const p = makeProject({ plan: ONE });
  let stop = true;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'FINAL' && c.n === 1) { write(p, 'loose.txt'); return c.write(final()); }
    if (c.role === 'implementer' && c.slice === 'FINAL' && stop) { // commits, answers, and the relay is stopped before reading it
      p.git('add', 'loose.txt');
      p.git('commit', '-q', '-m', 'loose');
      c.write(final());
      throw new StopRelay('Ctrl-C');
    }
    return standard(c);
  });
  assert.equal(h.run(), 1);
  stop = false;
  assert.equal(h.run(), 0);
  assert.ok(h.prompts.some((c) => c.slice === 'FINAL' && /did not see the last full verification finish in this run/.test(c.text)));
});

// ---------- Git failures and edits during the review ----------

// Makes the next `git ls-files -o` the relay runs fail, once `armed()` holds.
function failListing(h, armed) {
  let done = false;
  const base = h.io();
  h.ioExtra.git = (args, cwd, env) => {
    if (!done && armed() && args[0] === 'ls-files' && args.includes('-o')) { done = true; return { status: 128, stdout: '', stderr: 'fatal: simulated' }; }
    return base.git(args, cwd, env);
  };
}

test('a Git failure while recording where a slice starts stops the relay instead of disabling the check', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, standard);
  failListing(h, () => true);
  assert.equal(h.run(), 2);
  assert.match(flat(h), /Git could not list the working tree's changes to record where this slice starts/);
  assert.equal(h.prompts.length, 0);
  h.ioExtra = {};
  assert.equal(h.run(), 0);
});

test('a Git failure when a slice would finish stops it; a re-run finishes it', () => {
  const p = makeProject({ plan: ONE });
  let reviewed = false;
  const h = new FakeHerdr(p, (c) => { if (c.role === 'reviewer') reviewed = true; return standard(c); });
  failListing(h, () => reviewed);
  assert.equal(h.run(), 2);
  assert.match(flat(h), /S1: Git could not list the working tree's changes, so the relay cannot tell whether any are left uncommitted/);
  assert.equal(p.state().slices.S1, undefined);
  h.ioExtra = {};
  assert.equal(h.run(), 0);
});

test('a change made while the slice is reviewed keeps it from finishing; once dealt with, a re-run finishes it', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.slice === 'S1') fs.writeFileSync(`${p.project}/README.md`, 'the owner edits during the review\n');
    return standard(c);
  });
  assert.equal(h.run(), 2);
  assert.match(flat(h), /S1: changes made during this slice are still not committed: README\.md\./);
  assert.equal(p.state().slices.S1, undefined);
  p.git('checkout', '--', 'README.md');
  const before = h.prompts.length;
  assert.equal(h.run(), 0);
  assert.equal(h.prompts[before]?.slice, 'FINAL', 'the review\'s acceptance is used again: no second review');
});

test('a Git failure while a set-aside slice resumes keeps it set aside; a re-run resumes it with its tests and worker', () => {
  const p = makeProject({ plan: '# Plan\n\n## S1: First\nNeeds: none\nAcceptance:\n- one\n\n## S2: Second\nNeeds: acceptance\nAcceptance:\n- two\n' });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'acceptance') { write(p, 'tests/s2.txt'); return c.write(done('tests written', { tests: ['tests/s2.txt'] })); }
    if (c.role === 'implementer' && c.slice === 'S2' && c.n === 1) {
      return c.write({ status: 'needs-decision', summary: 's', question: 'Prepare first?', options: [{ label: 'Prepare', consequence: 'p' }, { label: 'Go on', consequence: 'g' }], recommended: 1, reason: 'r' });
    }
    if (c.role === 'implementer' && c.slice === 'S2') { p.git('add', 'tests/s2.txt'); p.commit('s2.txt'); return c.write(done()); }
    if (c.role === 'advisor') { c.write(brief()); return c.answer(decision({ slice: { title: 'Prepare', acceptance: ['prepared'] } })); }
    if (c.role === 'implementer') { if (c.slice !== 'FINAL') p.commit(`${c.slice}.txt`); return c.write(finished(c)); }
    return standard(c);
  });
  const s1bDone = () => fs.existsSync(p.file('relay/state.json')) && Boolean(p.state().slices.S1B);
  failListing(h, s1bDone); // the first listing after S1B is done: S2's resume
  assert.equal(h.run(), 2);
  assert.match(flat(h), /to record where this slice starts/);
  assert.ok(p.state().setAsideSlices?.S2, 'S2 is still set aside');
  h.ioExtra = {};
  assert.equal(h.run(), 0);
  assert.ok(p.events().some((e) => e.type === 'slice_resumed'), 'S2 resumed');
  assert.equal(h.prompts.filter((c) => c.role === 'acceptance').length, 1, 'its acceptance tests were not written again');
  assert.equal(h.starts.filter((s) => s.role === 'implementer' && s.name.includes('implementer') && s.resumed).length > 0, true, 'the worker resumed its session');
});
