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
const councilDecision = (extra = {}) => decision({ title: 'Fix the weight bug', decision: 'The advisory council decided: fix the weight bug completely.', replies: { implementer: 'Fix both.', reviewer: 'Check both fixes.' }, ...extra });

// Plays the worker, the advisor and both members. `votes` gives each member's vote(s) by call number.
function play({ votes = {}, final = councilDecision(), owner = decision() } = {}) {
  return (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return askOnce(c);
    if (c.role === 'advisor' && c.n === 1) {
      c.write(cbrief());
      return c.answer(owner); // used only if the question reaches the owner
    }
    if (c.role === 'advisor') return typeof final === 'function' ? final(c) : c.write(final);
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
  const final = h.prompts.find((x) => x.role === 'advisor' && x.n === 2).text;
  assert.match(final, /Both members chose option 1, "B: fix both"[\s\S]*- keep the old fixture/);
  assert.match(p.read('decisions.md'), /## D1 · .* · S1 · Fix the weight bug\n\nThe advisory council decided: fix the weight bug completely\.\n\n\*\*Decided by the council\*\* \(both members chose this option independently; council1 low, council2 low; class A; easy to reverse\)\. A later owner decision may overrule this one\.\n$/);
  assert.match(h.prompts.find((x) => x.role === 'implementer' && x.n === 2).text, /^Council decision D1 .*\n\nFix both\./);
  const reviewer = h.prompts.find((x) => x.role === 'reviewer');
  assert.match(reviewer.assignment() + reviewer.text, /Council decision D1 .*Check both fixes\./s);
  const types = p.events().map((e) => e.type);
  assert.ok(types.includes('council_decision') && !types.includes('operator_wait_start') && !types.includes('owner_decision'));
  assert.equal(p.events().filter((e) => e.type === 'council_vote').length, 2);
  assert.match(h.output, /Decided by the advisory council[^\n]*\n[^\n]*D1 \(S1\): Fix the weight bug/);
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
    if (c.role === 'advisor') return c.write(councilDecision());
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

test('the advisor\'s record of a council decision must match the chosen option, else the owner is asked in the worker\'s tab', () => {
  for (const [bad, why] of [
    [councilDecision({ slice: { title: 'Extra step', acceptance: ['x'] } }), /adds a prerequisite slice the chosen option does not have/],
    [{ status: 'blocked', summary: 'the two conditions contradict' }, /the advisor could not write it: the two conditions contradict/],
  ]) {
    const p = project();
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'advisor' && c.n >= 2) {
        // The fallback waits for the owner in the worker's tab: the owner answers by the worker rewriting its result.
        const worker = h.prompts.find((x) => x.role === 'implementer');
        c.later(() => writeResult(worker.resultPath, done('answered in the tab'), { after: worker.resultPath }));
      }
      return play({ final: bad })(c);
    });
    assert.equal(h.run(), 0);
    assert.match(p.log(), new RegExp(`advisor unavailable \\(.*${why.source}`));
    assert.ok(!fs.existsSync(p.file('decisions.md')), 'nothing is recorded');
    if (bad.status === 'done') assert.match(h.prompts.find((x) => x.role === 'advisor' && x.n === 3).text, /is not acceptable: the decision adds a prerequisite slice/);
  }
});

test('a council decision may insert a prerequisite slice when the chosen option proposes one', () => {
  const p = project();
  const slice = { title: 'Make the fixture', acceptance: ['fixture.txt exists'] };
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'advisor' && c.n === 1) return c.write(cbrief({}, [{ ...OPTIONS[0], slice }, OPTIONS[1]]));
    if (c.role === 'advisor') { assert.match(c.text, /and the prerequisite slice of this option/); return c.write(councilDecision({ slice })); }
    return play()(c);
  });
  assert.equal(h.run(), 0);
  assert.match(p.read('plan.md'), /## S0: Make the fixture\n[\s\S]*inserted by pi-relay from council decision D1\./);
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
