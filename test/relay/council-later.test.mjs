// Later questions of a worker step that already had a council decision: they go to the council too. One that
// would change an earlier decision ("revisits") is answered by the council once per step; a second one, or any
// question after three council decisions in the step, goes to the owner. The count survives whatever rebuilds
// the step (a prerequisite slice, --fresh, the senior, a restart).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { FakeHerdr, StopRelay, accept, brief, decision, done, makeProject, standard, writeResult } from './harness.mjs';

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';
const ROLES = Object.fromEntries(['planner', 'scout', 'architect', 'implementer', 'senior', 'reviewer', 'advisor', 'council1', 'council2']
  .map((r) => [r, { model: `test/${r}`, thinking: 'low' }]));
const COUNCIL = { enabled: true, members: ['council1', 'council2'], ownerClasses: ['E', 'F', 'G', 'H', 'I'], timeoutMinutes: 30 };
const project = () => makeProject({ plan: ONE, config: { roles: ROLES, council: COUNCIL } });
// X1 = "A: fix one" (option 2), X2 = "B: fix both" (option 1), in the members' neutral order.
const OPTIONS = [
  { label: 'B: fix both', consequence: 'both fixed', action: 'Fix the weight bug completely.', classes: ['A'] },
  { label: 'A: fix one', consequence: 'one fixed', action: 'Fix only the undefined part.', classes: ['A'] },
];
const cbrief = (extra = {}, options = OPTIONS) => brief({ options, ownerNeeded: null, ...extra });
const vote = (choice = 'X2', extra = {}) => ({
  status: 'done', choice, conditions: [], classes: ['A'], ownerNeeded: null, confidence: 'high', reversibility: 'easy',
  reasons: 'the evidence', objection: 'none decisive', ownerSummary: 'I would fix both.', ...extra,
});
const ask = (c, question = 'Which fix?') => c.write({ status: 'needs-decision', summary: 'a choice', question,
  options: [{ label: 'Keep', consequence: 'a' }, { label: 'Replace', consequence: 'b' }], recommended: 1, reason: 'r' });
const conflicting = (c) => c.write(vote('X2', { conditions: [`${c.role}: ${c.role === 'council1' ? 'keep' : 'replace'} the fixture`] }));
const decided = (p) => (fs.existsSync(p.file('decisions.md')) ? p.read('decisions.md').match(/^## D\d+/gm)?.length ?? 0 : 0);
const by = (p, id) => p.read('decisions.md').split(/^(?=## )/m).find((x) => x.startsWith(`## ${id} `)) ?? '';
// A member's assignment, from the path in its /council prompt.
const assignment = (c) => fs.readFileSync(c.text.match(/council assignment at (\S+)/)[1], 'utf8');
const votes = (p) => p.events().filter((e) => e.type === 'council_start').length;
const SECOND_REVISIT = /It came to the owner because the (?:implementer|senior) asked again to change an earlier decision \(D2\), after council decision D2 already changed one in this step\./;

test('an unrelated later question of the same step goes to the council, whose members see the step\'s earlier decision', () => {
  const p = project();
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 2) return ask(c, c.n === 1 ? 'Which fix?' : 'Which file name?');
    if (c.role === 'advisor') return c.write(cbrief({ revisits: [] }));
    if (c.role.startsWith('council')) return c.write(vote());
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(votes(p), 2);
  assert.match(by(p, 'D2'), /Decided by the council/);
  const second = h.prompts.filter((c) => c.role === 'council1')[1];
  assert.match(assignment(second), /## Earlier decisions\n\nThis worker step already received council decision D1\. If this question would in fact change it: A council decision may be amended within its intent [^\n]*a second goes to the owner\.\n/);
});

test('a question that would change a council decision is answered by the council once; a second one goes to the owner', () => {
  const p = project();
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 3) return ask(c, 'The conditions conflict: which wins?');
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
    if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] }));
    if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D2'] })); return c.answer(decision({ title: 'Keep the fixture' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(votes(p), 2, 'the second revisit has no vote');
  assert.match(by(p, 'D2'), /Decided by the council/);
  assert.match(by(p, 'D3'), SECOND_REVISIT);
  const second = assignment(h.prompts.filter((c) => c.role === 'council2')[1]).replace(/\s+/g, ' ');
  assert.match(second, /The advisor says this question would change or work around D1, or that the worker cannot follow its conditions\. .*A council decision may be amended within its intent .*any change to a decision of the owner's, needs the owner \(set "ownerNeeded"\) unless the project's own rules let the council make it\. The council answers one such question per worker step; a second goes to the owner\./);
  assert.equal(p.events().find((e) => e.type === 'advisor_brief' && e.revisits.length)?.revisits[0], 'D1', 'the brief event keeps revisits');
});

test('after three council decisions in one step, its next question goes to the owner', () => {
  const p = project();
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 4) return ask(c, `Question ${c.n}?`);
    if (c.role === 'advisor' && c.n <= 3) return c.write(cbrief({ revisits: [] }));
    if (c.role === 'advisor') { c.write(cbrief({ revisits: [] })); return c.answer(decision({ title: 'Fourth' })); }
    if (c.role.startsWith('council')) return c.write(vote());
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(votes(p), 3);
  assert.match(by(p, 'D4'), /It came to the owner because the council already decided 3 questions of this implementer step \(D1, D2, D3\)\./);
});

