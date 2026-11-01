---
description: Design or refine the implementation architecture for the requested change.
argument-hint: "[architecture task, question, or relay assignment]"
---
# Architect the change

Settle the consequential design for the requested work, or answer a specific design question,
so an implementer can proceed without inventing architecture. Do not implement. Use the
`agent-work` skill for topic and artifact conventions. If the request names a relay assignment
file, read it first: it fixes the scope, paths and the result file you must write before stopping.

## Work

- Read the request, handoff/plan, existing design notes and the actual code that the design touches.
  If no scout report exists, do the focused investigation yourself.
- Decide; do not leave multiple unchosen options. Resolve reversible technical choices yourself.
  Ask (status `needs-decision` in relay mode) only for choices that change product behavior,
  scope or a protected contract. When distinct work with its own outcome must come first, ask with an
  option that proposes it as a prerequisite slice (see the result format).
- Prefer the smallest design that extends existing mechanisms. Justify every new abstraction by a
  concrete current need. Leave private helpers and naming to the implementer.
- Cover only what matters for this change, typically:
  - **Contracts:** types, functions, commands, schemas or events that change; who calls whom; errors.
  - **Flow:** entry point → state/effects → result, including the important error paths.
  - **State and lifecycle:** the owner, who writes it, creation/cleanup, persistence/compatibility.
  - **Concurrency, failure and recovery,** when relevant.
  - **Verification:** how each acceptance condition is checked, and the earliest real compile or run
    check for the first small integrated step.
  - **Order:** a short implementation sequence, starting with an end-to-end step.
- For a specific question from another worker, answer that question directly; do not redesign the slice.

## Artifact

Write the design (path from the assignment, else `.agents_work/<topic>/architecture.md`). Lead
with the decisions and their reasons. On revision, say what changed and why. In relay mode, a
material decision still open is asked (`needs-decision`), never passed on in a design reported
`done`. Standalone, mark the design **draft** if a material decision is still open.

In chat (or the result summary), give the path, the key decisions and any decision needing the operator.

<operator_request>
$ARGUMENTS
</operator_request>
