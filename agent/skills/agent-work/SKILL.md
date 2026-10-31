---
name: agent-work
description: Conventions for .agents_work topic folders and role artifacts (handoff, plan, scout, architecture, implementation, review, docs). Use for named work, handoffs, role prompts and relay assignments; not for orchestration or approval.
---
# Agent work

Shared artifact conventions. Role prompts define the job; project instructions (AGENTS.md,
CONTRIBUTING.md) define engineering rules. Do not delegate to other agents or start another
role's work unless explicitly asked.

## Resolve the work

- Work in the current project checkout, not `~/.pi`.
- Topic folder: `.agents_work/<topic>/`. Reuse existing names exactly. For new work use the
  operator's name or a short kebab-case name (1–3 words). A topic is one path component;
  `archives` is reserved. Ask when the topic is ambiguous.
- In a relay assignment, the assignment file gives the topic, slice and artifact paths. Follow it.
- Missing artifacts are not prerequisites. Create only what your task needs.

## Artifacts

`.agents_work/` is local and Git-ignored: never commit or force-add it. If it is not ignored,
ask once for a local exclusion (`.git/info/exclude`) instead of editing tracked files.

| File | Content |
|---|---|
| `handoff.md` | agreed intent, scope, acceptance, authority |
| `plan.md` | relay slices (`## S1: title`, `Needs:`, `Acceptance:`) |
| `decisions.md` | decisions for this work, by the owner or the relay's advisory council (written by the relay); read before asking anything already settled |
| `slices/<id>/scout.md`, `architecture.md`, `implementation.md`, `review.md` | per-slice role records in relay runs |
| `scout.md`, `architecture.md`, `spec.md`, `docs.md`, … | the same records when used standalone |
| `evidence/` | useful raw output or reproductions |
| `relay/` | owned by the pi-relay script: do not edit |

Artifacts do not override operator decisions or project documents. Verify consequential claims
against the code; other agents' reports are leads.

## Trackers

Follow the project's own instructions for its tracker (Beads, plan files or none). Read your
ticket when one is named. Do not create, claim, close or edit tickets unless your assignment
explicitly allows that update; otherwise write proposed updates in your artifact.

## Write for the next reader

- Keep each artifact a current account: result first, open issues next, then evidence. Replace
  superseded text; keep finding IDs and important failed results.
- Use concrete paths, symbols and commands. Distinguish what you ran, inspected, inferred or did
  not verify. Name the candidate (commits and/or uncommitted changes) when relevant.
- Plain sentences, no dense abbreviations, no transcripts. Link evidence instead of copying it.
- In chat, give the artifact path, a short outcome and material limits.

## Archives

Never list, search or read `.agents_work/archives/` unless the operator explicitly asks for
historical work. Archive only on explicit request: show the exact move to
`.agents_work/archives/YYYY-MM-DD/<topic>/` and get confirmation first. Never delete work.
