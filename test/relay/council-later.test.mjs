// Later questions of a worker step that already had a council decision: they go to the council too, including
// ones that would change an earlier decision ("revisits"), until the step goes round in circles: a third question
// that would change the same decision (its amendments in the step counting as the same decision), or any question
// after six council decisions in the step, goes to the owner. The counts survive whatever rebuilds the step (a
// prerequisite slice, --fresh, the senior, a restart, a relay version that counted differently).
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
const circles = (role, again, before) => new RegExp(`It came to the owner because this ${role} step is going round in circles: `
  + `this question would change ${again} again, after council decisions ${before} already changed it\\.`);
const THIRD_CHANGE = circles('(?:implementer|senior)', 'D1', 'D2, D3');

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
  assert.match(assignment(second), /## Earlier decisions\n\nThis worker step already received council decision D1\. If this question would in fact change it: A council decision may be amended within its intent [^\n]*the step goes to the owner as going round in circles\.\n/);
});

test('the council changes a decision twice in a step, an amendment counting as the same decision; a third change goes to the owner', () => {
  const p = project();
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 4) return ask(c, 'The conditions conflict: which wins?');
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
    if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] }));
    if (c.role === 'advisor' && c.n === 3) return c.write(cbrief({ revisits: ['D2'] })); // amends the amendment of D1
    if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D3'] })); return c.answer(decision({ title: 'Keep the fixture' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(votes(p), 3, 'the third change has no vote');
  assert.match(by(p, 'D2'), /Decided by the council/);
  assert.match(by(p, 'D3'), /Decided by the council/);
  assert.match(by(p, 'D4'), THIRD_CHANGE);
  const second = assignment(h.prompts.filter((c) => c.role === 'council2')[1]).replace(/\s+/g, ' ');
  assert.match(second, /The advisor says this question would change or work around D1, or that the worker cannot follow its conditions\. .*A council decision may be amended within its intent .*any change to a decision of the owner's, needs the owner \(set "ownerNeeded"\) unless the project's own rules let the council make it\. Within one worker step the council answers at most two questions that change the same decision \(its amendments in the step count as the same decision\) and six questions in all; past that, the step goes to the owner as going round in circles\./);
  assert.equal(p.events().find((e) => e.type === 'advisor_brief' && e.revisits.length)?.revisits[0], 'D1', 'the brief event keeps revisits');
  assert.match(h.output.replace(/\s*┃\s*/g, ' '), /Topic so far: 1 decision by you \(1 of 1 the recommended option\) · \d+s waiting before you answered · 3 decisions by the council\./);
  h.output = '';
  assert.equal(h.run(['tt', '--status']), 0);
  assert.match(h.output, /asked\s+1 decision by you \(1 of 1 the recommended option\) · \d+s waiting before you answered · 3 decisions by the council/);
});

test('changes to different decisions are counted apart', () => {
  const p = project();
  const REVISITS = [[], [], ['D1'], ['D2'], ['D3']]; // D3 changes D1, D4 changes D2, D5 changes D3 (D1's second change)
  // The sixth question would change D2's amendment (a second change of D2, allowed) and D1's (a third: the owner's).
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 6) return ask(c, `Question ${c.n}?`);
    if (c.role === 'advisor' && c.n <= 5) return c.write(cbrief({ revisits: REVISITS[c.n - 1] }));
    if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D4', 'D5'] })); return c.answer(decision({ title: 'Third change of D1' })); }
    if (c.role.startsWith('council')) return c.write(vote());
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(votes(p), 5);
  assert.match(by(p, 'D6'), circles('implementer', 'D1', 'D3, D5'));
});

