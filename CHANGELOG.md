# Changelog

## 1.0.0 — 2026-11-04

The first major release. The CLI commands, the `architecture.json` model and the GitHub Action
inputs are now stable: from here, a breaking change to any of them means a new major version.
Nothing breaks when upgrading from 0.3.0.

### Added
- **System flow lens** in mission control: the Mermaid system map, with components that have an
  open PR highlighted, and every process flow as a sequence diagram, in the same page as the
  attention rail. Mermaid 11.4.1 loads from jsDelivr only when the lens opens, pinned by SHA-384,
  in strict mode. Needs network access for that one file.
- `GET /api/system-flow`, read-only. It still answers without GitHub, with no PRs highlighted.
- `flowDiagram()` and `systemFlow()` in `lib/where.js`, `touchedComponents()` in `lib/rail.js`.

## 0.3.0 — 2026-11-03

### Added
- **Several agents on the board.** Configure them with `AGENT_MENTIONS="Claude=@claude,Kiro=@kiro"`
  or `agents: [{ name, mention }]` in `arch/mission.config.json`. `/api/model` now returns `agents`.
  `AGENT_MENTION` and `agentMention` still work as the single default agent.
- **Ask: selector** in mission control, next to Send: each agent, plus Both or All. It remembers
  the last choice and is hidden when there is only one agent.
- **A typed mention wins.** If a message already names any known agent, nothing is appended.
- **Reply tags.** Thread messages show which agent replied: a bot login, or the bridge header.
- **`archwhere bridge`** (`lib/bridge.js`) lets a local CLI agent such as `kiro-cli` answer board
  threads. It has an allow-list (repo owner plus `--allow`; bots and its own replies are ignored),
  runs one job at a time, keeps a persisted cursor and seen-set, uses `execFile` with an argument
  array, enforces a timeout, strips ANSI codes, caps replies at about 60k characters, posts a note
  on failure, and supports `--once`. It refuses `--trust-all-tools`.
- `examples/kiro/archwhere-readonly.json`: a Kiro agent config that exposes only `fs_read`.

### Changed
- The GitHub client moved into `lib/gh.js`, shared by mission control and the bridge. Behaviour is
  unchanged: `GITHUB_TOKEN`, else `gh auth token`, and `GITHUB_API` overrides the base URL.

## 0.2.1
- Live thread replies and a component details card in mission control.

## 0.2.0
- `init --infer`, `check --fix` with patch suggestions, and the change-heat lens.
