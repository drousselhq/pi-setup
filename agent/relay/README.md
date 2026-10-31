# pi-relay

A script, not an LLM, coordinates the work. It runs one slice at a time:

```
PLAN (only if plan.md is missing) → for each slice: [scout] [architect] → implement → review ⇄ repair → next
→ FINAL (full verification, reviewed only if it changed something) → done
```

Workers are fresh Pi sessions in visible Herdr tabs, started with the role's model.
They use the `/plan`, `/scout`, `/architecture`, `/implement` and `/review` templates.
The implementer and reviewer keep their sessions for the whole slice; all tabs close when
the slice is done. Session files are kept, and their paths are listed in `relay/state.json`.

## Usage

```
cd <project checkout>        # inside a Herdr pane
pi-relay <topic>             # runs or resumes .agents_work/<topic>
pi-relay <topic> --status    # shows progress without running anything
```

Input: `.agents_work/<topic>/handoff.md` (from `/handoff`), plus `plan.md` if you wrote one.
Progress signals are deterministic and come from files only (no model calls):
- **acceptance X/Y:** the `Acceptance:` bullets of slices the reviewer accepted, out of all slices in `plan.md`.
- **review loops:** reviewer "changes required" verdicts, shown as `review loop 1/3`. A blocking finding ID
  that comes back after a repair is shown in red (`R1 again`).
- **compactions and turns:** read from each worker's Pi session file during the step and after it
  (yellow from 1 compaction, red from 3). The file is read incrementally, so even huge sessions stay cheap.

They appear in the slice headings, the live working line, each result, a `progress` line after each slice,
the startup header and `--status`.

The console shows a coloured, live view: a header per slice, each step and result, a running
timer while a worker is busy, and highlighted boxes when it needs you. `relay/log.md` records the
same events as plain text. Set `NO_COLOR=1` for plain console output.

Stopping the script (Ctrl-C) is safe. Re-running it resumes from `relay/state.json`.
Running workers keep working while the script is stopped.

## When it needs you

- **Permission prompt in a worker tab:** you get a notification. Answer it in that tab; the relay continues by itself.
- **`needs-decision`:** an **advisor** (Opus, medium) reads the question, the worker's records, the
  handoff and earlier decisions. It shows you a plain-language brief: what is being asked, numbered
  options, a ★ recommended option with its reason, and notes such as "you already decided this". Answer in
  the advisor's tab; a number is enough, and you can also ask it questions. The relay records the decision
  in `decisions.md`, delivers the advisor's reply to the waiting worker (and notes for other roles at their
  next step), and continues. If the advisor cannot produce a brief, the worker's question is shown directly.

  **Decide rather than defer.** The recommended option comes first. An option that postpones the decision
  must state what information is missing, what is expected to supply it, the decision point (the step or event
  at which it is decided whatever happens) and the behaviour until then; the relay sends a brief back to the
  advisor when such an option lacks them. The advisor does not recommend postponing just because evidence is
  incomplete, and points out an earlier deferral of the same question in `decisions.md`. A chosen deferral is
  recorded there with those four items. The project's own rules for decisions, where its instructions define
  them, take precedence.

  **Advisory council** (on by default; see Configuration). The relay can decide instead of waiting for you:
  - The advisor's brief also gives each option its exact `action` and its decision classes, and says whether
    the question needs you (`ownerNeeded`).
  - You are asked as before, without a vote, when the advisor says the question is yours or recommends an
    option in a class you keep.
  - Otherwise two council members, on different models, each get the question and the options without the
    advisor's recommendation, in a neutral order (labelled `X1`, `X2`…), plus the worker's records, the
    handoff, the plan and earlier decisions. They vote independently, in parallel, in their own tabs
    (`/council` prompt): a choice, conditions, the classes of the chosen action, confidence, reversibility,
    `ownerNeeded`, reasons and a plain-language summary for you.
  - **The council decides** only when both choose the same listed option and neither vote, nor the advisor's
    classes for that option, puts it in a class you keep, says you are needed, calls it irreversible, and
    when not both have low confidence. The advisor then writes the decision from that option's action and the
    members' conditions; the relay checks it matches the option (no added deferral or prerequisite slice).
    You get a notification, the decision is recorded as **Decided by the council** with the models, classes
    and reversibility, and the closing summary lists the run's council decisions. A later decision of yours
    can overrule it.
  - **Anything else comes to you** in the advisor's brief, with why the council sent it and each member's
    proposal in plain words. A member that cannot start, disappears, gives no valid vote after one
    reminder, or is still working after `council.timeoutMinutes` sends the question to you: one vote never
    decides. If the advisor cannot write a council decision, you are asked in the worker's tab.

  Classes (the owner keeps E to I by default):

  | Class | Covers |
  |---|---|
  | A | Technical choice within the approved scope: behaviour, method, test approach |
  | B | Meaning of an unclear acceptance clause or handoff, without lowering it |
  | C | Touching files outside a slice's listed paths, within the topic's handoff |
  | D | Deferring work to a later slice, the backlog or an already scheduled point, without dropping required work |
  | E | Widening scope: new features, behaviour beyond the handoff, roadmap changes |
  | F | Product direction and user experience |
  | G | Tooling and infrastructure strategy: new dependencies, harnesses, external services |
  | H | Changes to project rules and contracts: instructions, ADRs, verification gates and thresholds, acceptance criteria |
  | I | Irreversible or external effects: published formats, data migration, deleting evidence, pushing, money, credentials, licences |

  A project's own rules still take precedence: where they reserve a decision to you, the members say so and
  it comes to you. Limits: the members share the checkout, so they can come across the advisor's notes or
  the worker's own preference; and both can misclassify a question the same way, which the records and
  your overrule are there to catch.
