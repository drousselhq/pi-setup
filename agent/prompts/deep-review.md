---
description: In-depth, read-only quality assessment of a change set (correctness, maintainability, legibility, test design) for the owner to read.
argument-hint: "[candidate (commit range, branch or paths), context, high-risk areas, planned follow-up]"
---
# Deep review of a change set

Assess in depth whether the specified change set is correct, legible and maintainable enough to
build on. Correctness comes first; maintainability, legibility and test design follow, and each counts.
Do not modify product code, tests, documentation or configuration. Use the `agent-work` skill's
rules for the topic folder and existing artifacts.

This is a thorough assessment you run on request, not the acceptance check: `/review` decides whether
specified work meets its acceptance, and this report does not replace its acceptance trace or
verdict. Use `/architecture-health-review` for friction accumulated in
the existing system without a candidate change, and `/architecture` to design a requested change.
Follow interacting code only as far as needed to establish the candidate's consequences; unrelated
pre-existing debt is out of scope.

Treat authors' notes, plans, earlier reviews and agent records as leads to verify, not as truth. If
you contributed to the candidate, say that this is self-review rather than an independent review.

## Establish the candidate and intent

- Read the project's own instructions and standards first (AGENTS.md, CONTRIBUTING.md, README,
  decision records, lint configuration). They override the general guidance here.
- Identify exactly what you review: a commit range, uncommitted changes, or both, and the base.
  Exclude pre-existing unrelated changes. State the candidate in your report.
- Establish the intent from the request, handoff, specifications, plans, `decisions.md` or commit
  messages. Approved behaviour changes are not defects, but must be implemented as decided.
- Determine missing details from the repository where you can and state what you assumed. Ask when
  the candidate, base, intent or authority remains materially ambiguous; do not give a verdict
  against an unresolved assumption.

## Correctness and risk

- Trace the changed behaviour end to end through callers, callees, shared state, effects, error
  paths, persistence, public interfaces, tests and documentation. Give extra scrutiny to the
  high-risk areas the request names, or find them yourself (concurrency, security boundaries,
  persistence formats, public APIs, lifecycle).
- Look for: contract mismatches including edge cases, limits and error statuses; invalid state
  transitions, leaked or stale resources, cleanup on failure; races (name the exact interleaving)
  and deadlocks; swallowed errors, misleading statuses, partial updates; compatibility of APIs,
  data and configuration; input validation, secrets and permissions where relevant; performance
  only where a requirement exists or the regression is obvious; documentation that disagrees with
  the code or claims more than it establishes.
- Try to reproduce suspicious behaviour; a small failing reproduction is the strongest evidence.

## Maintainability and legibility

Read the changed code as a competent developer new to the project would, without the authors' notes
or chat history; read code before its documentation, then ask whether the documentation was needed.
For each significant changed module, check:

- **Intent from the surface:** names, signatures and short docs tell what it is for; domain terms
  are used consistently, without synonyms or abbreviations hiding one concept.
- **Followable control flow:** function length, nesting, flags or modes threaded through one
  function, boolean or positional parameters whose meaning is invisible at the call site.
- **Meaningful structure:** states, invariants and allowed transitions expressed in types and
  structure rather than scattered across conditionals and comments.
- **Comments** explain why, not what; flag stale or contradictory ones, undecodable ticket or
  document codes, and code intelligible only through a comment that names or types could replace.
- **Cohesion and abstraction fit:** modules split along real concepts, not sliced to meet a size
  limit; each new interface, generic, mode or layer serves a current need; nothing clever where
  plain code would do.
- **Leftovers:** new duplication, dead or retired code, blanket lint suppressions, TODO residue.

Cite `path:line` examples where a concrete problem exists, with a sketch of the clearer version.

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
  private tests (for example of invariants a behaviour test cannot reach); behaviour tests
  complement them.

## Rules of engagement

- Write only your report and useful evidence under the topic's `evidence/` directory. Do not
  commit, push, merge or publish.
- You may run local builds, focused tests, linters and the project's documented checks when they
  add confidence. Do not deploy, install, sign, spend money, touch shared or remote systems, or use
  permissions you were not given. Record every command with its outcome; never report a check as
  run unless you ran it.
- Anchor claims to paths, lines and symbols. Distinguish what you ran, inspected and inferred.

## Findings

A finding is **blocking** (fix it before building on the change) only if it violates a requirement (specification, decision record,
project rule, approved intent) or has a concrete, credible material consequence. A maintainability
finding is blocking when its consequence is concrete: a planned change would incur material,
avoidable test-rewrite cost for unchanged obligations and decoupling would preserve regression
power, a rule lives only in a comment and the next edit will break it silently, or a reader cannot
tell which code path is live. Taste alone is never blocking. A few useful findings beat a long list.

Group findings as confirmed defects, required test gaps, unverified risks and optional
improvements. For each: ID (`DR-n`), severity, confidence, blocking or not; evidence (paths, lines,
reproduction); the scenario and its consequence, technically and in terms a non-specialist owner
would notice (users, data, operations); the requirement violated, if any; the recommended fix with
its tradeoffs (when it is larger than the smallest complete fix, give both); and the check that
would prove it.

## Report

Unless the request gives a path or asks for chat-only, write `.agents_work/<topic>/deep-review.md`.
Do not overwrite `review.md`, unrelated work or an unexpected existing report; resolve the conflict
or ask. Keep depth proportionate to the candidate and its risks. Result first:

1. **Verdict:** one paragraph. Is the change correct, legible and maintainable enough to build on? Blocking findings by ID. Candidate, intent, and whether this is self-review.
2. **Findings**, grouped as above.
3. **Maintainability and legibility:** a short verdict per significant module;
   the coupling probe results (refactor considered, predicted or observed test impact, evidence);
   whether a new developer could take the code over, and the evidence-backed changes that would most
   help, if any.
4. **Readiness for planned follow-up work**, if the request or repository names any: what to resolve
   first, including tests to decouple so that they can serve as a safety net.
5. **What is sound** and should be preserved (brief).
6. **Coverage and limits:** what you traced, sampled and did not assess; commands run with their
   outcome; what you could not verify.

In chat, give the report path (or say it is inline), the verdict, the blocking IDs and a one-line
maintainability judgement.

<operator_request>
$ARGUMENTS
</operator_request>
