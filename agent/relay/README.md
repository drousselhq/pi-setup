# pi-relay

A script, not an LLM, coordinates the work. It runs one slice at a time:

```
PLAN (only if plan.md is missing) → for each slice: [scout] [architect] [acceptance] → implement → review ⇄ repair → next
→ FINAL (full verification, reviewed only if it changed something) → done
```

Workers are fresh Pi sessions in visible Herdr tabs, started with the role's model.
They use the `/plan`, `/scout`, `/architecture`, `/acceptance`, `/implement` and `/review` templates.
The implementer and reviewer keep their sessions for the whole slice; all tabs close when
the slice is done. Session files are kept, and their paths are listed in `relay/state.json`.

## Usage

```
cd <project checkout>        # inside a Herdr pane
pi-relay <topic>             # runs or resumes .agents_work/<topic>
pi-relay <topic> --status    # shows progress without running anything
pi-relay <topic> --fresh <role> [--note "..."]   # replaces the waiting worker with a fresh session (below)
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

Stopping the script (Ctrl-C) is safe, and so is the script being killed at any moment. Re-running it resumes
from `relay/state.json`: every saved state names the next step, a step whose prompt may not have reached its
worker is checked and delivered again if needed (never typed twice into a worker that started on it), and
decisions and relay-inserted slices are written whole and only once (their events are not repeated on a
replay). Running workers keep working while the script is stopped. Two exceptions: a worker the script was
starting at that moment, and a worker it had just finished with; the next run closes their tabs (the first is
started again). If a stop cannot be recorded (a full disk, for instance), the script still shows its cause in
the terminal. One case needs you: a relay killed during the moment it takes over a lock left by a dead relay
(`relay/lock`) can leave `relay/lock.reclaim`; the next start, after a short wait, says so and asks you to delete it
(handling it automatically would let two relays start at once).

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
    when not both have low confidence. The relay then records the decision itself, from what was voted: the
    option's label, its action, deferral or prerequisite slice as the advisor wrote them, and the members'
    conditions, word for word; the waiting worker gets the same as a binding instruction, and the reviewer a
    pointer to it. Later questions of the same worker step go to the council too. The advisor lists the
    earlier decisions a question would change (`revisits`), and the members see them: they may amend a
    council decision within its intent, while changing one of yours stays yours unless the project's rules
    say otherwise. The council answers one such question per worker step, and at most three questions in
    all per step: past that, the question comes to you.
    You get a notification, the decision is recorded as **Decided by the council** with the models, classes
    and reversibility, and the closing summary lists the run's council decisions. A later decision of yours
    can overrule it.
  - **Anything else comes to you** in the advisor's brief, with why the council sent it and each member's
    proposal in plain words. A member that cannot start, disappears, gives no valid vote after one
    reminder, or is still working after `council.timeoutMinutes` sends the question to you: one vote never
    decides. Before the vote, every option must be complete (an action, its classes, and a valid deferral or
    prerequisite slice if it has one); members see every field that would bind.

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
  tab. It continues and rewrites its result file, and the relay picks that up. If it then asks for a decision,
  that question goes through the advisor (and council) like any other. What you type in a worker's tab while it
  waits for you (after `blocked`, a question the advisor could not take, or a missing result) is recorded in
  `decisions.md` as "Tab answer": the question and an excerpt of what was typed (text only, at most 2,000
  characters), so later workers see it. It is an unverified excerpt, not a decision brief (Pi does not record who
  typed a message); edit or remove it in `decisions.md` if it should not stand. An answer typed in a worker you then
  replace with `--fresh` is not recorded: put what matters in `--note`.
- **A permission prompt** (a worker waiting for you to allow a command): you get a notification, and the console,
  `log.md` and the `permission_wait` event show an excerpt of the worker's screen, for workers and council members.
- **A worker only a new session can fix** (it saw material it must not see, or it is confused beyond repair):
  stop the relay (Ctrl-C) and run `pi-relay <topic> --fresh <role>`, optionally with `--note "..."` for
  anything the new session must know that is not in the topic's files (for example a permission you gave in the
  old tab). The relay closes that worker's tab, forgets its session and restarts its current step in a new session,
  with your note. A fresh reviewer does a full, independent review: the previous review record is set aside in
  `relay/NNN-reviewer-replaced-review.md`, kept for you, and not given to it. Other roles keep their record. It
  applies only to the worker the relay is waiting for, or to the step retried after a compaction-limit stop.
- **Stops (exit code 2):** the relay stops for you, saying why in the terminal and, once it holds the topic's
  lock, in `relay/log.md`, when:
  - a limit is reached: repair cycles, scout/architect requests, or the compaction limit (for the implementer only
    when escalation is off);
  - the plan cannot be used: no handoff or plan, a malformed `plan.md`, a duplicated or vanished slice;
  - a prerequisite slice cannot be added (the slice has changes, planning, no free id), or `plan.md` now puts
    a new slice before one with changes;
  - the final verification failed, or the files changed again after one more verification;
  - changes made during a slice are still uncommitted, or Git cannot list the changes;
  - another relay holds the topic's lock, or one is taking it over, or a guard needs deleting;
  - a configuration or command-line problem: a missing model, an invalid council, a bad `--fresh` or option, or
    starting it outside a Herdr pane;
  - a worker's tab was closed while it waited for you, or its agent was lost or never started;
  - the saved state names no next step for the current slice: a relay bug, so report it and keep `relay/` as it is.

  Read the message, fix what it names (`plan.md`, `handoff.md`, Git, the lock), then run `pi-relay <topic>`
  again: it resumes. Re-running after a limit stop allows that many more cycles or requests. Exit code 1 is an
  unexpected error (a bug or a failed effect such as a full disk); 0 is complete, or nothing to do.
- **Uncommitted work** (with `commit: true`): changes made during a slice must be committed by its worker. When a
  worker reports done while some remain, it is asked once (each time it reports done with leftovers) to commit
  those that belong to the slice and to leave the rest alone; if changes are still left, the relay stops (exit 2)
  and lists them, and no slice is recorded done with them, nor while Git cannot list the changes. In the final
  verification, a commit step never counts as verification: if the files changed, the relay asks for another. Your own edits during a slice show up there too: commit or stash them, then re-run (the
  worker's result is used again). Changes made before the slice, `.agents_work/`, and a set-aside slice's
  acceptance tests never count; the slice's own acceptance tests do until committed.
- **The final verification** runs the project's full verification on the whole candidate. Its worker reports
  `verification: pass | fail` on every result. The relay announces completion only on a pass it saw in the
  current run, for the files as they are when it finishes (their content, so committing verified work changes
  nothing). A failing verification stops the relay (exit 2): fix the cause or decide, then re-run, and the same
  worker verifies again. A pass read after a restart is verified again; files changed after the pass (a reviewer
  that edited, say) get one more verification, and changed again, the relay stops naming the files. A slice added
  to the plan after the final verification runs, and the final verification runs again after it. A completed topic run
  again with the files unchanged reports completion as before; after other changes it says which state its
  verification covered and starts nothing.
- **A prerequisite slice:** a worker that finds distinct work must come first asks `needs-decision` with an
  option proposing a slice. If you choose it in the advisor's brief, the relay inserts the slice into `plan.md`
  before the current one (next free id, e.g. `S2b`), sets the current slice aside, runs the new slice, then
  resumes the set-aside slice with the same worker sessions, a new base at the current commit and the advisor's
  reply. You can also do it by hand: stop the relay, add the slice to `plan.md` ahead of the current one and re-run.
  Either way only a slice with no commits or changes yet is set aside; otherwise the relay stops and says so.
  During the final verification, a prerequisite slice chosen before it has changed anything is added after the
  plan's last slice; the slice runs and the final verification starts again from the beginning. During planning,
  or once the final verification has changed files, the relay stops with advice instead.
  Its acceptance tests (see "Acceptance tests before the code") do not count as changes: they stay in the
  working tree, and every assignment of the prerequisite slice lists them as not its work. A red or
  non-compiling acceptance test can break that slice's build or test discovery (for example a crate-wide
  `cargo test`) until its worker excludes it, as it is told to. Do not edit `relay/state.json`.

## Files

| Path (under `.agents_work/<topic>/`) | Owner | Purpose |
|---|---|---|
| `handoff.md` | you / `/handoff` | intent, scope, acceptance, authority |
| `plan.md` | planner or you | slices (format below); can be edited between slices |
| `relay.json` | you, optional | per-topic overrides of `config.json` |
| `decisions.md` | relay | every decision of the run, each marked as decided by you or by the council, and the answers typed in workers' tabs; every assignment points workers to it |
| `slices/<id>/*.md` | workers | scout, architecture, acceptance, implementation and review artifacts |
| `slices/<id>/acceptance-original/` | script | the acceptance tests as their worker wrote them (see below) |
| `relay/NNN-<role>.md` | script | assignment given to a worker |
| `relay/NNN-<role>-<step>.result.json` | worker | the only thing the script reads from a worker (council votes: `NNN-council1-vote.result.json`) |
| `relay/state.json`, `relay/log.md` | script | resumable state and a readable history |
| `relay/lock`, `relay/lock.reclaim` | script | the running relay's pid; a guard held while a stale lock is taken over |
| `relay/events.jsonl` | script | structured history for evaluation (see below) |

### events.jsonl

One JSON object per line. Every event has `t`, `run` (one ID per relay process), `topic`, `slice` and `type`:

| type | extra fields |
|---|---|
| `run_start` | project, resumed, head, roles (models/thinking), commit, maxRepairCycles, quota, council (when enabled) |
| `slice_start` / `slice_done` | title, needs, base / head, commits, repairCycles, helpRequests, durationMs |
| `slice_set_aside` / `slice_resumed` | slice, before, restart (true when the final verification starts again after the slice) / before, base |
| `agent_start` | role, agent, model, thinking, session (Pi session file), tab, resumedSession |
| `agent_start_recovered` | role, agent, tab (a worker whose start was interrupted, closed before starting anew) |
| `step_sent` / `step_result` | role, purpose / status, verdict, blocking, summary, question, verification, checks, durationMs, usage |
| `operator_wait_start` / `operator_wait_end` | role, status, question / waitedMs |
| `permission_wait` | role, waitedMs (workers), screen (an excerpt of the worker's screen) |
| `advisor_start`, `advisor_brief` | workerRole, question / the whole brief: title, question, context, options (every field), recommended, reason, notes, ownerNeeded, revisits |
| `owner_decision`, `council_decision` | id, title, decision, chosen (the option's number, or null), workerRole, replies (roles), prerequisite (a prerequisite slice's title) |
| `council_start`, `council_vote`, `council_escalation` | options, members / member, model, choice, classes, confidence, reversibility, ownerNeeded or failed / reasons |
| `nudge`, `redeliver` | role, purpose, reason |
| `prompt_resubmitted` | role, attempt (a prompt left unsent in a worker's input box, submitted with Enter) |
| `runaway` | role, purpose, compactions, turns, interrupted (a step over the compaction limit) |
| `fresh_session` | role, purpose, setAside, note (`--fresh`) |
| `acceptance_recorded`, `acceptance_compared` | tests, snapshot / changed, missing (acceptance files, before each review) |
| `quota_reading`, `quota_pause`, `quota_pause_end` | fiveHour, sevenDay / until, reason / waitedMs |
| `run_complete` / `run_stop` | head, verification (`pass`) / reason, kind |
| `run_already_complete` | current (false: the files changed since the final verification), head |
| `final_invalidated` | slice (added after the final verification, which runs again) |

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

## S2: <slice title>
Needs: S1
Acceptance:
- <observable condition>

## Not planned
- <useful ideas outside the handoff's scope>
```

The relay writes this format into the planner's assignment. Use exactly `## S<n>: title` headings.
`Needs:` is `none`, or any of `scout`, `architecture` and `acceptance` for preparation that runs before
implementation, always in that order. It may also name earlier slices (`S1`, `S2a`, a range such as `S2–S4`)
to document their order; slices always run in file order. Before any work, and again before each new slice,
the relay stops if `plan.md` has no slices, has a heading meant as a slice that does not parse (`## Step 1: ...`,
`## Slice 2 ...`), or has an empty `Needs:` or a value it does not know, naming the line.
The relay counts the `Acceptance:` bullets. Slice IDs (`S1`, `S2`, `S2a`…) must stay stable. Finished slices are tracked by ID in `state.json`.

### Result file

```json
{ "status": "done | needs-scout | needs-architecture | needs-decision | blocked",
  "summary": "...", "question": "...", "verdict": "accept | changes-required",
  "blocking": ["R1"], "tests": ["path"], "checks": ["cmd → pass"], "artifact": "path" }
```

`verdict` and `blocking` are for the reviewer only (`accept` lists no blocking finding, `changes-required` at
least one; a contradiction is an invalid result: one reminder naming it, then you), `tests` for the acceptance
worker only, `verification` (`pass | fail`) for the implementer or senior in the final verification only. Allowed statuses differ by role (see the assignment).

### Acceptance tests before the code

A slice with `Needs: acceptance` gets an **acceptance** worker after its scout and architect (`/acceptance`
prompt; its model is the topic's reviewer model unless `roles.acceptance` sets one). Before any
implementation exists, it writes tests from the requirement sources (handoff, slice, `decisions.md`, the
project's specifications) in new files only, records in `slices/<id>/acceptance.md` which clause each test
checks and what it showed before implementation, and lists the files in `tests`.

- **Checked:** with status `done`, `tests` must list readable new files inside the project (not ignored, not
  under `.agents_work/` or `.git/`, absent when the step started), and they must be exactly what the step
  changed, without commits. Otherwise the worker is reminded once with the reason, then you are asked.
- **Kept:** the relay copies them to `slices/<id>/acceptance-original/` and re-baselines the slice, so they
  are not counted as its changes (a prerequisite slice can still be set aside).
- **Reported, never enforced:** the implementer is told to adapt their binding only and commit them with
  its work. Every review and re-review message names the files that changed or went missing since they were
  written; the reviewer judges each changed expectation. The relay does not run the tests and never blocks
  on them.

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
  relay stops, and re-running retries the step in a fresh session that continues from the partial work (a
  reviewer's partial record included). To steer that retry, or to have a reviewer start over, re-run with
  `--fresh <role> --note "..."` instead. `0` disables it. Workers are told the limit in their assignment.
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

