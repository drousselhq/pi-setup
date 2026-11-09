// Waiting on workers: a permission prompt (its screen recorded), a worker interrupted at the compaction limit, and
// the answers the owner types in a worker's tab, recorded once in decisions.md as an unverified excerpt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { FakeHerdr, StopRelay, accept, brief, decision, done, makeProject, standard, writeResult } from './harness.mjs';

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';
const flat = (h) => h.output.replace(/[┃\s]+/g, ' ');
const blocked = (question) => ({ status: 'blocked', summary: 'stuck', question });
const tabAnswers = (p) => (fs.existsSync(p.file('decisions.md')) ? p.read('decisions.md').split(/^(?=## )/m).filter((x) => x.startsWith('## Tab answer')) : []);

test('a permission prompt is recorded with an excerpt of the worker\'s screen', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role !== 'implementer' || c.slice !== 'S1') return standard(c);
    c.status('blocked');
    c.screen('Allow this command?\n  rm -rf build/\n  [y] yes  [n] no');
    // The owner answers the prompt a little later; then the worker finishes.
    return c.later(() => c.later(() => { c.status('idle'); p.commit('s1.txt'); c.write(done()); }));
  });
  assert.equal(h.run(), 0);
  const wait = p.events().find((e) => e.type === 'permission_wait');
  assert.equal(wait.screen, 'Allow this command?\n  rm -rf build/\n  [y] yes  [n] no');
  assert.match(p.log(), /S1 implementer is waiting on a prompt in tab "tt S1 implementer"; screen: Allow this command\? rm -rf build\/ \[y\] yes \[n\] no/);
  assert.match(flat(h), /Its screen \(an excerpt\): Allow this command\? rm -rf build\//);
});

test('a permission prompt while a worker works on the owner\'s answer in its tab is shown and recorded too', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) {
      c.write(blocked('May I start?'));
      return c.later(() => { // the owner answers; the worker then hits a permission prompt; the owner allows it
        c.type('yes');
        c.status('blocked');
        c.screen('Allow execution?\n  rm -rf scratch');
        c.later(() => c.later(() => { c.status('idle'); p.commit('s1.txt'); writeResult(c.resultPath, done(), { after: c.resultPath }); })); // still blocked at the next look
      });
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  const wait = p.events().find((e) => e.type === 'permission_wait');
  assert.equal(wait?.screen, 'Allow execution?\n  rm -rf scratch');
  assert.match(p.log(), /S1 implementer is waiting on a prompt in tab "tt S1 implementer"; screen: Allow execution\? rm -rf scratch/);
});

test('a worker still working at the compaction limit is interrupted', () => {
  const p = makeProject({ plan: ONE, config: { escalation: { enabled: false } } });
  const h = new FakeHerdr(p, (c) => {
    if (c.role !== 'reviewer') return standard(c);
    c.status('working'); // it keeps working, compacting
    fs.appendFileSync(c.session, '{"type":"compaction"}\n{"type":"compaction"}\n');
    return undefined;
  });
  assert.equal(h.run(), 2);
  const runaway = p.events().find((e) => e.type === 'runaway');
  assert.deepEqual([runaway.role, runaway.interrupted], ['reviewer', true]);
});

test('what the owner types in a blocked worker\'s tab is recorded once, as an unverified excerpt', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n === 1) {
      c.write(blocked('May I read the b files under testdata/?'));
      return c.later(() => { c.type('Yes, you may read them; write nothing there.'); writeResult(c.resultPath, accept(), { after: c.resultPath }); });
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  const [record, ...more] = tabAnswers(p);
  assert.equal(more.length, 0);
  assert.match(record, /^## Tab answer · \d{4}-\d\d-\d\d · S1 · reviewer · \d+-reviewer-review\.result\.json#1\n\nQuestion: May I read the b files under testdata\/\?\n\nTyped in the reviewer's tab while it waited \(an unverified excerpt of its session, not a decision brief: Pi does not record who typed a message\):\n\n> Yes, you may read them; write nothing there\.\n/);
  assert.doesNotMatch(record, /Read and execute the relay assignment/, 'the relay\'s own prompt is outside the window');
});

test('two questions on the same result file are two windows; a relay correction after an invalid answer is left out', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n === 1) {
      c.write(blocked('First question?'));
      return c.later(() => {
        c.type('first answer');
        writeResult(c.resultPath, blocked('Second question?'), { after: c.resultPath });
        c.later(() => { c.type('second answer'); writeResult(c.resultPath, '{"status": "done",', { after: c.resultPath }); }); // invalid
      });
    }
    if (c.role === 'reviewer') return c.write(accept()); // after the relay's correction
    return standard(c);
  });
  assert.equal(h.run(), 0);
  const records = tabAnswers(p);
  assert.equal(records.length, 2);
  assert.match(records[0], /#1\n\nQuestion: First question\?[\s\S]*> first answer\n\n?$/); // records are separated by a blank line
  assert.match(records[1], /#2\n\nQuestion: Second question\?[\s\S]*> second answer\n$/);
  assert.doesNotMatch(records.join(''), /Your result file is invalid/);
});

