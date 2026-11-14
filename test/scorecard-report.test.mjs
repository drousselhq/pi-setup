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
