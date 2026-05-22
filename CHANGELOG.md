# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 means the public API may break between minor versions. Pin a commit
or exact version if you depend on this externally.

## [Unreleased]

## [0.4.1] - 2026-05-22

### Documentation

- README refreshed to reflect v0.4.0 reality: codex adapter and Codex
  CLI host (TUI + exec) added to the supported lists; the conversational
  shorthand tools (`switch_session`, `select_session`, `chat`) and the
  persistent `~/.agentyard/state.json` pointer they share are
  documented; the enriched `chat` / `send_then_wait` failure shape
  (`adapter`, `id`, `lastLine`, `hint`) is called out; quick-start
  examples use the shorthand; project layout reflects the current tree
  (codex adapter, mock, `core/{selection,ownership,spawn_env,loop}`).
  Version-pin example bumped 0.1.3 → 0.4.0.

No code changes.

## [0.4.0] - 2026-05-21

### Added

- **Codex CLI host support.** Every registered tool now carries
  `annotations` (readOnlyHint plus accurate destructive/idempotent/
  openWorld hints). Codex 0.132 in non-interactive `codex exec` mode
  silently cancels MCP tool calls whose tools aren't annotated
  `readOnlyHint: true` — without this fix every agentyard call from
  Codex returned "user cancelled MCP tool call" before `tools/call` was
  even sent. After: read tools (`list_sessions`, `resolve_session`,
  `get_session`, `get_output`, `wait_idle`, `wait_for_ready`) work in
  `codex exec`; write tools surface honest approval prompts in the
  Codex TUI.

- **`docs/integrations/codex-host.md`** — registration recipe for
  Codex (`codex mcp add ...`), what works, what doesn't, and the full
  diagnosis trail behind the `readOnlyHint` quirk so the next person
  doesn't relive the bisection.

- **Enriched `chat` and `send_then_wait` failure responses.** Failures
  now also include `adapter`, `id`, `lastLine` (last non-empty pane
  line — reveals selector menus, approval gates, partial prompts), and
  `hint` (one-line next-step suggestion mapped from the failure reason
  — busy session → wait_idle, no selection → switch_session, ownership
  conflict → switch adapters, etc.). `chat` success now also returns
  `{adapter, id}` so multi-turn loops can correlate replies with
  sessions without a separate `select_session` read.

### Tests

- New `tests/live_dogfood_codex_host.ts` regression check spawns the
  MCP server stdio-style and asserts every tool declares
  `annotations.readOnlyHint`. Fails fast if a future tool registration
  drops the annotation.
- `tests/mcp_smoke.ts` grows assertions on the new `adapter`/`id`/
  `hint` fields in chat failure responses.

## [0.3.0] - 2026-05-20

### Added

- **`claude-code` adapter now supports writes.** `ClaudeCodeAdapter`
  implements `sendThenWait` by spawning `claude --resume <id> --print
  --output-format json <text>` from the session's recorded cwd,
  appending one agent turn to the transcript, and returning before/after
  snapshots. Hosts can now drive Claude Code sessions through the MCP
  layer the same way they drive aoe sessions, with the same return
  shape. See `docs/research/claude-code.md` (Write support section) for
  the empirical findings that informed the contract — notably the
  cwd-dependency of `--resume`, the JSON output schema, and the per-turn
  cache-creation cost (~$0.35/turn at the current default model, since
  there is no warm prompt cache across fresh subprocess invocations).

### Notes on the claude-code write contract

- `sendInput` is intentionally NOT implemented on claude-code. The
  underlying CLI is fundamentally synchronous (one subprocess = one full
  agent turn); a fire-and-forget claim would be the same kind of
  misleading contract `send_input("")` was in 0.2.0. Hosts that need
  fire-and-forget use aoe; hosts that need guaranteed delivery use
  `sendThenWait` on either adapter.
- `waitIdle` / `waitForReady` remain omitted — not applicable to a
  spawn-per-turn model with no terminal pane.
- Lifecycle ops (`create/start/stop/restart/remove`) remain omitted;
  no orchestrator use case has surfaced yet.

### Tests