- **`blocked`:** you get a notification with the problem. Answer or fix it, then reply to the worker in its
  tab. It continues and rewrites its result file, and the relay picks that up.
- **Stops (exit code 2):** a repair-cycle limit, the scout/architect request limit, or a missing
  plan. Read the message in `relay/log.md`, adjust `plan.md`/`handoff.md` if needed, then run `pi-relay <topic>` again.
  Re-running after a limit stop allows that many more cycles or requests.
- **A prerequisite slice:** a worker that finds distinct work must come first asks `needs-decision` with an
  option proposing a slice. If you choose it in the advisor's brief, the relay inserts the slice into `plan.md`
  before the current one (next free id, e.g. `S2b`), sets the current slice aside, runs the new slice, then
  resumes the set-aside slice with the same worker sessions, a new base at the current commit and the advisor's
  reply. You can also do it by hand: stop the relay, add the slice to `plan.md` ahead of the current one and re-run.
  Either way only a slice with no commits or changes yet is set aside; otherwise the relay stops and says so.
  Do not edit `relay/state.json`.

## Files

| Path (under `.agents_work/<topic>/`) | Owner | Purpose |
|---|---|---|
| `handoff.md` | you / `/handoff` | intent, scope, acceptance, authority |
| `plan.md` | planner or you | slices (format below); can be edited between slices |
| `relay.json` | you, optional | per-topic overrides of `config.json` |
| `decisions.md` | relay | every decision of the run, each marked as decided by you or by the council; every assignment points workers to it |
| `slices/<id>/*.md` | workers | scout, architecture, implementation and review artifacts |
| `relay/NNN-<role>.md` | script | assignment given to a worker |
| `relay/NNN-<role>-<step>.result.json` | worker | the only thing the script reads from a worker (council votes: `NNN-council1-vote.result.json`) |
| `relay/state.json`, `relay/log.md` | script | resumable state and a readable history |
| `relay/events.jsonl` | script | structured history for evaluation (see below) |

### events.jsonl

One JSON object per line. Every event has `t`, `run` (one ID per relay process), `topic`, `slice` and `type`:

| type | extra fields |
|---|---|
| `run_start` | project, resumed, head, roles (models/thinking), commit, maxRepairCycles, quota, council (when enabled) |
| `slice_start` / `slice_done` | title, needs, base / head, commits, repairCycles, helpRequests, durationMs |
| `agent_start` | role, agent, model, thinking, session (Pi session file), tab, resumedSession |
| `step_sent` / `step_result` | role, purpose / status, verdict, blocking, summary, question, checks, durationMs, usage |
| `operator_wait_start` / `operator_wait_end` | role, status, question / waitedMs |
| `permission_wait` | role, waitedMs |
| `advisor_start`, `advisor_brief` | workerRole, question / title, options, recommended |
| `owner_decision`, `council_decision` | id, title, decision, workerRole, replies, slice |
| `council_start`, `council_vote`, `council_escalation` | options, members / member, model, choice, classes, confidence, reversibility, ownerNeeded or failed / reasons |
| `nudge`, `redeliver` | role, purpose, reason |
| `quota_reading`, `quota_pause`, `quota_pause_end` | fiveHour, sevenDay / until, reason / waitedMs |
| `run_complete` / `run_stop` | head / reason, kind |

