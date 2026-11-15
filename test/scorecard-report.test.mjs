import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { analyze, main, parseArgs, report } from '../scripts/scorecard.mjs';
import { findTopics } from '../scripts/scorecard/records.mjs';
import { assistant, at, readFake, tmp, topicEvents, writeLines } from './scorecard-fixture.mjs';

function project(events = topicEvents(), name = 'topic-a') {
  const dir = tmp();
  writeLines(path.join(dir, '.agents_work', name, 'relay', 'events.jsonl'), events);
  return dir;
}
const run = (args, events) => main([project(events), ...args], readFake);

test('summary: finished slices only, known counts, coverage of costs, quality not yet read', () => {
  const out = run([]);
  assert.match(out, /^topic-a · 4 finished slices · up to 2026-11-01T10:\d\d:00Z/);
  assert.match(out, /quality {3}not assessed by reading/);
  assert.match(out, /final {5}1 run: verification not recorded/);
  assert.match(out, /first review accepted 1 of 2 known · 1 escalations · 1 findings back after repair \(1 slices\)/);
  assert.match(out, /you {7}1 decisions \(1 of 1 recommended\) · waited 1\.0h · revisits proposed in 1 of 1 briefs/);
  assert.match(out, /cost {6}\$22 recorded \(1 session missing or partial\) · \$9\.00 per finished slice \(2 of 4 fully recorded\)/);
  assert.match(out, /review cycles ~50% of those · checking 28% of all/);
  assert.match(out, /outside {3}other slices, planning and final: 0 decisions by you, 0 by the council · waited 0\.0h · \$0\.50/);
});

test('--since selects slices by completion; --until cuts events and model calls at the date given', () => {
  const since = run(['--since', at(30)]);
  assert.match(since, /^topic-a · 3 finished slices since 2026-11-01T10:30:00Z/);
  assert.match(since, /outside {3}other slices, planning and final: 1 decision by you, 1 by the council · waited 1\.0h/, 'S1 is outside the period');
  const dir = tmp();
  const session = path.join(dir, 's.jsonl');
  writeLines(session, [assistant(3, 1), assistant(10, 2), assistant(20, 4)]);
  const events = [
    { t: at(0), run: 'r', type: 'run_start' }, { t: at(1), run: 'r', slice: 'S1', type: 'slice_start' },
    { t: at(2), run: 'r', slice: 'S1', type: 'agent_start', role: 'implementer', session },
    { t: at(3), run: 'r', slice: 'S1', type: 'step_result', role: 'implementer', purpose: 'implement' },
    { t: at(4), run: 'r', slice: 'S1', type: 'slice_done' },
  ];
  writeLines(path.join(dir, 'relay', 'events.jsonl'), events);
  assert.match(main([dir]), /\$1\.00 recorded/, 'by default the cutoff is the last event');
  const cut = main([dir, '--until', at(12)]);
  assert.match(cut, /up to 2026-11-01T10:12:00Z/);
  assert.match(main([dir, '--until', '2026-11-01T10:12:00.250Z']), /up to 2026-11-01T10:12:00\.250Z/, 'the cutoff keeps its milliseconds');
  assert.match(cut, /\$3\.00 recorded/, 'calls after the last event but before the cutoff count');
  assert.match(cut, /cutoff given: 2026-11-01T10:12:00Z/);
  assert.match(main([dir, '--since', at(5), '--until', at(30)]), /period {4}\$6\.00 spent since/);
});

test('compare: a slice running across the date is left out and named; or by the acceptance step', () => {
  const byDate = run(['--compare', at(31)]);
  assert.match(byDate, /finished before 2026-11-01T10:31:00Z \(1\) versus started after \(2\); left out, running across the date: S2/);
  assert.match(byDate, /\| Owner decisions \| 1 in 1 slices \(1 of 1 recommended\) \| 0 in 2 slices \(recommended: not recorded\) \|/);
  assert.match(run(['--compare', 'acceptance']), /without the acceptance step \(3\) versus with it \(1\)/);
  const period = run(['--since', at(30), '--compare', 'acceptance', '--detail']);
  assert.match(period, /without the acceptance step \(2\) versus with it \(1\)/, '--since applies to the comparison');
  assert.doesNotMatch(period, /\| S1 \| One \|/, 'and to the detail table');
});