test('after six council decisions in one step, its next question goes to the owner', () => {
  const p = project();
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 7) return ask(c, `Question ${c.n}?`);
    if (c.role === 'advisor' && c.n <= 6) return c.write(cbrief({ revisits: [] }));
    if (c.role === 'advisor') { c.write(cbrief({ revisits: [] })); return c.answer(decision({ title: 'Seventh', chosen: 2 })); }
    if (c.role.startsWith('council')) return c.write(vote());
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(votes(p), 6);
  assert.match(by(p, 'D7'), /It came to the owner because this implementer step is going round in circles: the council already decided 6 of its questions \(D1, D2, D3, D4, D5, D6\)\./);
  // The owner's summary counts his choices where recorded by their number: not an earlier relay version's decision
  // without one, nor one recorded as none of the options or unknown (null). A wait the relay stopped on counts until
  // the recorded stop; one whose end was not recorded (Ctrl-C) is listed as not timed.
  const old = (t, extra) => `${JSON.stringify({ t: `2026-01-01T${t}Z`, run: 'old-1', ...extra })}\n`;
  fs.appendFileSync(p.file('relay/events.jsonl'), old('00:00:00', { type: 'owner_decision', id: 'D0' })
    + old('00:00:01', { type: 'owner_decision', id: 'D00', chosen: null })
    + old('00:00:02', { type: 'operator_wait_start', role: 'advisor' }) + old('01:00:02', { type: 'run_stop', reason: 'stopped' })
    + `${JSON.stringify({ t: '2026-01-02T00:00:00Z', run: 'old-2', type: 'operator_wait_start', role: 'implementer' })}\n`); // then Ctrl-C
  h.output = '';
  assert.equal(h.run(['tt', '--status']), 0);
  assert.match(h.output, /asked\s+3 decisions by you \(0 of 1 the recommended option\) · 1h 00m waiting before you answered \(plus 1 wait not timed: interrupted or still open\) · 6 decisions by the council/);
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
    if (c.role === 'advisor' && c.n === 3) return c.write(cbrief({ revisits: ['D2'] }));
    if (c.role === 'advisor' && c.n === 4) { c.write(cbrief({ revisits: ['D3'] })); return c.answer(decision({ title: 'Another fixture first', slice: SLICE('Fixture two') })); }
    if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D3'] })); return c.answer(decision({ title: 'Keep it' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 5) return ask(c, 'Which condition wins?'); // first, then after each decision
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(votes(p), 3);
  assert.deepEqual(p.read('decisions.md').match(/^## D\d+ [^\n]*/gm).map((l) => l.replace(/ · \d{4}-\d\d-\d\d/, '')),
    ['## D1 · S1 · B: fix both', '## D2 · S1 · B: fix both', '## D3 · S1 · B: fix both', '## D4 · S1 · Another fixture first', '## D5 · S1 · Keep it']);
  assert.match(by(p, 'D5'), THIRD_CHANGE);
});

test('a step replaced with --fresh, or taken over by the senior after the compaction limit, keeps its count', () => {
  for (const how of ['fresh', 'senior']) {
    const p = project();
    let replaced = false;
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
      if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] }));
      if (c.role === 'advisor' && c.n === 3) return c.write(cbrief({ revisits: ['D2'] }));
      if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D3'] })); return c.answer(decision({ title: 'Keep it' })); }
      if (c.role.startsWith('council')) return conflicting(c);
      if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 3) return ask(c, 'Which condition wins?');
      if (c.role === 'implementer' && c.slice === 'S1' && c.n === 4 && !replaced) { // D3 arrives; the worker gets stuck
        if (how === 'senior') { fs.appendFileSync(c.session, '{"type":"compaction"}\n{"type":"compaction"}\n'); return undefined; }
        c.write({ status: 'blocked', summary: 'stuck', question: 'Only a new session can continue.' });
        return c.later(() => { throw new StopRelay('Ctrl-C'); });
      }
      if (c.slice === 'S1' && (c.role === 'implementer' || c.role === 'senior') && decided(p) === 3) return ask(c, 'Which condition wins now?');
      return standard(c);
    });
    if (how === 'fresh') {
      assert.equal(h.run(), 1);
      replaced = true;
      assert.equal(h.run(['tt', '--fresh', 'implementer']), 0);
    } else {
      assert.equal(h.run(), 0);
    }
    assert.equal(votes(p), 3, `${how}: no fourth vote`);
    assert.match(by(p, 'D4'), THIRD_CHANGE, how);
  }
});

test('after the owner adds a prerequisite slice by hand, the resumed step keeps its count', () => {
  const p = project();
  let stopped = false;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
    if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] }));
    if (c.role === 'advisor' && c.n === 3) return c.write(cbrief({ revisits: ['D2'] }));
    if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D3'] })); return c.answer(decision({ title: 'Keep it' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 3) return ask(c, 'Which condition wins?');
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 4 && !stopped) { // D3 arrives; the owner stops the relay
      c.write({ status: 'blocked', summary: 'paused', question: 'Waiting for the owner.' });
      return c.later(() => { stopped = true; throw new StopRelay('Ctrl-C'); });
    }
    if (c.role === 'implementer' && c.slice === 'S1' && decided(p) === 3) return ask(c, 'Which condition wins now?');
    return standard(c);
  });
  assert.equal(h.run(), 1);
  // The owner adds a slice ahead of the untouched S1 and re-runs.
  fs.writeFileSync(p.file('plan.md'), p.read('plan.md').replace('## S1:', '## S0: Fixture first\nNeeds: none\nAcceptance:\n- fixture\n\n## S1:'));
  assert.equal(h.run(), 0);
  assert.ok(p.state().slices.S0, 'the added slice ran');
  assert.equal(votes(p), 3);
  assert.match(by(p, 'D4'), THIRD_CHANGE);
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

