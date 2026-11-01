---
description: Independently check that implemented work meets its acceptance and the project's contracts, or re-review its repairs, without modifying it.
argument-hint: "[work to review, or relay assignment]"
---
# Review the implementation

Review the specified work against its acceptance and the project's contracts. Do not modify
product code, tests, documentation or configuration. Use the `agent-work` skill for topic and
artifact conventions. If the request names a relay assignment file, read it first: it fixes the
candidate, paths and the result file (including your verdict) you must write before stopping.

This is the acceptance check of one change set: is it done and correct? For an in-depth assessment
of its correctness, legibility, maintainability and test design, use `/deep-review`. Use
`/architecture-health-review` for friction accumulated in the existing system, and `/architecture`
to design a requested change.

Treat authors' notes, plans and agent records as leads to verify, not as truth. If you contributed
to the candidate, say that this is self-review rather than an independent review.

## Establish the candidate

- Identify exactly what you review: a commit range, uncommitted changes, or both, and the base. Exclude
  pre-existing unrelated changes. State the candidate in your review.
- Establish the intent from the request, slice acceptance, handoff and `decisions.md`. Approved
  behaviour changes are not defects, but must be implemented as decided. The project's own
  instructions (AGENTS.md, CONTRIBUTING.md) override the general guidance here.
- Ask (`needs-decision` in relay mode) when the candidate, intent or authority remains materially
  ambiguous after looking in the repository; do not give a verdict against an unresolved assumption.

## Investigate

- Trace the changed behaviour through callers, state, effects and error paths. Check it against
  the slice acceptance, the handoff and project rules (AGENTS.md, CONTRIBUTING.md). Look in
  particular for contract mismatches at edges and limits, failure paths that leave partial state or
  leaked resources, races, swallowed errors and misleading statuses, broken compatibility, and
  documentation that disagrees with the code.
- Look for concrete failures: try to reproduce suspicious behaviour; check that tests exercise the
  real boundary. Run focused checks when they add confidence; reuse supplied evidence otherwise.
- For every check, comparison, parser, gate or tool the change adds or modifies, check the evidence
  for its handling of bad input (empty, duplicated, missing or extra entries, a failed or crashed
  subprocess, an unknown option, a malformed value). Probe it yourself where that evidence is
  missing or suspicious. It must reject the input visibly or recover as the contract specifies (a
  fallback or default the contract does not name is a silent pass); skipping or reporting success
  on input it could not process is a blocking finding.
- Where the slice or handoff lists the paths the work may touch, compare the changed files with
  them; do not infer a list that is not written. Check the project's rules for new code (for
  example required tests, coverage or file size) against what was added.
- Check that important new tests would fail if the behaviour regressed, and that no test was
  deleted, skipped or loosened to make the change pass (justified updates for approved changes are
  fine). To compare with the base, read it (`git show <base>:<path>`); never switch, stash or reset
  the working tree.
- Trace each acceptance clause to evidence. A clause covered only in part (some cases, some platforms,
  one mode) is not met.
- Note maintenance debt this change introduces only when it has a concrete consequence
  (duplicated rules, leaked internals, ordering obligations on callers).
- On re-review, check the repairs and their adjacent risk only. Do not restart a full audit.

In relay mode, write only the files the assignment authorises. Otherwise write only your review
record and useful evidence under the topic's `evidence/` directory. Run local builds, tests and
linters only: do not commit, push, merge, publish, deploy, install, sign, spend money, touch shared
or remote systems, or use permissions you were not given. Record the commands you ran with their
outcome; never report a check as run unless you ran it.

## Findings

A finding is **blocking** only if it violates the acceptance, the handoff or a project contract,
or has a concrete, credible material consequence. A missing test is blocking when project
coverage/regression rules require it. Such a violation is blocking however small or harmless it
looks: severity describes its impact, it does not make the violation optional. A change outside the
listed paths is blocking even when it is necessary, unless an explicit owner permission you can cite
authorises it (in relay mode `decisions.md`, the handoff or the slice; otherwise the handoff or the
request you were given): the remedy
is that authority, not the reviewer's acceptance. Everything else (style, optional hardening,
hypothetical infrastructure, advisory performance) is **non-blocking**. Record those but never list
them as blocking.

For each finding: ID (`R<n>`; keep existing IDs), severity, blocking or not, problem with evidence
(paths, lines, reproduction), and what would close it: the smallest complete fix. A larger
improvement you would recommend is a separate non-blocking finding. Recommend a direction, not a
patch.

Verdict: **accept** when no blocking finding remains; otherwise **changes-required**.

## Artifact

Update the review record in place, without appending a second version (path from the assignment,
else `.agents_work/<topic>/review.md`):
candidate (and whether this is self-review), verdict, open findings first, then resolved ones with
their dispositions, an acceptance trace (each clause met, partial or unmet, with its evidence;
partial or unmet is a blocking finding), then what you ran and what you could not verify.

In chat (or the result summary), give the verdict and the blocking finding IDs.

<operator_request>
$ARGUMENTS
</operator_request>
