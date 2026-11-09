// The advisory council: two independent votes decide a delegated question; everything else, and every
// failure of the mechanism, goes to the owner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { FakeHerdr, StopRelay, brief, decision, done, makeProject, standard, writeResult } from './harness.mjs';

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';
const ROLES = Object.fromEntries(['planner', 'scout', 'architect', 'implementer', 'senior', 'reviewer', 'advisor', 'council1', 'council2']
  .map((r) => [r, { model: `test/${r}`, thinking: 'low' }]));
const COUNCIL = { enabled: true, members: ['council1', 'council2'], ownerClasses: ['E', 'F', 'G', 'H', 'I'], timeoutMinutes: 30 };
const project = (council = {}) => makeProject({ plan: ONE, config: { roles: ROLES, council: { ...COUNCIL, ...council } } });

const askOnce = (c) => c.write({
  status: 'needs-decision', summary: 'a choice', question: 'Which fix?',
  options: [{ label: 'Fix both', consequence: 'b' }, { label: 'Fix one', consequence: 'a' }], recommended: 1, reason: 'r',
});
// The advisor's brief lists its recommendation first; the members see the options sorted by label:
// X1 = "A: fix one" (option 2), X2 = "B: fix both" (option 1).
const OPTIONS = [
  { label: 'B: fix both', consequence: 'both fixed', action: 'Fix the weight bug completely.', classes: ['A'] },
  { label: 'A: fix one', consequence: 'one fixed', action: 'Fix only the undefined part.', classes: ['A'] },
];
const cbrief = (extra = {}, options = OPTIONS) => brief({ options, ownerNeeded: null, reason: 'SECRET-RECOMMENDATION-REASON', ...extra });
const vote = (choice = 'X2', extra = {}) => ({
  status: 'done', choice, conditions: [], classes: ['A'], ownerNeeded: null, confidence: 'high', reversibility: 'easy',
  reasons: 'the evidence', objection: 'none decisive', ownerSummary: `I would ${choice === 'X2' ? 'fix both' : 'fix one'}.`, ...extra,
});
// A decision written as if by the advisor, which the relay must ignore for a council decision.
const councilDecision = (extra = {}) => decision({ title: 'Fix the weight bug', decision: 'The advisory council decided: fix the weight bug completely.', replies: { implementer: 'Fix both.', reviewer: 'Check both fixes.' }, ...extra });

// Plays the worker, the advisor and both members. `votes` gives each member's vote(s) by call number. The
// advisor writes only the brief (and the owner's decision when the question reaches the owner); any other
// advisor prompt fails the test through standard().
function play({ votes = {}, owner = decision() } = {}) {
  return (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return askOnce(c);
    if (c.role === 'advisor' && c.n === 1) {
      c.write(cbrief());
      return c.answer(owner); // used only if the question reaches the owner
    }
    if (c.role === 'council1' || c.role === 'council2') {
      const v = votes[c.role]?.[c.n - 1] ?? vote();
      return typeof v === 'function' ? v(c) : c.write(v);
    }
    return standard(c);
  };
}

const councilPrompts = (h) => h.prompts.filter((x) => x.role.startsWith('council'));

