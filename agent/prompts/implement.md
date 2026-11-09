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
- When a materially better approach seems ruled out (a new dependency, network access, a contract
  change), check what the project rules and handoff actually require. If they allow it under
  conditions, meet them and record it. If it needs approval you lack, ask (`needs-decision` in
  relay mode) before building a workaround. Never pick the worse approach silently.
- Add meaningful behavior and regression tests for the changed risk. Respect the project's coverage
  and file-size rules without padding.
- When acceptance tests were written for this work before implementation (an acceptance record
  names them), they express the requirement. Adapt their binding (names, signatures, fixture paths)
  to the real interface where needed and record each change; never change an expected result to
  make it pass. If you believe one is wrong, explain why in your record, citing the requirement
  source; changing what acceptance requires needs the authority it always needs. Record, per
  acceptance test, its first result once bound: passed; failed and revealed a defect you then fixed;
  judged wrong; or environment unavailable.
- Weakening a verification gate, meaning anything that makes it check less than before (loosening
  a threshold, limit, tolerance or coverage floor; excluding, removing or moving code, tests or cases
  out of its reach or to a weaker level; skipping a check, making it optional or replacing it with a
  weaker one), needs approval (`needs-decision` in relay mode) unless the request, handoff, slice or
  a recorded decision authorises it, whatever the reason for it. Putting genuinely new code or tests
  under the existing requirements, keeping them across a path change, or tightening a gate needs no
  approval unless the project's rules say otherwise. Judge each affected requirement separately: an
  addition or a tightening never offsets a weakening.
- Before reporting done, check user-facing behavior through the path the user actually uses (real
  app and native input, real command, real file). Tests and stand-ins (DOM events, WebDriver, mocks)
  do not replace that check; if the real path is unavailable, record it as unverified.
- Run focused checks while working. The project's full verification runs once at the end of the
  work (in relay mode it is a separate final step), not after every slice, unless the project's
  own instructions require it earlier (for example before every hand-back).
- Update documentation directly affected by the change. When you remove, rename or change a fact,
  find its references with at least two different searches and update each one.
- When stuck on a real design question, request architecture help (`needs-architecture` in relay
  mode) with one precise question. Ask for a scout (`needs-scout`) only for a large unknown area.
  For anything the owner's word can settle (a product or scope decision, a permission, a choice), use
  `needs-decision`; `blocked` only for what it cannot (a broken tool, missing access), saying what must be fixed.
- When distinct work with its own outcome must come first, stop before writing code for it and ask
  (`needs-decision`) with an option that proposes it as a prerequisite slice (see the result format).
- Stop when the acceptance conditions are met and checks pass. Do not start an improvement pass.

## Before reporting done

Review your own diff as an independent reviewer would, and fix what you find:

- For every check, comparison, parser, gate or tool you added or changed, establish how it handles
  bad input (empty, duplicated, missing or extra entries, a failed or crashed subprocess, an unknown
  option, a malformed value), and test it where existing evidence does not already show it. It must
  reject the input visibly or recover as the contract specifies (a fallback or default the contract
  does not name is a silent pass); it must never skip or report success on input it could not
  process. Keep as tests the cases that guard a real obligation.
- Where the slice or handoff lists the paths the work may touch, compare the files you changed
  with them. A change outside them needs an owner permission you can cite (`decisions.md`, the handoff, the
  slice or the request); otherwise ask (`needs-decision` in relay mode) rather than keep it.
- Check the project's rules for new code (for example required tests, coverage or file size).
- Trace each acceptance clause to evidence. A clause covered only in part (some cases, some platforms,
  one mode) is not met.

Record this self-check briefly in your artifact.

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
