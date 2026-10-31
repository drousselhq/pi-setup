---
description: Independently review implemented work in depth (correctness, maintainability, legibility, test design), or re-review its repairs, without modifying it.
argument-hint: "[work to review, or relay assignment; context and high-risk areas]"
---
# Review the implementation

Review the specified change set against its acceptance and the project's contracts. Correctness,
maintainability, legibility and test design all count. Do not modify product code, tests,
documentation or configuration. Use the `agent-work` skill for topic and artifact conventions. If
the request names a relay assignment file, read it first: it fixes the candidate, paths and the
result file (including your verdict) you must write before stopping.

This command reviews one change set. Use `/architecture-health-review` for friction accumulated in
the existing system without a candidate change, and `/architecture` to design a requested change.
Follow interacting code only as far as needed to establish the candidate's consequences; unrelated
pre-existing debt is out of scope.

Treat authors' notes, plans, earlier reviews and agent records as leads to verify, not as truth. If
you contributed to the candidate, say that this is self-review rather than an independent review.

## Establish the candidate and intent

- Read the project's own instructions and standards first (AGENTS.md, CONTRIBUTING.md, README,
  decision records, lint configuration). They override the general guidance here.
- Identify exactly what you review: a commit range, uncommitted changes, or both, and the base.
  Exclude pre-existing unrelated changes. State the candidate in your review.
- Establish the intent from the request, slice acceptance, handoff, plans, `decisions.md` or commit
  messages. Approved behaviour changes are not defects, but must be implemented as decided.
- Determine missing details from the repository where you can and state what you assumed. Ask
  (`needs-decision` in relay mode) when the candidate, base, intent or authority remains materially
  ambiguous; do not give a verdict against an unresolved assumption.

## Correctness and risk

- Trace the changed behaviour end to end through callers, callees, shared state, effects, error
  paths, persistence, public interfaces, tests and documentation. Check it against the acceptance,
  the handoff and project rules. Give extra scrutiny to the high-risk areas the request names, or
  find them yourself (concurrency, security boundaries, persistence formats, public APIs, lifecycle).
- Look for: contract mismatches including edge cases, limits and error statuses; invalid state
  transitions, leaked or stale resources, cleanup on failure; races (name the exact interleaving)
  and deadlocks; swallowed errors, misleading statuses, partial updates; compatibility of APIs,
  data and configuration; input validation, secrets and permissions where relevant; performance
  only where a requirement exists or the regression is obvious; documentation that disagrees with
  the code or claims more than it establishes.
- Look for concrete failures: try to reproduce suspicious behaviour; a small failing reproduction is
  the strongest evidence. Check that tests exercise the real boundary.
- Try to break every check, comparison, parser, gate or tool the change adds or modifies: feed it
  bad input (empty, duplicated, missing or extra entries, a failed or crashed subprocess, an unknown
  option, a malformed value) and confirm it fails visibly rather than passing.
- Compare the changed files with the paths the slice and handoff allow. Check the project's rules
  for new code (tests, coverage registration, provenance, file size) against what was added.
- Trace each acceptance clause to evidence. A clause covered only in part (some panes, some cases,
  one mode) is not met.

## Maintainability and legibility

Read the changed code as a competent developer new to the project would, without the authors' notes
or chat history; read code before its documentation. Scale this to the size of the change. For each
significant changed module, check:

- **Intent from the surface:** names, signatures and short docs tell what it is for; domain terms
  are used consistently.
- **Followable control flow:** function length, nesting, flags or modes threaded through one
  function, boolean or positional parameters whose meaning is invisible at the call site.
- **Meaningful structure:** states and invariants expressed in types and structure rather than
  scattered across conditionals and comments.
- **Comments** explain why, not what; flag stale or contradictory ones, undecodable ticket codes,
  and code intelligible only through a comment.
- **Cohesion and abstraction fit:** modules split along real concepts, not sliced to meet a size
  limit; each new interface, generic, mode or layer serves a current need; nothing clever where
  plain code would do.
- **Leftovers:** new duplication, dead code, blanket lint suppressions, TODO residue.

Cite `path:line` examples where informative. Sketch a clearer version only for a concrete problem.

## Test design

Assess the tests added or changed, and the existing tests the change relies on:

- **Behaviour, not structure:** tests exercise observable behaviour through stable interfaces
  (public API, CLI, file formats, outputs, statuses) rather than internals exposed only for tests,
  intermediate state, exact call sequences or mocks mirroring the implementation.
