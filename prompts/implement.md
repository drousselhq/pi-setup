---
description: Implement requested work or address review findings, then record evidence.
argument-hint: "[implementation or fix request, or relay assignment]"
---
# Implement the requested work

Implement the requested change, continue it, or repair review findings. Use the `agent-work`
skill for topic and artifact conventions. If the request names a relay assignment file, read it
first: it fixes the slice, acceptance, Git rules, paths and the result file you must write before
stopping. Follow the project's own instructions (AGENTS.md, CONTRIBUTING.md) for engineering rules.

## Work

- Start from the request, the slice acceptance, any design for this slice, and the actual code.
  Preserve unrelated and pre-existing changes.
- Find the focused build/test command early. Build a small end-to-end piece first and compile or
  run it through the real entry point before you expand it. Fix what that check exposes first.
- Make the smallest coherent change. Extend existing mechanisms. No speculative features,
  unrelated refactors or new test infrastructure without a concrete need.
- Add meaningful behavior and regression tests for the changed risk. Respect the project's coverage
  and file-size rules without padding.
- Before reporting done, check user-facing behavior through the path the user actually uses (real
  app and native input, real command, real file). Tests and stand-ins (DOM events, WebDriver, mocks)
  do not replace that check; if the real path is unavailable, record it as unverified.
- A check you add or change (comparison, gate, coverage rule) must fail, not skip or pass, on a
  missing or unavailable input. Show that it can fail.
- Run focused checks while working. The project's full verification runs once at the end of the
  work (in relay mode it is a separate final step), not after every slice.
- Update documentation directly affected by the change. When you remove, rename or change a fact,
  find its references with at least two different searches and update each one.
- When stuck on a real design question, request architecture help (`needs-architecture` in relay
  mode) with one precise question. Ask for a scout (`needs-scout`) only for a large unknown area.
  For a product/scope decision or a missing permission, use `needs-decision` / `blocked`.
- Stop when the acceptance conditions are met and checks pass. Do not start an improvement pass.

## Review repairs

Verify each blocking finding before changing code, reproducing it as the reviewer did; confirm the
fix the same way and fix what the finding describes, not only its reproduction. Fix the valid ones. If you disagree, explain
with evidence in your artifact rather than changing code. Keep finding IDs. Do not fix non-blocking
findings unless they are trivial and inside the slice.

## Artifact

Update the implementation record (path from the assignment, else
`.agents_work/<topic>/implementation.md`): what now works, important paths/symbols, deviations
and why, checks run with results, commits, and for repairs the disposition of each finding ID.
Keep it current; replace superseded text instead of appending another version.

In chat (or the result summary), state the outcome, checks and any blocker.

<operator_request>
$ARGUMENTS
</operator_request>