test('two matching votes decide: recorded as the council\'s, delivered, notified, no owner wait', () => {
  const p = project();
  const order = [];
  const h = new FakeHerdr(p, (c) => {
    order.push(`prompt ${c.role}`);
    // Votes arrive later, so both members must have been prompted before the relay waits for either.
    if (c.role.startsWith('council')) return c.later(() => c.write(vote('X2', { conditions: c.role === 'council1' ? ['keep the old fixture'] : [] })));
    return play()(c);
  });
  const sleep = h.io().sleep;
  h.ioExtra.sleep = (ms) => { order.push('sleep'); sleep(ms); };
  const handle = h.handle.bind(h);
  h.handle = (a) => { // a member is working until its vote is written
    const m = a[0] === 'agent' && a[1] === 'get' && h.prompts.findLast((x) => x.name === a[2] && x.role.startsWith('council'));
    return m && !fs.existsSync(m.resultPath) ? h.ok({ agent: { agent_status: 'working' } }) : handle(a);
  };
  assert.equal(h.run(), 0);
  assert.deepEqual(order.slice(order.indexOf('prompt council1'), order.indexOf('prompt council1') + 3), ['prompt council1', 'prompt council2', 'sleep']);
  const assignment = fs.readFileSync(councilPrompts(h)[0].text.match(/council assignment at (\S+)/)[1], 'utf8');
  assert.match(assignment, /- \*\*X1\*\*: A: fix one\. Action: Fix only the undefined part\.\n- \*\*X2\*\*: B: fix both\. Action: Fix the weight bug completely\./);
  assert.ok(!/SECRET-RECOMMENDATION-REASON|recommended/i.test(assignment.replace('none is recommended', '')), 'members do not see the recommendation');
  assert.match(assignment, /The owner keeps classes E, F, G, H, I/);
  // The assignment gives the vote format itself, with every field of a vote the relay accepts.
  assert.match(assignment, /"choice": "X1 \| X2 \| new"/);
  for (const k of Object.keys(vote())) assert.match(assignment, new RegExp(`"${k}":`), `vote format has ${k}`);
  assert.equal(h.prompts.filter((x) => x.role === 'advisor').length, 1, 'the advisor writes the brief only: the relay records the council\'s decision');
  assert.match(p.read('decisions.md'), /## D1 · .* · S1 · B: fix both\n\nThe advisory council decided: B: fix both\.\nAction: Fix the weight bug completely\.\nConditions the members added \(they limit the action\):\n- keep the old fixture\n\n\*\*Decided by the council\*\* \(both members chose this option independently; council1 low, council2 low; class A; easy to reverse\)\. A later owner decision may overrule this one\.\n$/);
  assert.match(h.prompts.find((x) => x.role === 'implementer' && x.n === 2).text,
    /^Council decision D1 .*\n\nAction: Fix the weight bug completely\.\nConditions the members added \(they limit the action\):\n- keep the old fixture\nThis is binding: do not change the action\. If you cannot satisfy it and its conditions together, report needs-decision/);
  const reviewer = h.prompts.find((x) => x.role === 'reviewer');
  assert.match(reviewer.assignment() + reviewer.text, /Council decision D1 .*It applies to this slice: check that its action and conditions were followed\./s);
  const types = p.events().map((e) => e.type);
  assert.ok(types.includes('council_decision') && !types.includes('operator_wait_start') && !types.includes('owner_decision'));
  assert.equal(p.events().filter((e) => e.type === 'council_vote').length, 2);
  assert.match(h.output, /Decided by the advisory council[^\n]*\n[^\n]*D1 \(S1\): B: fix both/);
  assert.ok(Object.keys(p.state().slices).length > 0 && !p.state().cur?.agents?.council1, 'member tabs are closed');
});

test('the owner decides when anything reserves the question, and sees why and what each member proposed', () => {
  const cases = [
    [{ votes: { council2: [vote('X2', { classes: ['A', 'F'] })] } }, /council2 puts its choice in class F, which you keep/],
    [{ votes: { council1: [vote('X2', { ownerNeeded: 'it depends on the owner\'s taste.' })] } }, /council1: it depends on the owner's taste\.(?![.;])/],
    [{ votes: { council1: [vote('X2', { reversibility: 'irreversible' })] } }, /council1 judges its choice irreversible/],
    [{ votes: { council1: [vote('X2', { confidence: 'low' })], council2: [vote('X2', { confidence: 'low' })] } }, /both members have low confidence/],
    [{ votes: { council1: [vote('X1')] } }, /the members chose different options/],
    [{ votes: { council1: [vote('new', { newOption: 'Rewrite the module.' })], council2: [vote('new', { newOption: 'Rewrite the module.' })] } }, /proposes an option the brief does not list/],
    [{ brief: cbrief({}, [OPTIONS[0], { ...OPTIONS[1], classes: ['A'] }].map((o, i) => (i === 0 ? o : o))), votes: { council1: [vote('X1')], council2: [vote('X1')] }, optionClasses: ['E'] }, /the advisor puts the chosen option in class E, which you keep/],
  ];
  for (const [setup, why] of cases) {
    const p = project();
    const options = setup.optionClasses ? [OPTIONS[0], { ...OPTIONS[1], classes: setup.optionClasses }] : OPTIONS;
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'advisor' && c.n === 1) { c.write(cbrief({}, options)); return c.answer(decision()); }
      return play(setup)(c);
    });
    assert.equal(h.run(), 0);
    assert.match(h.output, /The advisory council sent this to you: /);
    assert.match(h.output.replace(/\s+/g, ' '), new RegExp(why.source.replace(/ /g, '\\s+')));
    assert.match(h.output, /council1 would choose (?:"[^"]+"|an option of its own) \(\w+ confidence\): I would/, 'each member\'s plain proposal is shown');
    assert.match(p.read('decisions.md'), /The owner chose A\.\n\n\*\*Decided by the owner\.\*\* It came to the owner because /);
    assert.ok(!/\.[.;]/.test(p.read('decisions.md')), 'reasons are joined without doubled punctuation');
    assert.ok(!p.events().some((e) => e.type === 'council_decision'));
    assert.equal(h.prompts.filter((x) => x.role === 'advisor').length, 1, 'the advisor is not asked to write a council decision');
  }
});

