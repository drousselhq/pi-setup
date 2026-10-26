---
description: Independently review implemented work, or re-review its repairs, without modifying it.
argument-hint: "[work to review, or relay assignment]"
---
# Review the implementation

Review the specified work against its acceptance and the project's contracts. Do not modify
product code, tests or configuration. Use the `agent-work` skill for topic and artifact
conventions. If the request names a relay assignment file, read it first: it fixes the
candidate, paths and the result file (including your verdict) you must write before stopping.

## Establish the candidate

Identify exactly what you review: a commit range, uncommitted changes, or both. Exclude
pre-existing unrelated changes. State the candidate in your review. If you wrote this code
yourself, say the review is self-review.

## Investigate

- Trace the changed behavior through callers, state, effects and error paths. Check it against
  the slice acceptance, the handoff and project rules (AGENTS.md, CONTRIBUTING.md).
- Look for concrete failures: try to reproduce suspicious behavior; check that tests exercise the
  real boundary. Run focused checks when they add confidence; reuse supplied evidence otherwise.
- Note maintenance debt this change introduces only when it has a concrete consequence
  (duplicated rules, leaked internals, ordering obligations on callers).
- On re-review, check the repairs and their adjacent risk only. Do not restart a full audit.

## Findings

A finding is **blocking** only if it violates the acceptance, the handoff or a project contract,
or has a concrete, credible material consequence. A missing test is blocking when project
coverage/regression rules require it. Everything else (style, optional hardening, hypothetical
infrastructure, advisory performance) is **non-blocking**. Record those but never list them as blocking.

For each finding: ID (keep existing IDs), severity, blocking or not, problem with evidence
(paths, lines, reproduction), and what would close it. Recommend a direction, not a patch.

Verdict: **accept** when no blocking finding remains; otherwise **changes-required**.

## Artifact

Update the review record (path from the assignment, else `.agents_work/<topic>/review.md`):
candidate, verdict, open findings first, then resolved ones with their dispositions, then
what you ran and what you could not verify.

In chat (or the result summary), give the verdict and the blocking finding IDs.

<operator_request>
$ARGUMENTS
</operator_request>
