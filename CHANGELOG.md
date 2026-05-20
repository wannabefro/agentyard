# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 means the public API may break between minor versions. Pin a commit
or exact version if you depend on this externally.

## [Unreleased]

## [0.1.3] - 2026-05-20

### Added

- `OutputSnapshot.structured?: SessionMessage[]` — optional typed-message
  array for conversation-shaped adapters. `SessionMessage` is
  `{role, text, timestamp?, kind?}`. Additive: `content` is unchanged
  and every existing host keeps working. claude-code now populates
  `structured` directly from transcripts so hosts that want typed
  messages no longer have to re-parse the flat text rendering. aoe and
  other pane-based adapters leave it undefined.

### Performance

- `AdapterRegistry.listAllSessions()` now caches across calls with a
  configurable TTL (default 5000ms, `AGENTYARD_LIST_TTL_MS` override).
  Concurrent calls share one inflight fetch. Write-path tool handlers
  (`create_session`, `start_session`, `stop_session`, `restart_session`,
  `remove_session`) invalidate the cache so the next list is fresh.
  Opt out per call with `listAllSessions("live")`. Local measurement
  with 139 transcripts: 396ms cold → 0.01ms warm.

## [0.1.2] - 2026-05-20

### Fixed

- `serverInfo.version` is now sourced from `package.json` instead of a
  hard-coded literal in `src/index.ts`. Published 0.1.1 still reported
  `0.1.0` over MCP because the literal wasn't bumped; 0.1.2 picks up the
  correct value automatically on every release.

### Changed

- MCP smoke test (`tests/mcp_smoke.ts`) is now portable. It opts into a
  deterministic mock adapter via `AGENTYARD_MOCK=1` so the assertions
  pass on GitHub runners and on any machine without local `aoe` sessions
  or Claude Code transcripts. Production callers don't load the mock.

## [0.1.1] - 2026-05-20

### Fixed

- Published npm package was missing `tsconfig.json`, so the `@/` path alias
  used throughout `src/` failed to resolve and `bunx agentyard` crashed
  immediately with `Cannot find module '@/adapters/aoe/index.ts'`. The
  config is now included in the published files. Discovered by installing
  v0.1.0 from npm in a clean directory.

### Changed

- README documents the npm install path (`bun add -g agentyard`) and the
  matching `claude mcp add` command in addition to the clone-and-run flow.

## [0.1.0] - 2026-05-20

Initial pre-release.

### Added

- Adapter-based MCP orchestrator core: registry, resolver (token filters +
  Fuse.js fuzzy match), and stdio MCP server with 13 tools.
- `aoe` adapter — wraps Agent of Empires 1.7+ via its CLI (`aoe list/show/
  capture/send`). Read + write: snapshots tmux panes, sends input, drives
  loops, manages session lifecycle (create/start/stop/restart/remove).
- `claude-code` adapter — read-only. Walks
  `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`, surfaces each
  transcript as a `Session` with title, working directory, branch, and
  last-activity time. Renders user prompts and assistant text via
  `getOutput`; tolerates unknown record types and truncated trailing lines.
- Loop primitives: `send_then_wait` with prompt-cursor readiness gate and
  echo-verification of sent text. `wait_idle` and `wait_for_ready` MCP tools.
- Adapter contract makes `sendInput`, `waitIdle`, lifecycle methods,
  `sendThenWait`, and `waitForReady` all optional — read-only adapters
  declare what they support and MCP tool routes surface a `not implemented`
  response when a method is missing.
- Research notes for the two adapters: `docs/research/agent-of-empires.md`,
  `docs/research/claude-code.md`. The Conductor.build exploration is parked
  in `docs/research/conductor.md` for a possible later adapter.

[Unreleased]: https://github.com/wannabefro/agentyard/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/wannabefro/agentyard/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/wannabefro/agentyard/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/wannabefro/agentyard/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wannabefro/agentyard/releases/tag/v0.1.0
