// The advisor's decide-rather-than-defer rules: recommendation first, deferrals with their content.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeHerdr, brief, decision, makeProject, standard } from './harness.mjs';

const ONE = '# Plan\n\n## S1: Only\nNeeds: none\nAcceptance:\n- x\n';
const askOnce = (c) => c.write({
  status: 'needs-decision', summary: 'a choice', question: 'A or B?',
  options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b' }], recommended: 1, reason: 'r',
});

const DEFER = { missing: 'the timing of the real data', source: 'the S3 benchmark, which measures it', decisionPoint: 'end of S3', interim: 'keep the old path' };

test('a deferral option shows its content, and a chosen deferral is recorded with it', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return askOnce(c);
    if (c.role === 'advisor') {
      assert.match(c.assignment(), /earlier deferrals of the same question/);
      assert.match(c.assignment(), /project's own instructions .* take precedence/s);
      c.write(brief({ options: [{ label: 'Decide after the benchmark', consequence: 'wait', deferral: DEFER }, { label: 'Use B now', consequence: 'b' }] }));
      return c.answer(decision({ title: 'Wait for the benchmark', decision: 'Postponed until S3 ends.', deferral: DEFER }));
    }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.match(h.output, /\u2605.* 1\. Decide after the benchmark[^\n]*\n[^\n]*Missing information: the timing of the real data\n[^\n]*Expected from: the S3 benchmark[^\n]*\n[^\n]*Decided at: end of S3\n[^\n]*Until then: keep the old path\n[^\n]*2\. Use B now/);
  assert.match(p.read('decisions.md'), /## D1 · .* · S1 · Wait for the benchmark\n\nPostponed until S3 ends\.\n\n\*\*Deferred\.\*\*\n- Missing information: the timing of the real data\n- Expected from: the S3 benchmark, which measures it\n- Decided at: end of S3\n- Until then: keep the old path\n$/);
});

test('a deferral without its content, or a recommendation not listed first, makes the advisor rewrite the brief', () => {
  for (const [bad, why] of [
    [{ options: [{ label: 'Defer for now', consequence: 'later' }, { label: 'B', consequence: 'b' }] }, /Option 1 postpones the decision but does not state its "deferral"/],
    [{ options: [{ label: 'A', consequence: 'a' }, { label: 'Wait', consequence: 'w', deferral: { ...DEFER, decisionPoint: ' ' } }] }, /Option 2 postpones/],
    [{ recommended: 2 }, /list the recommended option first/],
  ]) {
    const p = makeProject({ plan: ONE });
    const h = new FakeHerdr(p, (c) => {
      if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return askOnce(c);
      if (c.role === 'advisor' && c.n === 1) return c.write(brief(bad));
      if (c.role === 'advisor' && c.n === 2) {
        assert.match(c.text, why);
        c.write(brief({ options: [{ label: 'Use B now', consequence: 'b' }, { label: 'Decide after the benchmark', consequence: 'w', deferral: DEFER }] }));
        return c.answer(decision());
      }
      return standard(c);
    });
    assert.equal(h.run(), 0);
    assert.match(p.read('decisions.md'), /## D1 .*\n\nThe owner chose A\.\n$/);
    assert.ok(!/advisor unavailable/.test(p.log()));
  }
});

test('a recorded deferral missing an item is rewritten by the advisor', () => {
  const p = makeProject({ plan: ONE });
  const h = new FakeHerdr(p, (c) => {
    if (c.role === 'implementer' && c.slice === 'S1' && c.n === 1) return askOnce(c);
    if (c.role === 'advisor' && c.n === 1) { c.write(brief()); return c.answer(decision({ deferral: { missing: 'x' } })); }
    if (c.role === 'advisor' && c.n === 2) { assert.match(c.text, /the deferral with all four fields/); return c.write(decision({ deferral: DEFER })); }
    return standard(c);
  });
  assert.equal(h.run(), 0);
  assert.match(p.read('decisions.md'), /- Decided at: end of S3\n/);
});