`usage` comes from the worker's Pi session for that step: turns, input, output, cacheRead, cacheWrite,
reasoning, costUsd and compactions. The full transcripts stay in the Pi session files listed in `agent_start`.

### plan.md format

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

The relay writes this format into the planner's assignment. Use exactly `## S<n>: title` headings.
`Needs:` is `none`, or `scout` and/or `architecture` for preparation that runs before implementation.
The relay counts the `Acceptance:` bullets. Slice IDs (`S1`, `S2`, `S2a`…) must stay stable. Finished slices are tracked by ID in `state.json`.

### Result file

```json
{ "status": "done | needs-scout | needs-architecture | needs-decision | blocked",
  "summary": "...", "question": "...", "verdict": "accept | changes-required",
  "blocking": ["R1"], "checks": ["cmd → pass"], "artifact": "path" }
```

`verdict` and `blocking` are for the reviewer only. Allowed statuses differ by role (see the assignment).

## Configuration

`config.json` in this directory sets defaults; `.agents_work/<topic>/relay.json` overrides them per topic.
For roles, only the fields you set are overridden:

```json
{ "commit": false, "maxRepairCycles": 2, "roles": { "implementer": { "thinking": "xhigh" } } }
```

- **Escalation** (`escalation`): after `afterLoops` review loops without acceptance (default 2), or as soon as
  a blocking finding comes back after a repair, the `senior` role (default Opus, high thinking) takes over the
  slice in a fresh session. It gets `maxLoops` more review loops (default 2); then the relay stops for you.
  With escalation disabled, `maxRepairCycles` is the flat limit.
- **Advisor** (`advisor.enabled`, role `advisor`): turns `needs-decision` questions into briefs, as above.
- **Advisory council** (`council`, roles `council1` and `council2`, default Opus high and Sol high):
  ```json
  "council": { "enabled": true, "members": ["council1", "council2"], "ownerClasses": ["E", "F", "G", "H", "I"], "timeoutMinutes": 30 }
  ```
  It needs the advisor. Turn it off for a topic with `"council": { "enabled": false }` in `relay.json`: like
  `roles`, the `council` block merges field by field. When it is on, the relay refuses to start unless
  `members` names exactly two distinct roles that are not worker or advisor roles, each has a model, the two
  models differ, and `ownerClasses` lists class letters. Change a member's model under `roles` (for example
  when a subscription ends).
- **Compaction limit** (`maxCompactionsPerStep`, default 2): a worker that compacts that often within one step
  is interrupted (Escape). An implementer's step is handed to the senior; for the senior or any other role the
  relay stops, and re-running retries the step in a fresh session. `0` disables it.
- `commit: true`: the implementer commits each slice and each repair locally (explicit paths, never pushes).
  The reviewer reviews `base..HEAD`. With `false`, everything stays uncommitted and the reviewer reads the working tree.
- The script never pushes, never touches trackers and never edits product files.

### Quota pacing (Anthropic subscription roles)

```json
"quota": { "enabled": true, "fiveHourMaxPercent": 90, "weeklyPaceMarginPercent": 10 }
```

Before each worker step, the relay reads your subscription usage (the same endpoint as `/quotas`, at most every 5 minutes):
- If the 5h window is at or above `fiveHourMaxPercent`, it waits for that window to reset.
- If any weekly window is ahead of an even pace across the week, it waits until the pace catches up.
  An even pace means the elapsed share of the week; the margin lets you run that many points ahead.
  It is a ceiling only: unused days carry over.

Your interactive sessions count too, because the relay reads real usage rather than estimating.
A step already running is never interrupted. A worker cut off by a hard limit waits, then is told to continue.
If usage can't be read, the relay continues without pacing and logs it.
Set `"enabled": false` to turn pacing off, or lower the margin to spread usage more evenly.

## Code and tests

`pi-relay.mjs` is the command; the code is in `lib/`, one module per concern (the header of
`pi-relay.mjs` lists them). Everything outside the relay's own files (Herdr, Git, waiting, notifications,
the terminal, the quota endpoint) goes through one `io` object, so the relay runs in-process in tests.
The tests live in the pi-setup repository: `test/relay/` (`npm test`), with a fake Herdr whose scripted
workers play the agents and the owner. Changes are also checked with a real run on a throwaway repository
(see CONTRIBUTING.md there).