- 4 new unit tests for `parseClaudePrintResult` (the brittle bit of the
  write path — Claude Code's JSON stdout schema).
- New live dogfood probe `tests/live_dogfood_claude_code_write.ts` —
  resumes a real transcript, sends a new prompt, observes the agent's
  response appended.

## [0.2.1] - 2026-05-20

### Fixed

- **`send_input("")` actually delivers a bare Enter.** 0.2.0's schema
  description claimed it would; aoe's CLI hard-rejects empty messages
  with `Error: Message cannot be empty`, so the promise was a lie. Empty
  text now bypasses `aoe send` and pushes `C-m` through `tmux send-keys`
  on the session's tmux pane (located by id-prefix match against aoe's
  `aoe_<title>_<id[:8]>` naming). Verified live: dismisses the Claude
  Code trust prompt cleanly in ~20ms.
- **`waitForReady` returns an actionable reason when a selector menu is
  detected.** Previously the rejected-menu case fell through to the
  generic "prompt cursor not detected within Xms" message — true but
  unhelpful. Now: "agent showing a selector menu; dismiss it (e.g.
  send_input("") for default, or send_input("<digit>") for a specific
  option) before sending text" — and `lastLine` points at the menu
  cursor.
- **`sendThenWait` preserves `waitForReady`'s contextual reason.** The
  loop primitive was dropping `ready.reason` and substituting a generic
  string; MCP hosts calling `send_then_wait` against a menu pane lost
  the actionable hint. The adapter's reason now propagates upward.

### Tests

- New live dogfood probes (committed, not part of `bun test`):
  `tests/live_dogfood_bare_enter.ts`,
  `tests/live_dogfood_multi_turn.ts`. The multi-turn probe drives a
  throwaway aoe Claude Code session through three sequential
  `sendThenWait` calls and verifies each turn produces a distinct token
  — the canonical orchestrator use case, end-to-end (~7.6s/turn).

## [0.2.0] - 2026-05-20

### Changed (breaking, pre-1.0)

- **`list_sessions` MCP tool now returns a slim, paginated response.**
  Default catalog dump overflowed Claude Code's tool-output budget
  (149 aoe sessions → 187 KB). New shape:
  `{ total, offset, limit, returned, sessions }` — `count` is gone
  (replaced by `total`). Each session in the response omits `summary`
  and `raw` by default. New input params: `withSummary` (default false,
  opt in to populate per-session content summaries — adds one aoe
  capture per session), `withRaw` (default false, adapter-native
  payloads), `limit` (default 50, max 500), `offset` (default 0).
  `resolve_session` internally requests `withSummary: true` so content
  matching keeps working.
- **`Adapter.listSessions` now accepts an optional `ListSessionsOptions`
  arg.** Existing no-arg callers continue to work; the `AoeAdapter`
  uses it to skip the per-session capture when summaries aren't
  requested.
- **`AdapterRegistry` now caches slim and full listings in separate
  buckets.** A slim `list_sessions` call no longer poisons the full
  listing that `resolve_session` relies on, and vice versa.
- **`waitForReady` no longer reports ready=true on a selector menu.**
  Previously the 0.1.5 lenient cursor scan matched any `❯ <text>` line,
  including the first-boot trust prompt's `❯ 1. Yes, I trust this folder`.
  Cursor lines that look like menu options (`❯ N. <text>`) are now
  rejected when corroborated by a peer numbered option or a navigation
  hint (`Enter to confirm`, `Esc to cancel`, `↑/↓`). Callers must dismiss
  selector menus (e.g. `send_input("1")` or a bare Enter via the relaxed
  schema) before `waitForReady` returns success. The change keeps the
  happy-path same-tick fast — the live concurrent-lifecycle dogfood
  reports the same 1.63s wall time as before.

### Fixed

- **Concurrent aoe lifecycle calls (`createSession`, `startSession`,
  `stopSession`, `restartSession`, `removeSession`) now serialize
  adapter-wide.** Phase-3 dogfood observed `Promise.all([setupA, setupB])`
  failing exit 1 — aoe's sessions.json + tmux state collides under
  concurrent mutation. The previous workaround was to serialize at the
  call site; the adapter now does it internally via a single promise-chain
  lock, so MCP hosts can safely `Promise.all` lifecycle calls across
  distinct session ids. Read paths (list/show/capture/send) remain
  parallel.

### Changed

