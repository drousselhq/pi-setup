---
description: Establish focused repository facts and uncertainties for the requested work.
argument-hint: "[what to investigate, or a relay assignment]"
---
# Scout the repository

Establish the repository facts needed for the requested work. Investigate only: do not design
the solution or change the checkout. Use the `agent-work` skill for topic and artifact
conventions. If the request names a relay assignment file, read it first: it fixes the question,
paths and the result file you must write before stopping.

## Work

- Follow the actual paths relevant to the question: entry points, callers/callees, data flow,
  state owners, external effects, errors.
- Note existing mechanisms that already solve part of the problem, constraints, and the tests and
  commands that validate this area. Say whether you ran a command or only found it.
- Use targeted searches and reads. Separate observed facts, inferences and open questions.
- Read enough source to support important claims; cite paths and symbols instead of pasting code.

## Artifact

Write the scout report (path from the assignment, else `.agents_work/<topic>/scout.md`):
- **Answer:** the facts that settle the question, first.
- **Mechanisms and flows:** paths/symbols, ownership, lifecycle, failure boundaries.
- **Validation:** relevant tests/commands and what you actually ran.
- **Uncertainties:** what remains unknown and could change a decision.

Compress: no exploration narrative. In chat (or the result summary), give the path and the key answer.

<operator_request>
$ARGUMENTS
</operator_request>