test('"revisits" that is not a list of decision IDs goes back to the advisor', () => {
  const p = project();
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return ask(c);
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief({ revisits: 'D1' }));
    if (c.role === 'advisor') { assert.match(c.text, /"revisits" must list the IDs of the decisions this question would change/); return c.write(cbrief({ revisits: [] })); }
    if (c.role.startsWith('council')) return c.write(vote());
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(h.prompts.filter((c) => c.role === 'advisor').length, 2, 'the advisor was asked to correct its brief');
  assert.match(by(p, 'D1'), /Decided by the council/);
});

test('a council decision with a prerequisite slice records its specification and points the reviewer to it; the resumed step\'s revisit goes to the council', () => {
  const p = project();
  const slice = { title: 'Make fixture', acceptance: ['fixture exists'], notes: 'use old data' };
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return ask(c);
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief({}, [{ ...OPTIONS[0], slice }, OPTIONS[1]]));
    if (c.role === 'advisor') return c.write(cbrief({ revisits: ['D1'] }));
    if (c.role.startsWith('council')) return conflicting(c);
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 2) return ask(c, 'Which condition wins?'); // resumed after the prerequisite
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.match(p.read('decisions.md'), /## D1 · .* · S1 · B: fix both\n\nThe advisory council decided: B: fix both\.\nAction: Fix the weight bug completely\.\nConditions the members added \(they limit the action\):\n- council1: keep the fixture\n- council2: replace the fixture\nA prerequisite slice runs first: "Make fixture"; acceptance: fixture exists\. Notes: use old data\n/);
  assert.equal(votes(p), 2);
  assert.match(by(p, 'D2'), /Decided by the council/);
  const reviewer = h.prompts.find((x) => x.role === 'reviewer' && x.slice === 'S1');
  assert.match(reviewer.assignment() + reviewer.text, /Council decision D1 .*It applies to this slice: check that its action and conditions were followed\./s);
});

test('after an owner decision that inserts another prerequisite slice, the step\'s count still holds', () => {
  const p = project();
  const SLICE = (title) => ({ title, acceptance: [`${title} exists`] });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief({}, [{ ...OPTIONS[0], slice: SLICE('Fixture one') }, OPTIONS[1]]));
    if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] }));
    if (c.role === 'advisor' && c.n === 3) { c.write(cbrief({ revisits: ['D2'] })); return c.answer(decision({ title: 'Another fixture first', slice: SLICE('Fixture two') })); }
    if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D2'] })); return c.answer(decision({ title: 'Keep it' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 4) return ask(c, 'Which condition wins?'); // first, then after each decision
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(votes(p), 2);
  assert.deepEqual(p.read('decisions.md').match(/^## D\d+ [^\n]*/gm).map((l) => l.replace(/ · \d{4}-\d\d-\d\d/, '')),
    ['## D1 · S1 · B: fix both', '## D2 · S1 · B: fix both', '## D3 · S1 · Another fixture first', '## D4 · S1 · Keep it']);
  assert.match(by(p, 'D4'), /asked again to change an earlier decision \(D2\), after council decision D2/);
});

test('a step replaced with --fresh, or taken over by the senior after the compaction limit, keeps its count', () => {
  for (const how of ['fresh', 'senior']) {
    const p = project();
    let replaced = false;
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
      if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] }));
      if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D2'] })); return c.answer(decision({ title: 'Keep it' })); }
      if (c.role.startsWith('council')) return conflicting(c);
      if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 2) return ask(c, 'Which condition wins?');
      if (c.role === 'implementer' && c.slice === 'S1' && c.n === 3 && !replaced) { // D2 arrives; the worker gets stuck
        if (how === 'senior') { fs.appendFileSync(c.session, '{"type":"compaction"}\n{"type":"compaction"}\n'); return undefined; }
        c.write({ status: 'blocked', summary: 'stuck', question: 'Only a new session can continue.' });
        return c.later(() => { throw new StopRelay('Ctrl-C'); });
      }
      if (c.slice === 'S1' && (c.role === 'implementer' || c.role === 'senior') && decided(p) === 2) return ask(c, 'Which condition wins now?');
      return standard(c);
    });
    if (how === 'fresh') {
      assert.equal(h.run(), 1);
      replaced = true;
      assert.equal(h.run(['tt', '--fresh', 'implementer']), 0);
    } else {
      assert.equal(h.run(), 0);
    }
    assert.equal(votes(p), 2, `${how}: no third vote`);
    assert.match(by(p, 'D3'), SECOND_REVISIT, how);
  }
});

