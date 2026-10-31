---
description: Save the agreed work as a handoff for pi-relay; start the relay only when explicitly asked.
argument-hint: "[topic, scope or handoff instructions; optionally 'and start the relay']"
---
# Hand off the agreed work

Distill the discussion into a self-contained `handoff.md` that a planner and workers can execute
without this conversation. This is not another brainstorming round, a design exercise or implementation.
Use the `agent-work` skill to resolve the topic and folder.

## Write `.agents_work/<topic>/handoff.md`

Read the existing file first if there is one; preserve agreed decisions and say what changed.
Capture only what the work needs:

- **Outcome and reason:** what should change, for whom, and why.
- **Agreed behavior:** requirements, examples, boundaries, meaningful edge cases.
- **Decisions:** what I decided (with reasons), what is left to the workers' judgment, and what is
  still open. Do not turn your own suggestions into my decisions.
- **Scope and non-goals.**
- **Acceptance:** observable conditions, and any checks reserved for me.
- **Starting context:** useful paths, existing artifacts, ticket IDs if the project uses a tracker,
  current branch and unfinished edits if known.
- **Authority:** whether workers may commit locally (default yes, never push), and any limits on
  models, spending, dependencies, external systems or data.

If I gave a slice breakdown, also write `plan.md` in the relay format (see `/plan`); otherwise the
relay's planner writes it. If I asked for non-default relay settings (no commits, another model,
cycle limits), write them to `.agents_work/<topic>/relay.json` (see `~/.pi/agent/relay/README.md`).
Keep the handoff short and concrete; do not copy the transcript.

Do not update tracker tickets unless I explicitly ask for that specific update.

## Finish, or start the relay when asked

Normally stop after saving. Give the path, any open decision that would block planning, and the
command to run from the project checkout in a Herdr pane:

`pi-relay <topic>`

Only when I explicitly ask to start it: check `pi-relay <topic> --status` and the topic's
`relay/lock` for a relay already running. If none is running, create one new Herdr tab in the
project checkout and run the command there:

```
herdr tab create --workspace <current workspace id> --cwd <project root> --label "relay <topic>" --no-focus
herdr pane run <returned root pane id> "pi-relay <topic>"
```

Confirm that it started (`herdr pane read <pane id>` shows the `pi-relay · <topic>` header), report the tab, and
stop. Do not coordinate or start workers from this session.

<operator_request>
$ARGUMENTS
</operator_request>