test('a wait the relay started after a missing result is labelled as the relay\'s question', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return undefined;
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 2) { // ignores the reminder too; the owner talks to it
      return c.later(() => { c.type('please finish the slice'); p.commit('s1.txt'); writeResult(c.resultPath, done()); });
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  const [record] = tabAnswers(p);
  assert.match(record, /Question: asked by the relay: Worker stopped without a valid result file\.[\s\S]*> please finish the slice/);
  assert.doesNotMatch(record, /You stopped without writing the result file/, 'the relay\'s reminder is outside the window');
});

test('a restart during the relay\'s own wait records what was typed until then; its next reminder is outside any window', () => {
  const p = makeProject({ plan: ONE });
  let stopped = false;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && !stopped) { // ignores its step and the reminder; the owner types, then stops the relay
      if (c.n === 2) c.later(() => { c.type('take your time'); stopped = true; throw new StopRelay('Ctrl-C'); });
      return undefined;
    }
    return standard(c);
  });
  assert.equal(h.run(), 1);
  assert.equal(h.run(), 0, 'the restart reminds the reviewer again, which then accepts');
  const records = tabAnswers(p);
  assert.equal(records.length, 1);
  assert.match(records[0], /asked by the relay: Worker stopped without a valid result file\.[\s\S]*> take your time/);
  assert.doesNotMatch(records.join(''), /You stopped without writing the result file/);
});

test('a restart while the worker works on what the owner typed keeps the window open until its next result', () => {
  const p = makeProject({ plan: ONE });
  let stopped = false;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && !stopped && c.n === 2) { // ignored its step and now the reminder; the owner talks to it
      return c.later(() => {
        c.type('Read the fixture.');
        c.status('working');
        stopped = true;
        c.later(() => { throw new StopRelay('Ctrl-C'); });
      });
    }
    if (c.role === 'reviewer' && !stopped) return undefined;
    return standard(c);
  });
  assert.equal(h.run(), 1);
  // After the restart the reviewer is still working; the owner adds an instruction, then it accepts.
  const reviewer = [...h.agents.values()].find((a) => a.role === 'reviewer' && a.alive);
  h.pending.push(() => {
    fs.appendFileSync(reviewer.session, `${JSON.stringify({ type: 'message', timestamp: new Date(Date.now()).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'Do not modify the fixture.' }] } })}\n`);
    reviewer.status = 'idle';
    const pending = p.state().cur.pending;
    writeResult(pending.resultPath, accept(), { after: pending.resultPath });
  });
  assert.equal(h.run(), 0);
  const records = tabAnswers(p);
  assert.equal(records.length, 1);
  assert.match(records[0], /> Read the fixture\.\n> Do not modify the fixture\./);
});

test('a session that branched while the worker waited is not read as an answer', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n === 1) {
      c.write(blocked('Delete the old fixture?'));
      return c.later(() => {
        const at = new Date(Date.now()).toISOString();
        for (const [id, text] of [['a1', 'Yes, delete it.'], ['b1', 'No, keep it.']]) { // two branches from the same entry
          fs.appendFileSync(c.session, `${JSON.stringify({ type: 'message', id, parentId: 'root7', timestamp: at, message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
        }
        writeResult(c.resultPath, accept(), { after: c.resultPath });
      });
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.match(tabAnswers(p)[0], /> \(answer not readable; see the tab\)/);
  assert.doesNotMatch(tabAnswers(p)[0], /delete it|keep it/);
});

test('during the relay\'s own wait, an unreadable or branched session is recorded as not readable; nothing typed is not recorded', () => {
  for (const what of ['branched', 'nothing']) {
    const p = makeProject({ plan: ONE });
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'reviewer' && c.n === 1) return undefined; // no result; nor after the reminder
      if (c.role === 'reviewer' && c.n === 2) {
        return c.later(() => {
          if (what === 'branched') {
            const at = new Date(Date.now()).toISOString();
            for (const [id, text] of [['a1', 'Delete the fixture.'], ['b1', 'Keep the fixture.']]) {
              fs.appendFileSync(c.session, `${JSON.stringify({ type: 'message', id, parentId: 'root7', timestamp: at, message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
            }
          }
          writeResult(c.resultPath, accept());
        });
      }
      return standard(c);
    });
    assert.equal(h.run(), 0);
    const records = tabAnswers(p);
    if (what === 'branched') assert.match(records[0] ?? '', /asked by the relay[\s\S]*> \(answer not readable; see the tab\)/);
    else assert.equal(records.length, 0);
  }
});

