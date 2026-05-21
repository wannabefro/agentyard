# agentyard

> **Pre-1.0 — interfaces are not stable.** Adapter and tool shapes have shifted several times across releases and may shift again before 1.0. Pin an exact version (e.g. `agentyard@0.4.0`) if you depend on this externally. See [`CHANGELOG.md`](CHANGELOG.md) for what's changed.

## What agentyard is

`agentyard` is an adapter-based MCP orchestrator for AI coding agents. It exposes a conversational interface through an MCP host (such as Claude Code): the user asks about "the fender evals" or "the codex session fixing auth", and `agentyard` resolves the reference, dispatches the interaction, and returns the result. The core stays agent-system-agnostic so new platforms land as new adapters, not core changes.

Adapters in this repo:

- **`aoe`** — wraps [Agent of Empires](https://github.com/njbrake/agent-of-empires) (`aoe` 1.7+). Read + write: snapshots tmux panes, sends input, drives loops, manages session lifecycle.
- **`claude-code`** — reads Claude Code session transcripts from `~/.claude/projects/` and writes new turns via `claude --resume`. Surfaces every transcript on disk as a `Session` with title, working directory, branch, and last-activity time. Writes go through `send_then_wait` (synchronous; the underlying CLI is one-subprocess-per-turn). `send_input` is not supported on this adapter — there is no fire-and-forget primitive for Claude Code.
- **`codex`** — reads Codex CLI sessions from `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and writes new turns via `codex exec resume`. Like `claude-code`, the write path is synchronous (one subprocess per turn); `send_input` is not supported. See [`docs/research/codex.md`](docs/research/codex.md) for the JSONL schema and write contract.

Hosts supported (the MCP clients that consume agentyard):

- **Claude Code** (CLI, desktop, IDE extensions) — the original target. All tools work directly.
- **Codex CLI** — works in both the TUI (`codex`) and non-interactive mode (`codex exec`). Codex 0.132 has a quirk in `exec` mode: it cancels MCP tool calls not annotated `readOnlyHint: true`. agentyard's tools self-declare honestly, so read tools work from `exec`; write tools (`chat`, `send_then_wait`, lifecycle) work from the TUI via approval prompts. See [`docs/integrations/codex-host.md`](docs/integrations/codex-host.md) for the full diagnosis and registration recipe.

## Install

macOS or Linux. The `aoe` adapter additionally requires the [`aoe` CLI](https://www.agent-of-empires.com) (1.7+). The `claude-code` adapter reads transcript files directly but needs the `claude` CLI on PATH for the write path. The `codex` adapter reads `~/.codex/sessions/` directly and needs the `codex` CLI on PATH for the write path.

Pick one path:

### A. No Bun on the machine — single binary

GitHub Releases ships standalone executables for macOS and Linux (arm64 and x64). The Bun runtime is embedded; nothing else to install.

```bash
# macOS Apple Silicon — pick the matching asset for your platform
curl -L https://github.com/wannabefro/agentyard/releases/latest/download/agentyard-darwin-arm64 -o /usr/local/bin/agentyard
chmod +x /usr/local/bin/agentyard
```

Other platforms: replace `darwin-arm64` with `darwin-x64`, `linux-arm64`, or `linux-x64`.

### B. Bun installed — zero-install via bunx

```bash
claude mcp add agentyard -s user -- bunx agentyard
```

Pin a version with `bunx agentyard@0.4.0` if you don't want the host to silently pick up new releases.

### C. Local checkout (for active development)

```bash
git clone https://github.com/wannabefro/agentyard.git
cd agentyard
bun install
bun link
bun link agentyard
```

`bun link` symlinks your working tree as the global `agentyard` binary so edits to `src/` go live without republishing.

## Register as an MCP server

### Claude Code

After installing by any of the above paths:

```bash
claude mcp add agentyard -s user -- agentyard
```

`-s user` registers the server in the user-scoped Claude Code config, making `agentyard` available across every Claude Code session on the machine. Restart Claude Code after `claude mcp add` so the host loads the new server.

### Codex CLI

```bash
codex mcp add agentyard -- agentyard
```

That writes a `[mcp_servers.agentyard]` block to `~/.codex/config.toml`. Confirm with `codex mcp get agentyard`. In the Codex TUI all tools work; in `codex exec` only the six read tools (`list_sessions`, `resolve_session`, `get_session`, `get_output`, `wait_idle`, `wait_for_ready`) are callable — see [`docs/integrations/codex-host.md`](docs/integrations/codex-host.md) for why.

## Available MCP tools

Sixteen tools across discovery, selection, conversation, and lifecycle. The
selection tools (`switch_session`, `select_session`, `chat`) are the
conversational shorthand — they let the host carry a "current session"
pointer across calls so you can `chat("…")` without re-passing
`(adapter, id)` every turn. The pointer persists to `~/.agentyard/state.json`
and survives `/mcp` reconnects.

| Tool | Description |
| --- | --- |
| `list_sessions` | Paginated list of every known session across adapters. Slim by default — `summary` and `raw` are opt-in (`withSummary`, `withRaw`) because a large catalog overflows MCP host token budgets. |
| `resolve_session` | Map a natural-language reference to ranked session candidates with reasons. |
| `switch_session` | One-call resolve + pin: takes a free-text query, picks the top candidate, and pins it as the current selection. Refuses ambiguous queries (top must be 1.3× higher-scoring than runner-up) unless `force=true`. |
| `select_session` | Pin/clear/read the current selection by exact `(adapter, id)`. Pass no args to read; pass `{adapter, id}` to set; pass `{clear: true}` to drop. |
| `get_session` | Fetch full detail for one session, including live status. |
| `get_output` | Read the last N lines of a session's terminal pane. |
| `chat` | Minimal shorthand: `send_then_wait` against the current selection, returns just `{ok, adapter, id, response, elapsedMs, warnings?}`. On failure also returns `lastLine` (last visible pane line) and `hint` (one-line next-step suggestion). |
| `send_input` | Fire-and-forget send. `ok:true` only means the CLI accepted the send, not that the agent processed it. For guaranteed delivery use `send_then_wait`. |
| `send_then_wait` | Send a message and block until the agent has echoed it and the pane has settled. The canonical loop primitive. Returns full before/after snapshots; on failure also carries `adapter`, `id`, `hint`. |
| `wait_idle` | Poll until output has been unchanged for `idleWindowMs`, or `timeoutMs` elapses. |
| `wait_for_ready` | Poll until the pane's last non-empty line ends with a known prompt cursor (`❯` for Claude Code, `›` for Codex CLI). Use before sending to a freshly-started session. |
| `create_session` | Create a new agent session (e.g. `aoe add`). Returns the new session id and title; auto-selects the new session. |
| `start_session` | Start a stopped agent session. |
| `stop_session` | Stop a running agent session. |
| `restart_session` | Restart a session (stop then start). |
| `remove_session` | Remove a session record, optionally also deleting its worktree and branch. Destructive. |

Tools that act on a session (`get_session`, `get_output`, `chat`,
`send_then_wait`, `send_input`, `wait_idle`, `wait_for_ready`, lifecycle ops)
accept optional `adapter`/`id` arguments. When both are omitted they fall
back to the current selection. If the selection has gone stale (the session
was removed externally), it's auto-cleared on the next call and the host
gets a clear error pointing at `switch_session` / `select_session`.

### Handling tool results

Every tool returns a single text content block. The shape depends on whether the call succeeded:

- **Success.** `result.isError` is `false` (or absent). `result.content[0].text` is JSON-stringified application data — `JSON.parse` it.
- **Failure.** `result.isError` is `true`. `result.content[0].text` is a plain error string (e.g. `MCP error -32602: Input validation error: ...` from Zod, or the message thrown by an adapter). It is **not** JSON; `JSON.parse` will throw on it.

Clients must branch on `isError` before parsing. The MCP SDK packages both Zod validation errors and adapter throws this way — it's spec-compliant but easy to miss when most success responses look like JSON.

## Quick start

Natural-language queries from the host map onto tool chains the model picks. With the conversational shorthand:

- *"Switch to fender-evals."* — `switch_session({query: "fender evals"})` pins it; subsequent calls don't re-resolve.
- *"What's it doing?"* — `get_output()` (no args) reads the pinned session's pane.
- *"Tell it to commit and push."* — `chat({text: "commit and push"})` sends to the pinned session and waits for a reply.
- *"What's the status of skill-evals?"* — `resolve_session` then `get_session` for one-off lookups.

When `chat` fails (busy session, prompt-cursor missing, ownership conflict), the response includes `lastLine` (what's on screen) and `hint` (which tool to try next) so the host LLM can recover instead of giving up.

## Project layout

```
src/
├── index.ts                # MCP server entry (stdio transport), 16 tool registrations
├── adapters/
│   ├── types.ts            # Adapter interface — getOutput required; sendInput/waitIdle/lifecycle optional
│   ├── aoe/
│   │   ├── index.ts        # AoeAdapter (read + write, tmux-pane-based)
│   │   ├── cli.ts          # Bun.spawn wrapper for `aoe` JSON commands
│   │   └── schemas.ts      # Zod schemas for aoe's 3 response shapes
│   ├── claude-code/
│   │   ├── index.ts        # ClaudeCodeAdapter (transcript-based, `claude --resume` write)
│   │   └── transcripts.ts  # jsonl discovery, parse, summarize, render
│   ├── codex/
│   │   ├── index.ts        # CodexAdapter (transcript-based, `codex exec resume` write)
│   │   └── rollouts.ts     # ~/.codex/sessions/ walk, lenient jsonl parse
│   └── mock/
│       └── index.ts        # deterministic adapter behind AGENTYARD_MOCK=1 for smoke tests
├── core/
│   ├── session.ts          # normalized Session type
│   ├── registry.ts         # AdapterRegistry (with TTL-cached listAllSessions)
│   ├── selection.ts        # SelectionStore — persistent current-session pointer (~/.agentyard/state.json)
│   ├── ownership.ts        # cross-adapter ownership preflight (refuses concurrent writes)
│   ├── spawn_env.ts        # findBinary + augmented PATH for host-launched MCP subprocesses
│   └── loop.ts             # sendThenWait core: readiness gate, echo verification, idle wait
└── resolver/
    └── index.ts            # token-extracted filters + Fuse.js fuzzy match
```

Tests live in `tests/`. `bun test` runs the unit suite (`*.test.ts`); the
`live_dogfood_*.ts` scripts are manual probes against real external state
(your `~/.claude/`, `~/.codex/`, running `aoe` sessions).

## Local dev

```bash
bun run dev                 # MCP server with file-watch reload
bun test                    # bun:test unit tests
bun run typecheck           # tsc --noEmit
bun run tests/mcp_smoke.ts  # end-to-end MCP JSON-RPC smoke
bun run tests/smoke.ts      # in-process adapter + resolver smoke
```

## Adding an adapter

1. Write `docs/research/<name>.md` first — capture the target system's CLI, HTTP surface, session model, status semantics, and any schema quirks. See [`docs/research/agent-of-empires.md`](docs/research/agent-of-empires.md), [`docs/research/claude-code.md`](docs/research/claude-code.md), and [`docs/research/codex.md`](docs/research/codex.md) for reference shapes. The "research before writing" rule in [`CLAUDE.md`](CLAUDE.md) exists because guessing endpoints loses time.
2. Implement the `Adapter` interface in [`src/adapters/types.ts`](src/adapters/types.ts) under `src/adapters/<name>/`. Only `name`, `listSessions`, `getSession`, and `getOutput` are required. `sendInput`, `waitIdle`, `sendThenWait`, `waitForReady`, and the lifecycle methods (`createSession`, `startSession`, `stopSession`, `restartSession`, `removeSession`) are all optional — omit any the underlying system doesn't support and the MCP tool routes will surface a `not implemented` response automatically.
3. Register the adapter in [`src/index.ts`](src/index.ts) by adding it to the `AdapterRegistry`.

Keep adapter-specific concerns (idle detection, status mapping, normalization) inside the adapter. If a change to the core is motivated by one adapter's needs, the abstraction is leaking — push the specifics back into the adapter.
