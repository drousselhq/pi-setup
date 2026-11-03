---
description: Write acceptance tests from the requirement sources before the implementation exists.
argument-hint: "[work to write acceptance tests for, or relay assignment]"
---
# Write the acceptance tests

Write executable tests that decide whether the requested work meets its requirement, before it
is implemented. Derive every expected result from the requirement sources, never from how the
code might be written. Do not implement the work. Use the `agent-work` skill for topic and
artifact conventions. If the request names a relay assignment file, read it first: it fixes the
slice, paths and the result file you must write before stopping.

## Work

- Read the request or slice acceptance, the handoff, `decisions.md`, any design for this work, and
  the specification documents the project's instructions name. Decisions override older text; cite
  the one that applies.
- Identify the authoritative clauses behind each acceptance condition: the document and section
  that says what must happen. Where the acceptance condition and its source disagree, or a source is
  ambiguous in a way that changes the expected result, ask (`needs-decision` in relay mode) rather
  than pick one.
- Read existing code and tests only for entry points, harnesses and conventions. Bind to stable
  interfaces: an existing command, file format, public API or test harness, or the interfaces a
  design for this work settles. Where you must guess a name or signature, keep the guess in one
  place so it is easy to adapt.
- For each clause, test the observable result through the real entry point: the ordinary case,
  boundaries, invalid input and the failure behaviour the source specifies. Where the source
  prescribes a method or algorithm, include inputs that stress the method itself: near-coincident
  or degenerate cases, and values at, just inside and just outside each range it relies on. Prefer independent
  expected values (an analytic result, a documented example, a reference) over values computed the
  way an implementation would. Assert only what the source specifies: not incidental structure
  such as element or output order, private names or formatting, which a correct implementation
  may choose differently.
- Write only new files, in the project's normal test locations, following its conventions. Put
  expectation fixtures in new files too. Do not edit existing files, including existing tests that
  contradict the sources: report those in your artifact.
- Run the new tests once. Most should fail now, for the reason that the behaviour is missing. Record,
  per clause, which fail and why, and which already pass (a pass can be a legitimate check that
  existing behaviour is preserved, or a sign the test does not exercise the change).
- Stop when every clause has tests or a recorded reason why it cannot be tested automatically. Do
  not pad with cases no clause requires.

## Artifact

Write the acceptance record (path from the assignment, else `.agents_work/<topic>/acceptance.md`):
- **Clauses:** for each acceptance condition, its source (document and section, or decision), the
  tests that check it, the expected observable result and the command that runs them.
- **Not tested automatically:** obligations you could not express as a test, and why.
- **Baseline:** the result of the run before implementation, clause by clause.
- **Conflicts:** existing tests or documents that contradict the sources.

In relay mode, list every file you created in the result's `tests` field, as the assignment
describes. In chat (or the result summary), give the artifact path, the number of clauses covered
and any conflict found.

<operator_request>
$ARGUMENTS
</operator_request>
