# Agent instructions

This repository is the source of the owner's Pi setup. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
changing anything; it defines the workflow, the relay/prompt protocol rule and the tests.

- Edit files here, under `agent/`, not in `~/.pi/agent`.
- Do not run `scripts/install.mjs` without `--check` unless the owner asks for an install: it changes the
  setup every Pi session and relay run uses. Never use `--force` or `--pull` on your own initiative.
- `agent/AGENTS.md` must not exist: anything installed as `~/.pi/agent/AGENTS.md` becomes global
  instructions for every Pi session.
- `agent/relay/` changes need `npm test` and, before they are reported done, a real relay smoke test as
  CONTRIBUTING.md describes. Do not run a relay against a real project to test the relay.
