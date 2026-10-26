# Contributing

## Workflow

1. Change files in this checkout, never in `~/.pi/agent`: that directory is the live install, used by
   every Pi session and every relay run.
2. Run `npm test`.
3. For relay changes, also run a real smoke test (below).
4. Commit. Messages: a short subject, then one `-` bullet per real change.
5. Install with `node scripts/install.mjs` when the change should take effect. Installing is the release
   step; check first with `--check`. A relay that is already running keeps the code it started with.

If the installer reports a drifted file, decide which version is right: `--pull FILE` copies the
installed version into the checkout (then commit it); `--force FILE` replaces it with the checkout's.

## Prompts and the relay

The prompts in `agent/prompts/` serve both standalone use (`/implement`, `/review`, …) and relay workers.
The relay owns its protocol: statuses, result-file fields and the advisor's brief and decision. It writes
that protocol into every assignment. Prompts describe role behaviour and refer to "the result format"
rather than restating fields. A protocol change touches the relay and the prompts together, in one commit.

## Tests

- `npm test` runs every `test/*.test.mjs` with Node's built-in test runner. No dependencies.
- Relay smoke test: run `pi-relay` for real on a throwaway Git repository with cheap models (a
  `relay.json` overriding every role, quota pacing off), inside Herdr, and drive the owner's answers
  through the advisor's tab. Give each concurrent test run its own topic name: Herdr agent names are
  derived from the topic. Delete the throwaway repositories and close their tabs afterwards.
