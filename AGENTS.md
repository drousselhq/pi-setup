# Agent instructions

This repository is the source of the owner's Pi setup: global instructions, prompts, a skill, extensions
and `pi-relay`. `scripts/install.mjs` copies `agent/` into `~/.pi/agent`, the live setup every Pi session
and relay run uses. A mistake here reaches every project the owner works on.

## Read first

Before substantial work, read what is relevant to the task: your assignment (and the handoff, plan and
decisions it points to), [CONTRIBUTING.md](CONTRIBUTING.md), [README.md](README.md) and, for relay work,
[agent/relay/README.md](agent/relay/README.md).

Precedence, highest first: the owner's explicit decisions; CONTRIBUTING.md and the relay README; existing
conventions; the simplest reversible choice.

## Rules

1. **Edit the checkout, never the live setup.** Change files here, under `agent/`, not in `~/.pi/agent`.
   Do not run `scripts/install.mjs` without `--check` unless the owner asks for an install. Never use
   `--force` or `--pull` on your own initiative.
2. **`agent/AGENTS.md` must not exist.** Anything installed as `~/.pi/agent/AGENTS.md` becomes global
   instructions for every Pi session. Keep `agent/APPEND_SYSTEM.md` and the prompts project-neutral:
   project policy belongs in each project's own instructions.
3. **Implement the approved scope.** A stub, a placeholder success, a swallowed failure or a skipped
   required input is not a finished feature. Missing inputs and failed effects are reported, not ignored.
4. **Keep the boundaries.** The relay reaches the outside world only through its `io` object, and the
   relay owns its protocol while prompts describe role behaviour (CONTRIBUTING.md gives the detail).
   Generated extensions are owned by the tools that install them.
5. **Never weaken acceptance to make a run green:** no deleted, skipped or loosened tests, early returns
   in tests, or fakes that stop exercising the behaviour under test. Fix the cause, or report it.
6. **Do not self-approve behaviour drift.** A change to what the relay, the installer or a prompt means
   for its users (statuses, result fields, Git permissions, what gets installed or overwritten) needs the
   owner's agreement, recorded with the change.
7. **Honest results only.** Report the commands you actually ran and their outcome. A check that could
   not run, such as a relay smoke test without Herdr, is blocked, never passed.

## Autonomy and scope

Work autonomously through safe, in-scope changes, tests and documentation. Choose the smallest complete
change: extend existing mechanisms before creating parallel ones, add modules or abstractions only for a
current requirement, and leave adjacent cleanup out (propose it instead).

Ask the owner (in your result file when working under the relay) only when intent is materially
ambiguous, a choice is hard to reverse, rule 6 applies, an action touches the live setup or anything
outside the repository, credentials are needed, or the request would materially expand scope.

## Verification

- `npm test` during development and before handing back any code change.
- `agent/relay/` changes also need a real relay smoke test, as CONTRIBUTING.md describes, before they
  are reported done. Never run a relay against a real project to test the relay.
- Documentation-only changes need their links, commands and cross-references checked, not the smoke test.

## Git hygiene

- Commit only when your task or assignment allows it. Never amend, rebase, force-push or push without
  explicit authority.
- Stage specific paths and inspect the staged diff before committing. One outcome per commit; the message
  format is in CONTRIBUTING.md.
- Never commit `.agents_work/`, logs, `agent/relay/usage-cache.json`, credentials (`auth.json`) or
  session data.

## Documentation

Update documentation in the same change as the behaviour it describes, in its one home:

| Location | Content |
|---|---|
| `README.md` | What the setup contains and how to install it |
| `CONTRIBUTING.md`, this file | Durable practices and rules |
| `agent/relay/README.md` | Relay usage, files, configuration and code structure |
| `ROADMAP.md` | Improvements considered but not made yet, and what would bring each forward |
| Header comments of `scripts/install.mjs` and `agent/relay/pi-relay.mjs` | Command options and module map |

Keep this file concise: put detail in the closest authoritative document, or enforce it in a test.
