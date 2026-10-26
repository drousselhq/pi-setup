---
description: Create or update user-facing documentation for the requested behavior or workflow.
argument-hint: "[documentation task, in your own words]"
---
# Document the product

Create or improve user-facing documentation for the operator's requested scope. Help readers accomplish real tasks and understand the product accurately. Do not redesign the product or build a new documentation platform unless explicitly requested.

Use the `agent-work` skill for work-item resolution and shared artifacts; load its `SKILL.md` if it is not already available in this context.

## Work

- Prioritize the request, actual implemented behavior, existing user docs, relevant examples/tests, and current implementation notes. Specs and architecture proposals explain intent, but do not establish that a capability is implemented or released.
- Identify the audience, prerequisites, and desired outcome. Put the path to first success before exhaustive detail, and make expected results and common recovery steps visible.
- Use the right form for the need: a guided tutorial for first success, task instructions for a concrete goal, explanation for a useful mental model, or reference for precise commands/options/configuration. Do not create every category for every change.
- Describe current supported behavior, defaults, limits, errors, platform differences, and compatibility/migration implications where relevant. Label unreleased or proposed behavior explicitly; never disguise it as available functionality.
- Verify documented commands, public APIs, configuration names, paths, and output against authoritative implementation or documentation. Run safe examples and applicable documentation checks where possible; state precisely what could not be exercised. Do not use live credentials, paid services, destructive examples, or publish/deploy without the necessary operator authorization.
- Follow the project's existing content structure, generator, terminology, and navigation. Update source content rather than generated site output. Prefer linking to a single canonical explanation over copying it across pages.
- For a static site, check the changed content's links, navigation, code samples, and rendered readability when the available tooling permits. Provide meaningful text alternatives for informative visuals. Do not introduce a framework or GitHub Pages deployment just because the output is documentation.

## Outputs

Write the actual user documentation in the project's established location. When none exists, choose the smallest suitable location consistent with the request; do not create an empty documentation hierarchy.

Create or update `.agents_work/<topic>/docs.md` as a concise documentation-work record: intended readers/tasks, pages changed, relevant behavior/source references, checks performed, and known gaps. The full user guide belongs in the durable docs, not in this handoff record.

Keep product source unchanged unless the operator separately authorized a necessary implementation change. Report a behavior/documentation mismatch rather than silently fixing the product to fit the prose.

## Handoff

End the work record with a concise **Handoff** of the user outcomes now documented, important entry pages, verified examples/builds/links, and outstanding accuracy or publication issues. Distinguish content ready for use from content actually published. Do not prescribe the next role.

In chat, give the user-doc paths, work-record path, result, and verification limits.

<operator_request>
$ARGUMENTS
</operator_request>