- **Independent expectations:** expected values come from hand derivation, a reference model, a
  specification or reviewed golden data, not from calling the code under test.
- **Regression power:** each important test would fail if the behaviour regressed. Where feasible,
  check that new tests would fail on the base version by reading the base source
  (`git show <base>:<path>`), never by switching, stashing or resetting the working tree.
- **Readability and balance:** names state behaviour and outcome; setup is proportionate; important
  behaviours are not left untested at the interface level nor tested redundantly at many levels.
- **No weakened acceptance:** inspect deleted, skipped or ignored tests, widened tolerances,
  narrowed inputs, regenerated goldens and trivial coverage additions for lost obligations or
  regression power. Distinguish justified updates for approved changes from weakening acceptance
  to pass.
- **Coupling probe:** consider the relevant behaviour-preserving refactors (planned ones first) and
  which tests would break although behaviour is unchanged. This is a source-based prediction unless
  you executed it; label it as predicted or observed and cite the assertions. Finding no coupling is
  a valid result. Coupling alone is not a defect: show that the affected assertion guards an
  unchanged obligation and that decoupling keeps its regression power. Keep justified focused or
  private tests (numerical, lifecycle, independent-oracle checks); behaviour tests complement them.

## Re-review

On re-review, check the repairs and their adjacent risk only. Do not restart a full audit.

## Rules of engagement

- In relay mode, write only the files the assignment authorises, including its required result
  file. Otherwise write only your review record and useful evidence under the topic's `evidence/`
  directory. Do not commit, push, merge or publish.
- You may run local builds, focused tests, linters and the project's documented checks when they
  add confidence; reuse supplied evidence otherwise. Do not deploy, install, sign, spend money,
  touch shared or remote systems, or use permissions you were not given. Record every command with
  its outcome; never report a check as run unless you ran it.
- Anchor claims to paths, lines and symbols. Distinguish what you ran, inspected and inferred.

## Findings

A finding is **blocking** only if it violates the acceptance, the handoff or a project contract,
or has a concrete, credible material consequence. A missing test is blocking when project
coverage/regression rules require it. Such a violation is blocking however small or harmless it
looks: severity describes its impact, it does not make the violation optional. A change outside the
allowed paths is blocking even when it is necessary, unless a recorded decision (`decisions.md`)
authorises it: the remedy is that authority, not the reviewer's acceptance. A maintainability
finding is blocking when its consequence is concrete: a planned change would incur material,
avoidable test-rewrite cost for unchanged obligations and decoupling would preserve regression
power, a rule lives only in a comment and the next edit will break it
silently, or a reader cannot tell which code path is live. Everything else (style, taste, optional
hardening, hypothetical infrastructure, advisory performance) is **non-blocking**. Record those but
never list them as blocking. A few useful findings beat a long list.

Group findings as confirmed defects, required test gaps, unverified risks and optional
improvements. For each: ID (keep existing IDs), severity, confidence, blocking or not; evidence
(paths, lines, reproduction); the scenario and its consequence, also in terms a non-specialist owner
would notice; the requirement violated, if any; the right fix direction (not merely the smallest)
with its tradeoffs; and the check that would prove it. Recommend a direction, not a patch.

Verdict: **accept** when no blocking finding remains; otherwise **changes-required**.

## Artifact

Update the review record (path from the assignment, else `.agents_work/<topic>/review.md`). Update
only the record for this candidate; resolve an unexpected existing report before overwriting it.
Keep depth and reporting proportionate to the candidate and its risks; cover non-applicable
sections in a line. Required acceptance evidence is unchanged. Result first:

1. Candidate, intent, and whether this is self-review.
2. Verdict, with the blocking finding IDs.
3. Open findings, then resolved ones with their dispositions.
4. Acceptance trace: each clause met, partial or unmet, with its evidence; partial or unmet is a
   blocking finding.
5. Maintainability and test design: a short verdict per significant module, the coupling probe
   results, and whether a new developer could take the code over. Name only evidence-backed
   improvements, if any.
6. Readiness for planned follow-up work, if the request or repository names any.
7. What is sound and should be preserved (brief).
8. Coverage and limits: what you traced, sampled and did not assess; commands run with their
   outcome; what you could not verify.

On re-review, update the existing record rather than appending another version; revise only the
assessments and evidence the repairs affect.

In chat (or the result summary), give the verdict, the blocking finding IDs and a one-line
maintainability judgement.

<operator_request>
$ARGUMENTS
</operator_request>