test('a council member\'s permission prompt is shown with its screen, logged and recorded', () => {
  const ROLES = Object.fromEntries(['planner', 'scout', 'architect', 'implementer', 'senior', 'reviewer', 'advisor', 'council1', 'council2'].map((r) => [r, { model: `test/${r}`, thinking: 'low' }]));
  const p = makeProject({ plan: ONE, config: { roles: ROLES, council: { enabled: true, members: ['council1', 'council2'] } } });
  const options = [{ label: 'B', consequence: 'b', action: 'Do B.', classes: ['A'] }, { label: 'A', consequence: 'a', action: 'Do A.', classes: ['A'] }];
  const vote = { status: 'done', choice: 'X1', conditions: [], classes: ['A'], ownerNeeded: null, confidence: 'high', reversibility: 'easy', reasons: 'r', objection: 'o', ownerSummary: 's' };
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) {
      return c.write({ status: 'needs-decision', summary: 's', question: 'A or B?', options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b' }], recommended: 1, reason: 'r' });
    }
    if (c.role === 'advisor') return c.write(brief({ options, ownerNeeded: null }));
    if (c.role === 'council1') { c.status('blocked'); c.screen('Allow reading ~/.ssh?'); return c.later(() => { c.status('idle'); c.write(vote); }); }
    if (c.role === 'council2') return c.write(vote);
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.ok(p.events().some((e) => e.type === 'permission_wait' && e.role === 'council1' && e.screen === 'Allow reading ~/.ssh?'));
  assert.match(p.log(), /council1 is waiting on a prompt in tab "tt S1 council1"; screen: Allow reading ~\/\.ssh\?/);
  assert.match(flat(h), /council1 is waiting on a prompt .*Its screen \(an excerpt\): Allow reading ~\/\.ssh\?/);
});

test('an unreadable session records the question with a pointer to the tab; the advisor\'s own wait records nothing', () => {
  let p = makeProject({ plan: ONE });
  let h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n === 1) {
      c.write(blocked('Which fixture?'));
      return c.later(() => { fs.rmSync(c.session); writeResult(c.resultPath, accept(), { after: c.resultPath }); });
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.match(tabAnswers(p)[0], /Question: Which fixture\?[\s\S]*> \(answer not readable; see the tab\)/);
  p = makeProject({ plan: ONE });
  h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) {
      return c.write({ status: 'needs-decision', summary: 's', question: 'A or B?', options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b' }], recommended: 1, reason: 'r' });
    }
    if (c.role === 'advisor') { c.write(brief()); return c.answer(decision()); }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.equal(tabAnswers(p).length, 0, 'the owner\'s answer to the advisor is the decision, not a tab answer');
});

test('a kill after a tab answer was written, before its mark was saved, does not record it twice', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'reviewer' && c.n === 1) {
      c.write(blocked('May I?'));
      return c.later(() => { c.type('yes'); writeResult(c.resultPath, accept(), { after: c.resultPath }); });
    }
    return standard(c);
  });
  // Killed just after decisions.md got the record: every later write and io call fails.
  const real = Object.fromEntries(['writeFileSync', 'appendFileSync', 'renameSync'].map((n) => [n, fs[n]]));
  let dead = false;
  for (const n of Object.keys(real)) fs[n] = (...args) => { if (dead) throw new StopRelay('killed'); return real[n](...args); };
  fs.renameSync = (from, to) => {
    if (dead) throw new StopRelay('killed');
    real.renameSync(from, to);
    if (String(to).endsWith('/decisions.md')) dead = true;
  };
  const base = h.io();
  h.ioExtra = { herdr: (a) => { if (dead) throw new StopRelay('killed'); return h.handle(a); }, write: (t) => { if (!dead) base.write(t); } };
  try { assert.equal(h.run(), 1); } finally { Object.assign(fs, real); h.ioExtra = {}; }
  assert.ok(dead, 'killed');
  assert.equal(tabAnswers(p).length, 1);
  assert.equal(p.state().cur.pending.tabAnswer.recorded, false, 'killed before the mark');
  assert.equal(h.run(), 0);
  assert.equal(tabAnswers(p).length, 1, 'recorded once');
});

test('after the advisor failed and the owner is asked in the worker\'s tab, a restart does not consult the advisor again', () => {
  const p = makeProject({ plan: '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n' });
  let stop = true;
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) {
      return c.write({ status: 'needs-decision', summary: 'a choice', question: 'Which?', options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b' }], recommended: 1, reason: 'r' });
    }
    if (c.role === 'advisor') { // incomplete, twice; then the relay is stopped while it waits for the owner
      if (c.n === 2 && stop) c.later(() => { stop = false; throw new StopRelay('Ctrl-C'); });
      return c.write({ status: 'needs-decision', summary: 'x', brief: { title: 'no question' } });
    }
    return standard(c);
  });
  assert.equal(h.run(), 1);
  const advised = h.prompts.filter((c) => c.role === 'advisor').length;
  const worker = h.prompts.find((c) => c.role === 'implementer');
  h.pending.push(() => writeResult(worker.resultPath, done('answered in the tab'), { after: worker.resultPath }));
  assert.equal(h.run(), 0);
  assert.equal(h.prompts.filter((c) => c.role === 'advisor').length, advised, 'the advisor is not asked again');
});
