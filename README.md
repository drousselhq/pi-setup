# Pi setup

Personal configuration for the [Pi coding agent](https://github.com/earendil-works/pi):
global instructions, prompt templates, a skill, extensions, and `pi-relay`, a script that drives Pi
workers in Herdr tabs one slice at a time.

This repository is the `~/.pi/agent` directory itself. A `.gitignore` allowlist keeps logins,
sessions, caches and downloaded tools out of Git.

## Contents

| Path | What it is |
|---|---|
| `APPEND_SYSTEM.md` | Instructions appended to every session's system prompt |
| `settings.json`, `models.json` | Pi settings: packages, enabled models, defaults, model overrides |
| `prompts/` | Prompt templates (`/plan`, `/implement`, `/review`, `/handoff`, `/advise`, …) |
| `skills/agent-work/` | Conventions for `.agents_work/<topic>/` folders and role records |
| `extensions/` | Herdr agent-state and Moshi notification extensions, plus package settings |
| `relay/` | `pi-relay`: script, role and model configuration, and its [README](relay/README.md) |

## Install on another machine

Requires Pi, Node.js, and [Herdr](https://herdr.dev) for the relay.

```sh
# with no existing ~/.pi/agent:
git clone git@github.com:drousselhq/pi-setup.git ~/.pi/agent

# or into an existing one:
cd ~/.pi/agent && git init && git remote add origin git@github.com:drousselhq/pi-setup.git \
  && git fetch && git checkout -f -t origin/main

ln -s ~/.pi/agent/relay/pi-relay.mjs ~/.local/bin/pi-relay   # put pi-relay on PATH
pi                                                         # then log in with /login
```

Not included:
- **Login:** run `/login` in Pi (stored in `auth.json`, never committed).
- **Herdr skill:** `skills/herdr` is a link to `~/.agents/skills/herdr`, installed by Herdr.
  Recreate it with `ln -s ../../../.agents/skills/herdr ~/.pi/agent/skills/herdr`.
- **`pi-quotas`:** `settings.json` loads it from a local checkout (`../../Documents/devel/pi-quotas`).
  Clone it there, or change the entry to its npm package.