test('the council is not consulted when the advisor recommends an owner class or says the owner must decide', () => {
  for (const extra of [{ ownerNeeded: 'a product preference' }, null]) {
    const p = project();
    const options = extra ? OPTIONS : [{ ...OPTIONS[0], classes: ['G'] }, OPTIONS[1]];
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'advisor' && c.n === 1) { c.write(cbrief(extra ?? {}, options)); return c.answer(decision()); }
      return play()(c);
    });
    assert.equal(h.run(), 0);
    assert.equal(councilPrompts(h).length, 0);
    assert.match(h.output, extra ? /not consulted: the advisor: a product preference/ : /not consulted: the recommended option is class G/);
    assert.match(p.read('decisions.md'), /\*\*Decided by the owner\.\*\*/);
  }
});

test('a brief without actions and classes goes back to the advisor when the council is enabled', () => {
  const p = project();
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'advisor' && c.n === 1) return c.write(brief());
    if (c.role === 'advisor' && c.n === 2) { assert.match(c.text, /option 1 needs "action" .* and "classes"/); return c.write(cbrief()); }
    return play()(c);
  });
  assert.equal(h.run(), 0);
  assert.match(h.prompts.find((x) => x.role === 'advisor').assignment(), /The advisory council is enabled\.[\s\S]*\| A \| Technical choice/);
  assert.match(p.read('decisions.md'), /Decided by the council/);
});