test('after the owner adds a prerequisite slice by hand, the resumed step keeps its count', () => {
  const p = project();
  let stopped = false;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
    if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] }));
    if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D2'] })); return c.answer(decision({ title: 'Keep it' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 2) return ask(c, 'Which condition wins?');
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 3 && !stopped) { // D2 arrives; the owner stops the relay
      c.write({ status: 'blocked', summary: 'paused', question: 'Waiting for the owner.' });
      return c.later(() => { stopped = true; throw new StopRelay('Ctrl-C'); });
    }
    if (c.role === 'implementer' && c.slice === 'S1' && decided(p) === 2) return ask(c, 'Which condition wins now?');
    return standard(c);
  });
  assert.equal(h.run(), 1);
  // The owner adds a slice ahead of the untouched S1 and re-runs.
  fs.writeFileSync(p.file('plan.md'), p.read('plan.md').replace('## S1:', '## S0: Fixture first\nNeeds: none\nAcceptance:\n- fixture\n\n## S1:'));
  assert.equal(h.run(), 0);
  assert.ok(p.state().slices.S0, 'the added slice ran');
  assert.equal(votes(p), 2);
  assert.match(by(p, 'D3'), SECOND_REVISIT);
});

test('a step counted by an earlier relay version (one decision id) keeps working', () => {
  const p = project();
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return ask(c);
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 2) { // D1 arrives; the relay is stopped while the worker waits
      c.write({ status: 'blocked', summary: 'paused', question: 'Waiting.' });
      return c.later(() => { throw new StopRelay('Ctrl-C'); });
    }
    if (c.role === 'advisor') return c.write(cbrief({ revisits: [] }));
    if (c.role.startsWith('council')) return c.write(vote());
    return standard(c);
  });
  assert.equal(h.run(), 1);
  const st = p.state();
  assert.deepEqual(Object.values(st.cur.councilAsked), [['D1']]);
  st.cur.councilAsked = Object.fromEntries(Object.keys(st.cur.councilAsked).map((k) => [k, 'D1'])); // the earlier format
  fs.writeFileSync(p.file('relay/state.json'), JSON.stringify(st));
  const worker = h.prompts.filter((c) => c.role === 'implementer').at(-1);
  h.pending.push(() => writeResult(worker.resultPath, { status: 'needs-decision', summary: 'a choice', question: 'Which file name?',
    options: [{ label: 'Keep', consequence: 'a' }, { label: 'Replace', consequence: 'b' }], recommended: 1, reason: 'r' }, { after: worker.resultPath }));
  assert.equal(h.run(), 0);
  assert.match(by(p, 'D2'), /Decided by the council/);
  assert.match(assignment(h.prompts.filter((c) => c.role === 'council1').at(-1)), /This worker step already received council decision D1\. /);
});

test('a revisit counted before a council-chosen prerequisite slice still counts after it', () => {
  const p = project();
  const slice = { title: 'Make fixture', acceptance: ['fixture exists'] };
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 3) return ask(c, 'Which condition wins?');
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
    if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] }, [{ ...OPTIONS[0], slice }, OPTIONS[1]]));
    if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D2'] })); return c.answer(decision({ title: 'Keep it' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(Object.keys(p.state().slices).length, 3, 'the prerequisite slice ran');
  assert.equal(votes(p), 2);
  assert.match(by(p, 'D3'), SECOND_REVISIT);
});

test('a re-reviewer replaced with --fresh (a full review again) keeps its step\'s count', () => {
  const p = project();
  let stopped = false;
  let reviews = 0;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.slice === 'S1') {
      reviews++;
      if (reviews === 1) return c.write(done('one finding', { verdict: 'changes-required', blocking: ['R1'] }));
      if (decided(p) === 0) return ask(c, 'Which rule applies?'); // the re-review asks
      if (decided(p) === 1) return ask(c, 'The conditions conflict: which wins?');
      if (decided(p) === 2 && !stopped) { c.write({ status: 'blocked', summary: 'stuck', question: 'Only a new session can continue.' }); return c.later(() => { stopped = true; throw new StopRelay('Ctrl-C'); }); }
      if (decided(p) === 2) return ask(c, 'Which wins now?'); // the fresh reviewer
      return c.write(accept());
    }
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
    if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] }));
    if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D2'] })); return c.answer(decision({ title: 'Keep it' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    return standard(c);
  });
  assert.equal(h.run(), 1);
  assert.equal(h.run(['tt', '--fresh', 'reviewer']), 0);
  assert.equal(votes(p), 2);
  assert.match(by(p, 'D3'), /It came to the owner because the reviewer asked again to change an earlier decision \(D2\), after council decision D2/);
});

test('a final verification restarted after a council-chosen prerequisite slice keeps its count', () => {
  const p = project();
  const slice = { title: 'Make fixture', acceptance: ['fixture exists'] };
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'FINAL' && decided(p) < 3) return ask(c, 'Which check?');
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
    if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] }, [{ ...OPTIONS[0], slice }, OPTIONS[1]]));
    if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D2'] })); return c.answer(decision({ title: 'Keep it' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(Object.keys(p.state().slices).length, 3, 'the prerequisite slice ran');
  assert.equal(votes(p), 2);
  assert.match(by(p, 'D3'), SECOND_REVISIT);
  assert.equal(p.state().finalCouncil, undefined, 'consumed when the final verification restarted');
});
