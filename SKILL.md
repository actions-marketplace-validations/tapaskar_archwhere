---
name: archwhere
description: Maintain a declared architecture map and place every code change on it. Use when starting work in a repo with arch/architecture.json, when asked "what part of the system is this?", or to scaffold the map in a repo that lacks one.
---

# archwhere — the agent's side of the contract

The humans supervising you read the architecture map, not your diffs. Your job
is to keep the map honest and to place your work on it.

## Before coding
Run `npx archwhere` (or `--base origin/main` on a branch) and state in one line
which components the task touches and their kinds. If any is `security` or a
`watch` pattern fires, follow the repo's review rules before proceeding.

## While coding
- A change that **adds a module** must extend `arch/architecture.json` in the
  same change (globs, and deps if they changed). `npx archwhere check` must pass.
- A change to a **user-visible process** updates the matching entry in `flows`.
- PR titles: `[component] kind: summary`.
- Regenerate the doc when the model changed: `npx archwhere doc --out ARCHITECTURE.md`.

## Scaffolding a repo that has no map
Run `npx archwhere init`, then replace the starter with the real model:
10–20 **declared** components (judgment, not an import graph), each with name,
kind (core/security/feature/infra/product/ops/docs), description, file globs
(`**` crosses directories, `*` stays in one segment; longest match wins), deps,
and `watch` regex patterns for review-sensitive code. Add 2–3 `flows` for the
main user journeys. `npx archwhere check` must pass before you commit.

## Answering threads
Humans open issues labelled `component:<id>` from the mission-control map.
Treat the component named in the label as the scope, read its globs from the
model, investigate, and reply in that issue with findings and the PR you open.