- **`send_input.text` now accepts empty strings** (`min(0)` instead of
  `min(1)`). Lets callers send a bare Enter to confirm default selections
  in TUI prompts (e.g. Claude Code's first-run trust prompt). Non-empty
  text still works unchanged.
- **`send_input` MCP tool description is honest about its contract.**
  `ok: true` only means the CLI accepted the send, not that the agent
  processed it. Against sessions aoe classifies as `error` / `stopped`,
  the auto-revive race can leave keystrokes staged but unsubmitted. For
  guaranteed delivery, callers should prefer `send_then_wait`, which
  polls the pane for evidence the agent saw the input.

### Documentation

- README has a "Handling tool results" section documenting MCP `isError`
  semantics — clients must check `result.isError === true` before
  attempting `JSON.parse` on the content text. The MCP SDK packages both
  Zod validation errors and adapter throws as text content with the
  `isError` flag.

### Tests

- New live-dogfood probes (committed, not part of `bun test`):
  `tests/live_dogfood_concurrent_lifecycle.ts`,
  `tests/live_dogfood_send_semantics.ts`,
  `tests/live_dogfood_delete_worktree.ts`,
  `tests/live_dogfood_active_transcript.ts`. New profile harness:
  `tests/resolver_perf.ts` characterizes resolver scaling at 150 / 500 /
  1000 synthetic sessions.

## [0.1.5] - 2026-05-20

### Fixed

- **aoe `waitForReady` against current Claude Code TUI.** Previous heuristic
  ("last non-empty line ends with `❯`") missed v2.1+ Claude Code, which
  renders a multi-line status footer below the input cursor (model name,
  context %, MCP status). The check now scans up to 20 recent non-empty
  lines for a cursor at line-start, which also catches selector menus
  (first-run trust prompt sat on the "Yes, I trust" option line with
  "Enter to confirm" below). Fixture-based tests cover real pane shapes.
- **`AoeAdapter.getOutput` graceful "session not found".** Previously threw
  a CLI error that propagated to the MCP layer as a raw text isError;
  inconsistent with `getSession` (returns structured `{ error: ... }`)
  and with claude-code's `getOutput` (returns empty snapshot). Now returns
  `{ content: "", lines: 0 }` when the underlying aoe CLI reports session
  not found. Loop primitives that call `getOutput` in polling loops can
  no longer abort if the session disappears mid-flight.
- **`AoeCliError` message now includes a stderr excerpt.** Dogfood caught
  concurrent `aoe session start` failures whose actual reason was
  invisible — only the exit-code text propagated. The error message now
  carries the first three lines of stderr (capped at 240 chars). Full
  stderr remains on `.stderr` for programmatic callers.

### Changed

- **`sendThenWait` is now safe to call concurrently** on the same
  `(adapter, id)` — calls serialize via a per-session promise chain.
  Previously two callers polling the same pane could each be misled by
  the other's settlement signal. Cross-session concurrency (different
  sessions) is unchanged and runs in parallel as before. A failed call
  does not poison the lock for subsequent callers.

## [0.1.4] - 2026-05-20

### Added

- Resolver: recency weighting. Status-based bonus (`running` +0.5,
  `waiting` +0.3, `idle` +0.1) works for every adapter without needing
  timestamps. When `lastActivityAt` is populated (claude-code adapter),
  a continuous time-decay bonus stacks on top (`< 1h` +0.4, `< 24h`
  +0.2, `< 7d` +0.1). Combined max ~0.9 — small enough that recency
  breaks ties and lifts close-call candidates without inventing matches
  from nothing. Reasons surface the bonus ("idle now", "active 6h ago")
  so ranking is debuggable.
- `Session.summary` — optional short text snapshot of what each session is
  working on. Lets the resolver match queries against pane content (aoe) or
  the most recent user prompt (claude-code), not just title / branch
  metadata. aoe sessions with codename titles (e.g. `404-mt`, `Tatars`) are
  now findable by what they're doing.
  - **aoe**: populated during `listSessions` via parallel
    `aoe session capture --strip-ansi -n 120`, condensed to ≤ 1500 chars.
    Failures are tolerated — sessions in error state often have no
    capturable pane.
  - **claude-code**: populated from `lastPrompt` in the transcript
    summary (free — already computed).
- Resolver: `summary` is now a search field. Substring match (weight 3 —
  equal to title to let summary out-rank partial title hits) and Fuse
  fuzzy match (weight 1) both contribute. Reasons include
  `summary contains N% of query tokens`.
- Resolver: substring matchers now do lightweight stem-aware containment
  so "tests" finds "test", "failing" finds "fail", etc. Prevents
  query / pane plural/verb mismatch from missing real hits. Length > 3
  guard avoids over-matching short tokens.

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

[Unreleased]: https://github.com/wannabefro/agentyard/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/wannabefro/agentyard/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/wannabefro/agentyard/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/wannabefro/agentyard/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/wannabefro/agentyard/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/wannabefro/agentyard/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wannabefro/agentyard/releases/tag/v0.1.0