test('an invalid vote is corrected once; a second failure, a vanished member or a failed start sends the question to the owner', () => {
  // Corrected once: decided.
  let p = project();
  let h = new FakeHerdr(p, play({ votes: { council2: [{ status: 'done', choice: 'X9' }, vote()] } }));
  assert.equal(h.run(), 0);
  assert.match(councilPrompts(h).find((x) => x.role === 'council2' && x.n === 2).text, /"choice" must be one of X1, X2/);
  assert.match(p.read('decisions.md'), /Decided by the council/);

  const owner = [
    ['invalid twice', (hh) => play({ votes: { council2: [{ status: 'done' }, '{"broken'] } }), /council2 gave no usable vote \(Your vote file is invalid/],
    ['no vote twice', () => play({ votes: { council2: [() => {}, () => {}] } }), /council2 gave no usable vote \(You stopped without writing your vote/],
    ['vanished', (hh) => play({ votes: { council2: [(c) => { hh.agents.get(c.name).alive = false; }] } }), /council2 gave no usable vote \(its agent is gone\)/],
  ];
  for (const [name, mk, why] of owner) {
    p = project();
    h = new FakeHerdr(p, () => {});
    h.worker = mk(h);
    assert.equal(h.run(), 0, name);
    assert.match(h.output.replace(/\s+/g, ' '), new RegExp(why.source.replace(/ /g, '\\s+')), name);
    assert.match(p.read('decisions.md'), /\*\*Decided by the owner\.\*\*/, name);
  }

  // A member that cannot start: the other member's vote alone never decides.
  p = project();
  h = new FakeHerdr(p, play());
  const handle = h.handle.bind(h);
  h.handle = (a) => (a[0] === 'agent' && a[1] === 'start' && a[2].includes('council2') ? h.err('provider', 'model unavailable') : handle(a));
  assert.equal(h.run(), 0);
  assert.match(h.output.replace(/\s+/g, ' '), /council2 gave no usable vote \(could not start: Could not start council2: provider: model unavailable\)/);
  assert.match(p.read('decisions.md'), /\*\*Decided by the owner\.\*\*/);
});

test('a member that keeps working past the time limit is dropped and the owner decides', () => {
  const p = project({ timeoutMinutes: 0.00001 });
  const h = new FakeHerdr(p, play({ votes: { council2: [() => {}] } }));
  const handle = h.handle.bind(h);
  h.handle = (a) => {
    if (a[0] === 'agent' && a[1] === 'get' && a[2].includes('council2')) return h.ok({ agent: { agent_status: 'working' } });
    return handle(a);
  };
  assert.equal(h.run(), 0);
  assert.match(h.output.replace(/\s+/g, ' '), /council2 gave no usable vote \(no vote after/);
  assert.match(p.read('decisions.md'), /\*\*Decided by the owner\.\*\*/);
});

test('the relay records the council\'s decision from the vote: a decision the advisor writes anyway is ignored', () => {
  const p = project();
  let briefPath = null;
  let stray = null;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'advisor' && c.n === 1) { briefPath = c.resultPath; return c.write(cbrief()); }
    if (c.role === 'council1') { // while the members vote, the advisor writes a decision nobody asked for, with another action
      writeResult(briefPath, councilDecision({ title: 'Push it', decision: 'The council approved pushing to the remote.', replies: { implementer: 'Push to the remote now.' } }), { after: briefPath });
    }
    if (c.role === 'implementer' && c.n === 2) stray = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
    return play()(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(stray?.status, 'done', 'the stray decision was in the advisor\'s result file when the relay decided');
  assert.match(stray.replies.implementer, /Push to the remote/);
  assert.doesNotMatch(p.read('decisions.md'), /push/i);
  const delivered = h.prompts.find((x) => x.role === 'implementer' && x.n === 2).text;
  assert.match(delivered, /Action: Fix the weight bug completely\./);
  assert.doesNotMatch(delivered, /push/i);
  assert.ok(p.events().some((e) => e.type === 'council_decision' && e.title === 'B: fix both'));
});

test('options are fully checked before the vote, and members see every field that would bind', () => {
  const p = project();
  const slice = { title: 'Make the fixture', acceptance: ['fixture.txt exists', 'it is committed'], notes: 'use the old data' };
  const deferral = { missing: 'the measurements', source: 'S3', decisionPoint: 'the end of S3', interim: 'keep the old value' };
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief({}, [{ ...OPTIONS[0], slice: { title: 'No acceptance', acceptance: 'x' } }, OPTIONS[1]]));
    if (c.role === 'advisor' && c.n === 2) {
      assert.match(c.text, /Option 1's prerequisite "slice" needs a one-line "title" and at least one one-line "acceptance" condition/);
      return c.write(cbrief({}, [{ ...OPTIONS[0], slice }, { ...OPTIONS[1], deferral }]));
    }
    return play()(c);
  });
  assert.equal(h.run(), 0);
  const assignment = fs.readFileSync(councilPrompts(h)[0].text.match(/council assignment at (\S+)/)[1], 'utf8');
  assert.match(assignment, /First inserts a prerequisite slice: "Make the fixture", acceptance: fixture\.txt exists; it is committed\. Notes: use the old data/);
  assert.match(assignment, /Postpones the decision: missing the measurements; from S3; decided at the end of S3; until then keep the old value\./);
});

test('a postponing council decision tells the worker what to do until the decision point', () => {
  const p = project();
  const deferral = { missing: 'the measurements', source: 'S3', decisionPoint: 'the end of S3', interim: 'keep the old value' };
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief({}, [OPTIONS[0], { ...OPTIONS[1], deferral }]));
    if (c.role.startsWith('council')) return c.write(vote('X1')); // X1 = "A: fix one", the postponing option
    return play()(c);
  });
  assert.equal(h.run(), 0);
  assert.match(h.prompts.find((x) => x.role === 'implementer' && x.n === 2).text,
    /Action: Fix only the undefined part\.\nThe decision itself is postponed until the end of S3\. Until then: keep the old value\nThis is binding/);
  assert.match(p.read('decisions.md'), /\*\*Deferred\.\*\*\n- Missing information: the measurements/);
});