test('detail: notes per slice, costs outside slices, the final verification and coverage', () => {
  const out = run(['--detail']);
  assert.match(out, /\| S2 \| Two \|.*2 attempts \(earlier ones \$2\.00\).*tests first; 1 test files changed; partial cost \(implementer: result without its session on record\)/);
  assert.match(out, /\| S1 \|.*nudges 1 missing-result; 1 revisits proposed \|/);
  assert.match(out, /Outside slices: FINAL \$0\.50/);
  assert.match(out, /\| imp1 \| S1 \| implementer \| \$10 \|/);
  assert.match(out, /\| gone3 \| S3 \| implementer \| missing \|/);
  assert.match(out, /Final verification: 1 run: verification not recorded; relay completions recorded: none/);
  assert.match(out, /Models by role: implementer p\/impl-model, reviewer p\/rev-model\. One known installed version for 0 of 4 slices' relay code and 0 of their worker prompts/);
});

test('several topics: a table first; bad input is refused with a clear message', () => {
  const dir = project();
  writeLines(path.join(dir, '.agents_work', 'topic-b', 'relay', 'events.jsonl'), topicEvents());
  const out = main([dir], readFake);
  assert.match(out, /^\| Topic \| From \| Finished/);
  assert.match(out, /\| topic-b \| 2026-11-01 \| 4 \| 0\.50 \| 1\/2 \| 1 \| 1\.0h \| \$9\.00 \| impl-model\/rev-model \|/);
  assert.equal(findTopics([dir]).length, 2);
  assert.match(main([dir, '--since', at(30)], readFake), /\| topic-b \| 2026-11-01 \| 3 \|/, '--since applies to the table');
  assert.throws(() => parseArgs([dir, '--since', 'soon']), /--since needs a date/);
  assert.throws(() => parseArgs(['--detail']), /at least one topic/);
  assert.throws(() => parseArgs([dir, '--colour']), /unknown option --colour/);
  assert.throws(() => findTopics([tmp()]), /not a relay topic/);
  fs.writeFileSync(path.join(dir, '.agents_work', 'topic-b', 'relay', 'events.jsonl'), '{"t":"x"');
  const r = analyze(findTopics([dir])[1], parseArgs([dir]), readFake);
  assert.match(report(r, parseArgs([dir])), /last line incomplete \(ignored\)/);
});

// topic-b: S1 only, its own runs and models, then a final verification that fails with a review finding.
function topicB() {
  const ev = topicEvents();
  const s1 = ev.slice(0, ev.findIndex((e) => e.type === 'slice_done' && e.slice === 'S1') + 1)
    .map((e) => ({ ...e, run: 'rb', ...(e.type === 'run_start' ? { roles: { implementer: { model: 'p/other-impl' }, reviewer: { model: 'p/rev-model' } } } : {}) }));
  const t = (n) => at(s1.length + n);
  return [...s1,
    { t: t(0), run: 'rb', slice: 'FINAL', type: 'agent_start', role: 'implementer', session: 'fin' },
    { t: t(1), run: 'rb', slice: 'FINAL', type: 'step_result', role: 'implementer', purpose: 'final', verification: 'fail' },
    { t: t(2), run: 'rb', slice: 'FINAL', type: 'step_result', role: 'reviewer', purpose: 'review', verdict: 'changes-required', blocking: ['F1'] }];
}

test('several topics: a total row and one summary over all of them; --table keeps only those; empty topics left out', () => {
  const dir = project();
  writeLines(path.join(dir, '.agents_work', 'topic-b', 'relay', 'events.jsonl'), topicB());
  writeLines(path.join(dir, '.agents_work', 'topic-c', 'relay', 'events.jsonl'), topicEvents().slice(0, 4)); // nothing finished
  const out = main([dir], readFake);
  assert.match(out, /\| topic-b \| 2026-11-01 \| 1 \| 2\.00 \| 0\/1 \| 1 \| 1\.0h \| \$18 \| other-impl\/rev-model \|/);
  assert.match(out, /\| all topics \(2\) \| 2026-11-01 \| 5 \| 0\.80 \| 1\/3 \| 2 \| 2\.0h \| \$12 \|/, 'weighted by slice, not a mean of the topics');
  assert.doesNotMatch(out, /\| topic-c \|/);
  assert.match(out, /\(1 topic with no slice finished left out; \$10 spent in them\)/);
  assert.match(out, /\nall topics \(2\) · 5 finished slices · up to 2026-11-01T10:52:00Z/, 'the latest cutoff of the topics');
  assert.match(out, /you {7}2 decisions \(2 of 2 recommended\) · waited 2\.0h/);
  assert.match(out, /final {5}2 runs in 2 of 2 topics: verification not recorded, fail · 1 review with findings/);
  assert.match(out, /cost {6}\$40 recorded \(1 session missing or partial\) · \$12 per finished slice \(3 of 5 fully recorded\) · review cycles ~50% of those · checking 23% of all/);
  assert.match(out, /outside {3}other slices, planning and final: 0 decisions by you, 0 by the council · waited 0\.0h · \$1\.00/, 'topic totals add up');
  assert.match(out, /\ntopic-a · 4 finished slices/, 'each topic follows');
  assert.doesNotMatch(out, /topic-c ·/);
  assert.match(main([dir, '--table', '--since', at(0)], readFake), /period {4}\$40 spent since/);
  assert.match(main([dir, '--table', '--until', at(40)], readFake), /\(cutoff given: 2026-11-01T10:40:00Z\)/);
  const table = main([dir, '--table', '--compare', at(31)], readFake);
  assert.doesNotMatch(table, /\ntopic-a · /, '--table: no summary per topic');
  assert.match(table, /all topics \(2\): finished before .* \(2\) versus started after \(2\); left out, running across the date: topic-a\/S2/);
  assert.match(table, /\| Implementer\/reviewer \| (impl-model\/rev-model, other-impl\/rev-model|other-impl\/rev-model, impl-model\/rev-model) \| impl-model\/rev-model \|/);
  const period = main([dir, '--table', '--since', at(30), '--compare', 'acceptance'], readFake);
  assert.match(period, /all topics \(1\): without the acceptance step \(2\) versus with it \(1\)/, '--since applies to the comparison over all');
  assert.match(period, /\(2 topics with no slice finished in the period left out; \$0\.00 spent in them since/);
  assert.match(main([dir, '--since', at(500)], readFake), /^No topic has a slice finished in the period\.\n\(3 topics/);
  fs.appendFileSync(path.join(dir, '.agents_work', 'topic-c', 'relay', 'events.jsonl'), '{damaged}\n');
  assert.match(main([dir, '--table'], readFake), /\(records: topic-c \(1 unreadable lines\)\)/, 'named even for a topic left out');
  fs.appendFileSync(path.join(dir, '.agents_work', 'topic-a', 'relay', 'events.jsonl'), '{"t":"2026-1');
  assert.match(main([dir, '--table'], readFake), /\(records: topic-a \(0 unreadable lines, last line incomplete\); topic-c \(1 unreadable lines\)\)/,
    'and for a topic shown, with --table');
});

test('topics of the same name in two projects are told apart', () => {
  const [a, b] = [project(topicEvents(), 'same'), project(topicEvents(), 'same')];
  const out = main([a, b, '--table'], readFake);
  assert.match(out, new RegExp(`\\| ${path.basename(a)}/same \\|`));
  assert.match(out, new RegExp(`\\| ${path.basename(b)}/same \\|`));
});