test('a change counted by an earlier relay version (the id of the amendment only) counts as one change of every decision', () => {
  // After the upgrade, two more questions name the original (D1) or the old amendment (D2), in each order.
  for (const [third, fourth, again] of [['D1', 'D1', 'D1'], ['D2', 'D1', 'D1'], ['D1', 'D2', 'D2']]) {
    const p = project();
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 2) return ask(c, 'Which condition wins?');
      if (c.role === 'implementer' && c.slice === 'S1' && c.n === 3) { // D2 arrives; the relay is stopped while the worker waits
        c.write({ status: 'blocked', summary: 'paused', question: 'Waiting.' });
        return c.later(() => { throw new StopRelay('Ctrl-C'); });
      }
      if (c.role === 'implementer' && c.slice === 'S1' && c.n === 4) return ask(c, 'Which condition wins now?');
      if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
      if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] })); // D2, before the stop
      if (c.role === 'advisor' && c.n === 3) return c.write(cbrief({ revisits: [third] }));
      if (c.role === 'advisor') { c.write(cbrief({ revisits: [fourth] })); return c.answer(decision({ title: 'Keep it' })); }
      if (c.role.startsWith('council')) return conflicting(c);
      return standard(c);
    });
    assert.equal(h.run(), 1);
    const st = p.state();
    const [key] = Object.keys(st.cur.councilAsked);
    assert.deepEqual(st.cur.councilRevisits[key], [{ id: 'D2', revisits: ['D1'] }]);
    delete st.cur.councilRevisits; // the earlier format: the amendment's id, without the decision it changed
    st.cur.councilRevisited = { [key]: 'D2' };
    fs.writeFileSync(p.file('relay/state.json'), JSON.stringify(st));
    const worker = h.prompts.filter((c) => c.role === 'implementer').at(-1);
    h.pending.push(() => writeResult(worker.resultPath, { status: 'needs-decision', summary: 'a choice', question: 'Which condition wins?',
      options: [{ label: 'Keep', consequence: 'a' }, { label: 'Replace', consequence: 'b' }], recommended: 1, reason: 'r' }, { after: worker.resultPath }));
    assert.equal(h.run(), 0);
    const order = `${third} then ${fourth}`;
    assert.equal(votes(p), 3, `${order}: D1, D2 and one more change (D3) by the council`);
    assert.match(by(p, 'D3'), /Decided by the council/, order);
    assert.match(by(p, 'D4'), circles('implementer', again, 'D2, D3'), order);
  }
});

test('a revisit counted before a council-chosen prerequisite slice still counts after it', () => {
  const p = project();
  const slice = { title: 'Make fixture', acceptance: ['fixture exists'] };
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n <= 4) return ask(c, 'Which condition wins?');
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
    if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] }, [{ ...OPTIONS[0], slice }, OPTIONS[1]]));
    if (c.role === 'advisor' && c.n === 3) return c.write(cbrief({ revisits: ['D2'] }));
    if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D3'] })); return c.answer(decision({ title: 'Keep it' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(Object.keys(p.state().slices).length, 3, 'the prerequisite slice ran');
  assert.equal(votes(p), 3);
  assert.match(by(p, 'D4'), THIRD_CHANGE);
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
      if (decided(p) === 2) return ask(c, 'They conflict again: which wins?');
      if (decided(p) === 3 && !stopped) { c.write({ status: 'blocked', summary: 'stuck', question: 'Only a new session can continue.' }); return c.later(() => { stopped = true; throw new StopRelay('Ctrl-C'); }); }
      if (decided(p) === 3) return ask(c, 'Which wins now?'); // the fresh reviewer
      return c.write(accept());
    }
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
    if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] }));
    if (c.role === 'advisor' && c.n === 3) return c.write(cbrief({ revisits: ['D2'] }));
    if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D3'] })); return c.answer(decision({ title: 'Keep it' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    return standard(c);
  });
  assert.equal(h.run(), 1);
  assert.equal(h.run(['tt', '--fresh', 'reviewer']), 0);
  assert.equal(votes(p), 3);
  assert.match(by(p, 'D4'), circles('reviewer', 'D1', 'D2, D3'));
});

test('a final verification restarted after a council-chosen prerequisite slice keeps its count', () => {
  const p = project();
  const slice = { title: 'Make fixture', acceptance: ['fixture exists'] };
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'FINAL' && decided(p) < 4) return ask(c, 'Which check?');
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
    if (c.role === 'advisor' && c.n === 2) return c.write(cbrief({ revisits: ['D1'] }, [{ ...OPTIONS[0], slice }, OPTIONS[1]]));
    if (c.role === 'advisor' && c.n === 3) return c.write(cbrief({ revisits: ['D2'] }));
    if (c.role === 'advisor') { c.write(cbrief({ revisits: ['D3'] })); return c.answer(decision({ title: 'Keep it' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(Object.keys(p.state().slices).length, 3, 'the prerequisite slice ran');
  assert.equal(votes(p), 3);
  assert.match(by(p, 'D4'), THIRD_CHANGE);
  assert.equal(p.state().finalCouncil, undefined, 'consumed when the final verification restarted');
});