test('a worker that cannot follow a council decision asks again, and that question goes to the owner without a new vote', () => {
  const p = project();
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.n === 2) { // the decision arrives; its conditions cannot be met together
      return c.write({ status: 'needs-decision', summary: 'conflict', question: 'The two conditions contradict each other: which wins?',
        options: [{ label: 'Keep the fixture', consequence: 'a' }, { label: 'Replace it', consequence: 'b' }], recommended: 1, reason: 'r' });
    }
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
    if (c.role === 'advisor') { c.write(cbrief()); return c.answer(decision({ title: 'Keep the fixture', replies: { implementer: 'Keep the fixture.' } })); }
    if (c.role.startsWith('council')) return c.write(vote('X2', { conditions: [`${c.role}: ${c.role === 'council1' ? 'keep' : 'replace'} the fixture`] }));
    return play()(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(p.events().filter((e) => e.type === 'council_start').length, 1, 'no second vote');
  assert.match(p.read('decisions.md'), /## D2 · .* · Keep the fixture\n[\s\S]*\*\*Decided by the owner\.\*\* It came to the owner because the implementer asked again after council decision D1\./);
});

test('a council decision with a prerequisite slice records its specification, points the reviewer to it, and a later question goes to the owner', () => {
  const p = project();
  const slice = { title: 'Make fixture', acceptance: ['fixture exists'], notes: 'use old data' };
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief({}, [{ ...OPTIONS[0], slice }, OPTIONS[1]]));
    if (c.role === 'advisor') { c.write(cbrief()); return c.answer(decision({ title: 'Keep the fixture' })); }
    if (c.role.startsWith('council')) return c.write(vote('X2', { conditions: [`${c.role}: ${c.role === 'council1' ? 'keep' : 'replace'} the fixture`] }));
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 2) { // resumed after the prerequisite: the conditions conflict
      return c.write({ status: 'needs-decision', summary: 'conflict', question: 'Which condition wins?',
        options: [{ label: 'Keep', consequence: 'a' }, { label: 'Replace', consequence: 'b' }], recommended: 1, reason: 'r' });
    }
    return play()(c);
  });
  assert.equal(h.run(), 0);
  assert.match(p.read('decisions.md'), /## D1 · .* · S1 · B: fix both\n\nThe advisory council decided: B: fix both\.\nAction: Fix the weight bug completely\.\nConditions the members added \(they limit the action\):\n- council1: keep the fixture\n- council2: replace the fixture\nA prerequisite slice runs first: "Make fixture"; acceptance: fixture exists\. Notes: use old data\n/);
  assert.equal(p.events().filter((e) => e.type === 'council_start').length, 1, 'no second vote');
  assert.match(p.read('decisions.md'), /## D2 · [\s\S]*It came to the owner because the implementer asked again after council decision D1\./);
  const reviewer = h.prompts.find((x) => x.role === 'reviewer' && x.slice === 'S1');
  assert.match(reviewer.assignment() + reviewer.text, /Council decision D1 .*It applies to this slice: check that its action and conditions were followed\./s);
});

// The mark that sends a later question of the same step to the owner survives everything that rebuilds the step.
const conflict = (c) => c.write({ status: 'needs-decision', summary: 'conflict', question: 'Which condition wins?',
  options: [{ label: 'Keep', consequence: 'a' }, { label: 'Replace', consequence: 'b' }], recommended: 1, reason: 'r' });
const conflicting = (c) => c.write(vote('X2', { conditions: [`${c.role}: ${c.role === 'council1' ? 'keep' : 'replace'} the fixture`] }));

