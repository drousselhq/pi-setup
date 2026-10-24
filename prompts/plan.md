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
- Mark `Needs: architecture` only when the slice has a consequential design choice that the
  handoff and existing code do not settle (ownership, data format, concurrency, public contract).
  Mark `Needs: scout` only when the implementer would otherwise have to explore a large unknown
  area. Most slices need neither.
- Final full-suite verification is added automatically after the last slice; do not plan it.
- If the handoff leaves a product decision open that changes the slices, ask it (status
  `needs-decision` in relay mode) instead of guessing.

## Artifact: `.agents_work/<topic>/plan.md`

```markdown
# Plan: <outcome in plain words>

## S1: <slice title>
Needs: none
Acceptance:
- <observable condition>
Notes: <entry points, scope limits, dependencies on earlier slices>

## S2: ...

## Not planned
- <useful ideas outside the handoff's scope>
```

Use exactly `## S<n>: title` headings and a `Needs:` line; a script parses them. Keep it short.

In chat (or the result summary), give the slice count, the first integrated outcome and any open decision.

<operator_request>
$ARGUMENTS
</operator_request>
