---
description: Create or refine a feature specification from the current request and discussion.
argument-hint: "[request in your own words]"
---
# Specify the work

Turn the operator's request and relevant discussion into a precise feature specification. Separate agreed intent from suggestions and unresolved choices. This assignment defines behavior, not implementation architecture.

Use the `agent-work` skill's rules for the topic folder and existing artifacts; load its `SKILL.md` if it is not already available in this context.

## Work

- Start with the operator's request, relevant conversation, and the current `spec.md` when present. Inspect existing behavior only where needed to establish scope, constraints, or compatibility.
- Preserve explicit decisions and non-goals. Do not promote an agent suggestion or illustrative example into an approved requirement.
- Describe who needs the change, their task, observable outcomes, important interactions, and relevant failure or edge behavior. Include documentation impact when users will need guidance.
- Make acceptance criteria specific, demonstrable, and finite. Preserve existing criterion identifiers when revising; introduce simple identifiers only when they help traceability. Separate required outcomes from preferences and optional improvements; discovering an improvement does not add it to acceptance.
- Propose performance gates only for an approved product need, naming the affected task, representative workload/environment, and consequence of missing the threshold. Otherwise label useful measurements advisory, not optimization assignments.
- Distinguish required constraints from implementation preferences. Record already-settled architectural constraints without prescribing a new solution.
- Ask only about unresolved choices that materially change behavior or scope. Otherwise state consequential assumptions and keep the specification usable.

## Artifact

Create or update `.agents_work/<topic>/spec.md`. Open it with a short summary, understandable without the conversation: the behavior now specified, consequential decisions and remaining questions. Then:

- **Intent and scope:** problem, users, desired result, non-goals.
- **Required behavior:** ordinary flow, meaningful states, edges, failure behavior, and compatibility constraints.
- **Acceptance:** observable criteria and the kind of evidence that would demonstrate them.
- **Decisions and open questions:** agreed choices, assumptions, unresolved product decisions, and changes from the previous specification when relevant.

Scale detail to the work. A small fix does not need a product manifesto. An unresolved material question makes this a draft; do not label it approved or ready for implementation on the operator's behalf.

Do not prescribe the next role. In chat, give the artifact path, a short outcome, and any decision the operator still needs to make.

<operator_request>
$ARGUMENTS
</operator_request>