test('after an owner decision that inserts another prerequisite slice, the step still asks the owner, not the council', () => {
  const p = project();
  const SLICE = (title) => ({ title, acceptance: [`${title} exists`] });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief({}, [{ ...OPTIONS[0], slice: SLICE('Fixture one') }, OPTIONS[1]]));
    if (c.role === 'advisor' && c.n === 2) { c.write(cbrief()); return c.answer(decision({ title: 'Another fixture first', slice: SLICE('Fixture two') })); }
    if (c.role === 'advisor') { c.write(cbrief()); return c.answer(decision({ title: 'Keep it' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    if (c.role === 'implementer' && c.slice === 'S1' && (c.n === 2 || c.n === 3)) return conflict(c); // after each prerequisite
    return play()(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(p.events().filter((e) => e.type === 'council_start').length, 1, 'no second vote');
  assert.deepEqual(p.read('decisions.md').match(/^## D\d+ [^\n]*/gm).map((l) => l.replace(/ · \d{4}-\d\d-\d\d/, '')),
    ['## D1 · S1 · B: fix both', '## D2 · S1 · Another fixture first', '## D3 · S1 · Keep it']);
  assert.match(p.read('decisions.md'), /## D3 [\s\S]*asked again after council decision D1\./);
});

test('a step replaced with --fresh, or taken over by the senior after the compaction limit, keeps the mark', () => {
  for (const how of ['fresh', 'senior']) {
    const p = project();
    let replaced = false;
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
      if (c.role === 'advisor') { c.write(cbrief()); return c.answer(decision({ title: 'Keep it' })); }
      if (c.role.startsWith('council')) return conflicting(c);
      if (c.role === 'implementer' && c.slice === 'S1' && c.n === 2 && !replaced) { // the decision arrives; the worker gets stuck
        if (how === 'senior') { fs.appendFileSync(c.session, '{"type":"compaction"}\n{"type":"compaction"}\n'); return undefined; }
        c.write({ status: 'blocked', summary: 'stuck', question: 'Only a new session can continue.' });
        return c.later(() => { throw new StopRelay('Ctrl-C'); });
      }
      const answered = fs.existsSync(p.file('decisions.md')) && /^## D2 /m.test(p.read('decisions.md'));
      if (c.slice === 'S1' && ((c.role === 'implementer' && c.n >= 3) || c.role === 'senior') && !answered) return conflict(c); // asks once
      return play()(c);
    });
    if (how === 'fresh') {
      assert.equal(h.run(), 1);
      replaced = true;
      assert.equal(h.run(['tt', '--fresh', 'implementer']), 0);
    } else {
      assert.equal(h.run(), 0);
    }
    assert.equal(p.events().filter((e) => e.type === 'council_start').length, 1, `${how}: no second vote`);
    assert.match(p.read('decisions.md'), /## D2 [\s\S]*asked again after council decision D1\./, how);
  }
});

test('after the owner adds a prerequisite slice by hand, the resumed step still asks the owner, not the council', () => {
  const p = project();
  let stopped = false;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief());
    if (c.role === 'advisor') { c.write(cbrief()); return c.answer(decision({ title: 'Keep it' })); }
    if (c.role.startsWith('council')) return conflicting(c);
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 2 && !stopped) { // the decision arrives; the owner stops the relay
      c.write({ status: 'blocked', summary: 'paused', question: 'Waiting for the owner.' });
      return c.later(() => { stopped = true; throw new StopRelay('Ctrl-C'); });
    }
    if (c.role === 'implementer' && c.slice === 'S1' && c.n >= 2 && !/^## D2 /m.test(p.read('decisions.md'))) return conflict(c);
    return play()(c);
  });
  assert.equal(h.run(), 1);
  // The owner adds a slice ahead of the untouched S1 and re-runs.
  fs.writeFileSync(p.file('plan.md'), p.read('plan.md').replace('## S1:', '## S0: Fixture first\nNeeds: none\nAcceptance:\n- fixture\n\n## S1:'));
  assert.equal(h.run(), 0);
  assert.ok(p.state().slices.S0, 'the added slice ran');
  assert.equal(p.events().filter((e) => e.type === 'council_start').length, 1, 'no second vote');
  assert.match(p.read('decisions.md'), /## D2 [\s\S]*asked again after council decision D1\./);
});

test('a council decision for one step does not send another step\'s first question to the owner (scout, then architect)', () => {
  const p = makeProject({ plan: '# Plan\n\n## S1: Only\nNeeds: scout, architecture\nAcceptance:\n- x\n', config: { roles: ROLES, council: COUNCIL } });
  const h = new FakeHerdr(p, (c) => {
    if ((c.role === 'scout' || c.role === 'architect') && c.n === 1) return askOnce(c);
    if (c.role === 'advisor') return c.write(cbrief());
    if (c.role.startsWith('council')) return c.write(vote());
    return play()(c);
  });
  assert.equal(h.run(), 0);
  // The scout's, the architect's and the implementer's first questions (play() makes the implementer ask too).
  assert.equal(p.events().filter((e) => e.type === 'council_start').length, 3, 'each step\'s question has its own vote');
  assert.equal((p.read('decisions.md').match(/Decided by the council/g) ?? []).length, 3);
  assert.doesNotMatch(p.read('decisions.md'), /Decided by the owner/);
});

test('a council decision may insert a prerequisite slice when the chosen option proposes one', () => {
  const p = project();
  const slice = { title: 'Make the fixture', acceptance: ['fixture.txt exists'] };
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief({}, [{ ...OPTIONS[0], slice }, OPTIONS[1]]));
    return play()(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(h.prompts.filter((x) => x.role === 'advisor').length, 1, 'the slice comes from the voted option, not from the advisor');
  assert.match(p.read('plan.md'), /## S0: Make the fixture\nNeeds: none\nAcceptance:\n- fixture\.txt exists\nNotes: Prerequisite for S1, inserted by pi-relay from council decision D1\./);
});

test('a restart during the vote resumes it without a second brief, and a restart before delivery does not record twice', () => {
  let p = project();
  let h = new FakeHerdr(p, play({
    votes: { council2: [(c) => c.later(() => { throw new StopRelay('Ctrl-C'); }), vote()] },
  }));
  assert.equal(h.run(), 1);
  assert.equal(h.run(), 0);
  assert.equal(h.prompts.filter((x) => x.role === 'advisor' && x.n === 1).length, 1, 'one brief');
  assert.match(councilPrompts(h).find((x) => x.role === 'council2' && x.n === 2).text, /You stopped without writing your vote/);
  assert.equal((p.read('decisions.md').match(/^## D/gm) ?? []).length, 1);

  p = project();
  h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.n === 2) throw new StopRelay('Ctrl-C while delivering');
    return play()(c);
  });
  assert.equal(h.run(), 1);
  assert.equal(h.run(), 0);
  assert.equal((p.read('decisions.md').match(/^## D/gm) ?? []).length, 1);
  assert.match(h.prompts.find((x) => x.role === 'implementer' && x.n === 3).text, /^Council decision D1/);
  const reviewer = h.prompts.find((x) => x.role === 'reviewer');
  assert.equal(((reviewer.assignment() + reviewer.text).match(/Council decision D1/g) ?? []).length, 1, 'the reviewer\'s note is not doubled');
});

test('a malformed council configuration stops the run before any work; a topic can enable the global council alone', () => {
  for (const [council, roles, why] of [
    [{ members: ['council1'] }, {}, /council\.members must name exactly two distinct roles/],
    [{ members: ['council1', 'council1'] }, {}, /exactly two distinct roles/],
    [{ members: ['council1', 'reviewer'] }, {}, /council member "reviewer" must not be a worker or advisor role/],
    [{}, { council2: { model: 'test/council1' } }, /must use different models/],
    [{ members: ['council1', 'council3'] }, {}, /council member "council3" has no model/],
    [{ ownerClasses: ['E', 'Z'] }, {}, /council\.ownerClasses must list class letters/],
    [{ timeoutMinutes: 0 }, {}, /timeoutMinutes must be a positive number/],
  ]) {
    const p = makeProject({ plan: ONE, config: { roles: { ...ROLES, ...roles }, council: { ...COUNCIL, ...council } } });
    const h = new FakeHerdr(p, standard);
    assert.equal(h.run(), 2);
    assert.match(h.output.replace(/\s+/g, ' '), new RegExp(`Invalid council configuration: .*${why.source.replace(/ /g, '\\s+')}`));
    assert.equal(h.prompts.length, 0);
  }
  const p = makeProject({ plan: ONE, config: { roles: ROLES, council: { ...COUNCIL, enabled: false } } });
  fs.writeFileSync(p.file('relay.json'), JSON.stringify({ council: { enabled: true } }));
  const h = new FakeHerdr(p, play());
  assert.equal(h.run(), 0);
  assert.equal(councilPrompts(h).length, 2);
  assert.match(p.read('decisions.md'), /Decided by the council/);
});

test('the relay README lists the same decision classes as the code', async () => {
  const { CLASSES } = await import('../../agent/relay/lib/council.mjs');
  const readme = fs.readFileSync(new URL('../../agent/relay/README.md', import.meta.url), 'utf8');
  for (const [k, v] of Object.entries(CLASSES)) assert.ok(readme.includes(`| ${k} | ${v} |`), `class ${k}`);
});
