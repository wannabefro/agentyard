# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project intent

`pepper` is an **orchestrator for AI coding agents**. The end-state interface is conversational — the user says things like *"Can we check the status of the fender evals"* and the orchestrator resolves which underlying agent session that refers to, dispatches the interaction, and returns the result.

### Hard constraints

1. **Adapter-based.** The core must not depend on any specific agent platform. The first adapter targets [Agent of Empires](https://github.com/njbrake/agent-of-empires) (`aoe`), but that is an integration, not a coupling. Adding a new platform means writing an adapter, not modifying the core.
2. **Research before writing.** Before adding code for a new adapter or capability, investigate the target system's actual API/CLI/session model. Don't infer from naming or guess endpoints. Findings live in `docs/research/<adapter>.md` so the next session doesn't redo the work.
3. **External agent loops are a first-class feature.** The orchestrator must be able to drive agent control loops from outside the session — send instruction → wait for the agent to settle → read output → decide next action → send again. This is not "polling for status"; it's programmatic orchestration. The adapter contract must support it.

### Stack decisions

- **Language: TypeScript on Bun.** Chosen because the workload is concurrency-heavy (many independent pollers, idle-detectors, and loop drivers running at once — the canonical Node use case), static types pay rent on adapter schema normalization (each adapter has to flatten multiple shapes — see the `aoe` research notes), and the MCP TypeScript SDK is the reference implementation. Bun gives clean subprocess handling, native TS without a build step, and single-binary builds if needed later. Python was the initial pick but lost on the concurrency-model fit and the opt-in-types tax.
- **Frontend: MCP server.** Conversational surface is provided by the MCP host (Claude Code or another). `pepper` exposes orchestrator capabilities as MCP tools. No bespoke CLI or HTTP frontend unless something forces one.

## Architecture

Three layers, kept narrow:

```
┌───────────────────────────────────────────────┐
│ MCP server                                    │  exposes tools to the host
├───────────────────────────────────────────────┤
│ Core (resolver + loop driver + dispatch)     │  agent-system-agnostic
├───────────────────────────────────────────────┤
│ Adapters (aoe, future systems)               │  each implements one contract
└───────────────────────────────────────────────┘
```

### Adapter contract (draft — verify against first real adapter)

Every adapter implements a stable interface. Initial shape, to be refined when the first adapter lands:

- `list_sessions() -> list[SessionSummary]` — enumerate everything this adapter knows about.
- `get_session(id) -> SessionDetail` — title, group/profile, command, branch/worktree, status, last activity, anything else the underlying system exposes.
- `get_output(id, lines=N, format="text"|"ansi") -> str` — snapshot of the session's terminal pane.
- `send_input(id, text) -> None` — send a message to the running agent.
- `subscribe_events(since=None) -> AsyncIterator[Event]` — optional; falls back to polling when the underlying system has no push surface.
- **Loop primitives** (composed on the above, but adapter-aware because "idle" detection varies):
  - `wait_idle(id, timeout, idle_window)` — block until the pane has been quiet for `idle_window` seconds.
  - `wait_for_pattern(id, regex, timeout)` — block until output matches.
  - `send_then_wait(id, text, predicate)` — atomic send + wait-for-completion-signal.

The loop primitives are the hard part. Different agent systems signal "I'm done thinking" differently (Claude Code shows a prompt, Codex CLI may exit, headless agents may emit a sentinel). Each adapter owns its own "the agent is ready for the next instruction" heuristic.

### Resolver

The resolver maps fuzzy user references ("the fender evals", "the one fixing the auth bug") to concrete `(adapter, session_id)` tuples. Treat this as a **first-class concern** with its own tests, not a side-effect of dispatch.

- Pluggable matchers: branch/worktree path, agent command, group/profile name, fuzzy title, recency.
- LLM as the final tiebreaker, not the first pass — deterministic matchers must run first so the system is debuggable.
- Returns ranked candidates with reasons; the MCP layer decides whether to auto-pick (single high-confidence match), ask the user to disambiguate, or punt.

## First adapter: Agent of Empires (`aoe`)

`aoe` 1.7.0 is installed locally and has 10 live sessions to develop against. The user's `fender-evals` session (id `09c118b3df9f4d53`) is the original spec's worked example.

See [docs/research/agent-of-empires.md](docs/research/agent-of-empires.md) for the full schema and CLI/HTTP reference. Quick summary:

- **Two integration surfaces**: the `aoe` CLI (most read commands have `--json`) and an HTTP API on `aoe serve` (port 7777, bearer-token auth).
- **Read**: `aoe list --json`, `aoe session show <id> --json`, `aoe session capture <id> --json`, `aoe status --json`.
- **Write**: `aoe send <id> <message>` (CLI) or `POST /api/sessions/{id}/send` (HTTP).
- **Event stream**: `aoe cockpit tail --since <seq>` (cockpit-scoped — applicability to regular tmux sessions is still TBD).
- **Schema gotcha**: `aoe list --json`, `aoe session show --json`, and the raw `sessions.json` each expose **different field names** for the same data (e.g. `path` vs `project_path`, `group` vs `group_path`, `worktree` vs `worktree_info`). The adapter must normalize. Only `session show --json` carries `status`; only `list --json` carries `worktree`. Read both, or read `sessions.json` directly for the superset.
- **`agent_session_id`** in `sessions.json` is the *underlying agent's* native session UUID (Claude Code's, Codex's). This is a gift — it lets the orchestrator correlate with the agent's own transcripts (e.g. `~/.claude/projects/<proj>/<uuid>.jsonl`). Worth a dedicated adapter capability.

**Start with the CLI surface, normalized through a single internal `Session` model.** No daemon required. Add HTTP only when remote orchestration is needed.

The resolver's job will be easier than feared: `title` and `worktree.branch` are populated free-text fields that match user references obviously ("fender evals" → title `fender-evals`). Deterministic matchers will cover the common case; LLM fallback is only for ambiguous queries.

## Working principles specific to this repo

- **Keep the core ignorant of any specific agent system.** If a change to the core is motivated by one adapter's needs, the abstraction is leaking — push the specifics back into the adapter.
- **Loop primitives belong to adapters, not the core.** "Idle detection" is unavoidably system-specific. The core orchestrates; it does not interpret terminal output.
- **Resolver matchers are the hardest part** and the most testable. Each matcher gets unit tests against synthetic session catalogs before the resolver gets wired into the MCP layer.
- **Adapters own their own research notes.** Non-obvious findings about a target system's session model, auth flow, or status semantics go in `docs/research/<adapter>.md`. The orchestrator will eventually have several adapters; cross-contaminating notes makes them harder to maintain.

## Commands

```bash
bun install            # install dependencies
bun run start          # start the MCP server on stdio
bun run dev            # start with file-watch reload
bun run typecheck      # tsc --noEmit
bun test               # run bun's built-in test runner
bun run tests/smoke.ts # in-process adapter + resolver smoke
bun run tests/mcp_smoke.ts  # end-to-end MCP JSON-RPC smoke
```

## Layout

```
src/
├── index.ts                # MCP server entry (stdio transport)
├── adapters/
│   ├── types.ts            # Adapter interface (list/get/output/send/waitIdle)
│   └── aoe/
│       ├── index.ts        # AoeAdapter
│       ├── cli.ts          # Bun.spawn wrapper for `aoe` JSON commands
│       └── schemas.ts      # Zod schemas for aoe's 3 shapes
├── core/
│   ├── session.ts          # normalized Session type
│   └── registry.ts         # AdapterRegistry
└── resolver/
    └── index.ts            # token-extracted filters + Fuse.js fuzzy match
```

Tests live in `tests/` (not `src/`) and run directly with `bun run`.

## Decisions still pending

- Persistence of resolver state and session catalog cache (SQLite via `bun:sqlite`? plain JSON? in-memory only?) — current implementation re-fetches from `aoe` on every tool call. Fine for ≤20 sessions; revisit if it becomes a bottleneck.
- Linter/formatter (Biome is the natural pick; not added yet).
- Multi-adapter mode is supported by the registry but only `aoe` is implemented. Future adapters live in `src/adapters/<name>/`.

## Readiness checks

`send_then_wait` has two readiness gates, layered:

1. **Pre-send prompt-cursor check** (`waitForReady`, optional per adapter). Polls `getOutput(id, 30)` until the last non-empty line ends with a known prompt cursor — `❯` for Claude Code, `›` for Codex CLI. Default 30s timeout, controlled by `readyTimeoutMs`. Skipped if the adapter doesn't implement `waitForReady`. The aoe adapter implements it.
2. **Post-send echo verification.** Waits for the (first 30 chars of, whitespace-normalized) sent text to appear in the pane more times than it appeared pre-send. Distinguishes "agent received and rendered the input" from "TUI is just doing its own boot rendering." Short prompts (< 8 chars) fall back to plain change detection.

Combined effect: sends to a not-yet-booted TUI now fail with `agent not ready (prompt cursor not detected...)`; sends to a TUI that's at the prompt but somehow swallows the input fail with `sent text did not appear in pane...`. The two failure modes are reported distinctly so the host can branch.

`aoe` status transitions (`idle → running → idle`) remain on the table as a third signal if needed — see [docs/research/agent-of-empires.md](docs/research/agent-of-empires.md).

## Related external context

The user's global `~/.claude/CLAUDE.md` and `~/.claude/rules/` already cover general workflow, verification, commit, and delegation rules. This file is for `pepper`-specific guidance only.
