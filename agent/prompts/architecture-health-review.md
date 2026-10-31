---
description: Investigate accumulated architectural friction and long-term change cost without changing the system.
argument-hint: "[subsystem, recurring friction, or audit focus]"
---
# Review architectural health

Investigate where the existing architecture makes realistic changes or failure handling unnecessarily costly. This is a focused, read-only health review—not a review of one diff, an implementation design, or approval to change the system. It complements `/review` (an in-depth review of one change set, including legibility and test design) and `/architecture` (design for a requested change).

Use the installed `agent-work` skill's rules for the topic folder and existing artifacts; load its actual `SKILL.md` if it is not already available in this context. Follow applicable repository instructions and authoritative contracts. Proposals and report existence do not approve delivery.

## Scope and investigation

Start with the operator request below. If it names a subsystem or pain point, honor that focus. Otherwise, use recent relevant Git history, repeated fixes, and current source evidence to select a focused hotspot; widen only when evidence shows the issue crosses that scope. Do not assume Git or useful history exists. Churn is a lead, not proof of debt: distinguish source changes from formatting, generated output, and documentation churn. State what evidence was unavailable.

Resolve the owning repository and read its applicable instructions, architecture/contributing guidance, and contract and decision authorities before drawing conclusions. Read relevant existing ADR rationale and use the project's domain terms. Revisit a decision only for concrete new evidence; label any conflict or proposed change and identify its actual resolver. Do not impose new terminology, create glossary/ADR work, or treat a proposal as an approved contract.

Trace consequential flows through actual callers, state ownership, effects, errors, and tests. Look for costs borne by callers or maintainers: ordering, ownership and lifetime, error handling, configuration, resource/performance obligations, information leakage, scattered domain rules, duplicated knowledge, pass-through layers, poor change locality, and integration-test blind spots. Anchor important claims to paths and symbols and to a representative realistic change or failure scenario. A missing test alone is a gap, not proof of a defect.

Use the counterfactual deletion test for suspected abstractions: if removing one makes needless complexity disappear, it may be needless; if obligations or complexity reappear across callers, it may be earning its keep. Cohesive private files are fine. Depth is not file size or file count, and consolidation is not a goal by itself. Thin ABI, ownership, platform, and real-time layers can be justified with a single implementation. Keep performance-sensitive obligations visible. Do not prescribe blanket deletion or replacement of private tests; preserve applicable numerical, lifecycle, independent-oracle, and regression obligations required by project contracts. Behavior tests complement focused tests.

Inspect only what is useful to establish a focused, evidence-backed account. Do not implement, redesign contracts by fiat, or initiate delivery. Use read-only inspection. Do not run builds, tests, linters, formatters, setup, benchmarks, paid requests, or native host/device operations for this audit; identify useful validation and its limits instead. Do not delegate, write to the shared tracker, or start another workflow without separate explicit authority. Respect the agent-work archive restrictions.

## Report

Unless the operator asks for chat-only, use the resolved active topic's `.agents_work/<topic>/architecture-health-review.md`. Follow those `agent-work` rules (topic folder, existing artifacts, Git-ignored `.agents_work/`) before writing. Do not overwrite `review.md` or `architecture.md`, unrelated work, or an unexpected existing report; resolve a name conflict under those rules or ask. Write only this scoped report and useful permitted evidence.

Open the report with the recommendation, key conclusion, evidence limits and what remains unverified. State the inspected scope, source/candidate identity (including material dirty changes when relevant), and what was not assessed. Separate evidence-backed defects, maintenance opportunities, and unverified hypotheses. A small set of useful findings is better than a quota; doing nothing is a valid recommendation. Do not assign universal health scores or promise that a system is universally healthy.

For each actionable opportunity explain:
- the current friction and concrete evidence, who or what bears its cost, and the representative change or failure affected;
- current versus proposed responsibility placement, distinguishing observed facts from a proposal and from approved decisions;
- the smallest plausible intervention, its maintenance gain, risks and tradeoffs, plus dependencies or constraints;
- how to verify the improvement without losing behavior, including relevant existing tests and any needed checks that were not run;
- its relative recommendation and confidence, without speculative numeric targets.

Describe before/after responsibilities plainly. Include a diagram only when it clarifies a real relationship. Recommend the most useful follow-up—or no action—not a launch, automatic ticket, or mandatory next agent.

In chat, give the report path (or state that the response is chat-only), key conclusion, and material limits. Do not claim model-backed execution or architectural health was verified.

<operator_request>
$ARGUMENTS
</operator_request>
