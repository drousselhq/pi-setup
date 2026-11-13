# Pi setup

Personal configuration for the [Pi coding agent](https://github.com/earendil-works/pi): global
instructions, prompt templates, a skill, extensions, and `pi-relay`, a script that drives Pi workers in
Herdr tabs one slice at a time.

This checkout is where the setup is changed and committed. `scripts/install.mjs` copies `agent/` into
`~/.pi/agent`, which every Pi session and relay run uses.

## Contents

| Path | What it is |
|---|---|
| `agent/APPEND_SYSTEM.md` | Instructions appended to every session's system prompt |
| `agent/settings.json`, `agent/models.json` | Pi settings: packages, enabled models, defaults, model overrides |
| `agent/prompts/` | Prompt templates (`/discussion`, `/handoff`, `/plan`, `/implement`, `/review`, `/deep-review`, …); `/advise` and `/council` are used by the relay only |
| `agent/skills/agent-work/` | Conventions for `.agents_work/<topic>/` folders and role records |
| `agent/extensions/` | Herdr agent-state and Moshi notification extensions, plus package settings |
| `agent/relay/` | `pi-relay`: script, role and model configuration, and its [README](agent/relay/README.md) |
| `scripts/install.mjs` | Installs `agent/` into `~/.pi/agent`, refusing to overwrite files changed in place |
| `test/` | Tests (`npm test`) |

## Install

Requires Pi, Node.js 22 or later, and [Herdr](https://herdr.dev) for the relay.

```sh
git clone git@github.com:drousselhq/pi-setup.git ~/Documents/devel/pi-setup
cd ~/Documents/devel/pi-setup
node scripts/install.mjs --check     # what would change
node scripts/install.mjs             # install into ~/.pi/agent
ln -s ~/.pi/agent/relay/pi-relay.mjs ~/.local/bin/pi-relay   # once: put pi-relay on PATH
```

The installer records what it installed in `~/.pi/agent/.pi-setup-install.json`. If an installed file
was changed in place since then (by hand, by an agent, or by Pi itself, which updates `settings.json`),
it installs nothing and shows the difference. Keep the installed version with `--pull FILE` and commit
it, or replace it with `--force FILE`.

Not included:
- **Login:** run `/login` in Pi (stored in `~/.pi/agent/auth.json`).
- **Herdr skill:** `~/.pi/agent/skills/herdr` is a link to `~/.agents/skills/herdr`, installed by Herdr.
  Recreate it with `ln -s ../../../.agents/skills/herdr ~/.pi/agent/skills/herdr`.
- **`pi-quotas`:** `settings.json` loads it from a local checkout (`../../Documents/devel/pi-quotas`,
  relative to `~/.pi/agent`). Clone it there, or change the entry to its npm package.

## Working on it

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT: see [LICENSE](LICENSE).
