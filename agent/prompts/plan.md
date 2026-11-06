---
description: Break an agreed handoff into small, verifiable slices in plan.md.
argument-hint: "[handoff path, topic, or relay assignment]"
---
# Plan the slices

Turn the agreed handoff into an ordered list of small slices that workers can finish one at a
time. Do not implement anything. Use the `agent-work` skill for topic and artifact conventions.
If the request names a relay assignment file, read it first: it fixes paths, rules and the
result file you must write before stopping.

## Work

- Read the handoff, the project's instructions (AGENTS.md, CONTRIBUTING.md or equivalent) and
  only the source needed to size and order the work. Do not do a full architecture exercise.
- Each slice is one coherent, testable outcome. It should be small enough for one implementer
  session, normally a few hours of agent work and a reviewable diff. When unsure, make two slices.
- Put an early end-to-end slice first: something that compiles and runs through the real entry
  point. Then extend. Do not plan component polish ahead of the first integrated result.
- Give every slice observable acceptance conditions taken from the handoff. Do not add
  requirements the handoff does not contain. Put useful extras in a final "Not planned" note.
- When the handoff requires something reviewed or approved before implementation (a protocol, a
  contract, a test plan), make it its own slice ahead of the work it gates; that slice's review is
  the prior review. Never put a "reviewed before" condition in the same slice as the work.
- Producing evidence at scale is implementation work: collecting or running sessions, transcribing
  or reading many images or documents, building reference data. Give it to a slice's implementer;
  never leave it to a review step, which checks work and is not sized to produce it. When the
  handoff or a decision requires independent work (a second reading compared with a first, a
  worker that must not see some material), make each such part, and any comparison of them, its
  own slice, with a `Notes:` line naming what it may read and where its output goes. Each slice
  starts new workers; the relay cannot start a separate session within a step.
- Mark `Needs: architecture` only when the slice has a consequential design choice that the
  handoff and existing code do not settle (ownership, data format, concurrency, public contract).
  Mark `Needs: scout` only when the implementer would otherwise have to explore a large unknown
  area. Mark `Needs: acceptance` when the slice changes a consequential observable contract
  (product behaviour, a comparator or verifier, a parser or format, or behaviour it must preserve
  at real regression risk) and its tests can bind to something stable: an existing entry point or
  test harness, or interfaces settled by `Needs: architecture` in the same slice. Its acceptance
  tests are then written from the requirement sources before implementation. Not for
  documentation, pure refactors or work without an executable contract. The handoff can require
  it. Most slices need none of these.
- The relay adds a final full-suite verification after the last slice; do not plan it as a slice.
  Standalone, note in the plan (outside the slices) that the full verification runs after the
  last slice.
- If the handoff leaves a product decision open that changes the slices, ask it (status
  `needs-decision` in relay mode) instead of guessing.

## Artifact: `.agents_work/<topic>/plan.md`

Write it in the relay plan format, which a script parses: in relay mode your assignment gives it;
otherwise read it in the "plan.md format" section of `~/.pi/agent/relay/README.md`. Put useful
extras in its "Not planned" section. Keep it short.

In chat (or the result summary), give the slice count, the first integrated outcome and any open decision.

<operator_request>
$ARGUMENTS
</operator_request>
