# agentyard

> **Pre-1.0 — interfaces are not stable.** Adapter and tool shapes have shifted several times during development and may shift again before the first tagged release. Pin a commit if you depend on this externally.

## What agentyard is

`agentyard` is an adapter-based MCP orchestrator for AI coding agents. It exposes a conversational interface through an MCP host (such as Claude Code): the user asks about "the fender evals" or "the codex session fixing auth", and `agentyard` resolves the reference, dispatches the interaction, and returns the result. The core stays agent-system-agnostic so new platforms land as new adapters, not core changes.

Adapters in this repo:

- **`aoe`** — wraps [Agent of Empires](https://github.com/njbrake/agent-of-empires) (`aoe` 1.7+). Read + write: snapshots tmux panes, sends input, drives loops, manages session lifecycle.
- **`claude-code`** — reads Claude Code session transcripts from `~/.claude/projects/` and writes new turns via `claude --resume`. Surfaces every transcript on disk as a `Session` with title, working directory, branch, and last-activity time. Writes go through `send_then_wait` (synchronous; the underlying CLI is one-subprocess-per-turn). `send_input` is not supported on this adapter — there is no fire-and-forget primitive for Claude Code.

## Install

macOS or Linux. The `aoe` adapter additionally requires the [`aoe` CLI](https://www.agent-of-empires.com) (1.7+). The `claude-code` adapter has no runtime dependencies — it reads transcript files directly.

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

Pin a version with `bunx agentyard@0.1.3` if you don't want the host to silently pick up new releases.

### C. Local checkout (for active development)

```bash
git clone https://github.com/wannabefro/agentyard.git
cd agentyard
bun install
bun link
bun link agentyard
```

`bun link` symlinks your working tree as the global `agentyard` binary so edits to `src/` go live without republishing.

## Register as MCP server in Claude Code

After installing by any of the above paths:

```bash
claude mcp add agentyard -s user -- agentyard
```

`-s user` registers the server in the user-scoped Claude Code config, making `agentyard` available across every Claude Code session on the machine. Restart Claude Code after `claude mcp add` so the host loads the new server.

## Available MCP tools

| Tool | Description |
| --- | --- |
| `list_sessions` | Paginated list of every known session across adapters. Slim by default — `summary` and `raw` are opt-in (`withSummary`, `withRaw`) because a large catalog overflows MCP host token budgets. |
| `resolve_session` | Map a natural-language reference to ranked session candidates with reasons. |
| `get_session` | Fetch full detail for one session, including live status. |
| `get_output` | Read the last N lines of a session's terminal pane. |
| `send_input` | Fire-and-forget send. `ok:true` only means the CLI accepted the send, not that the agent processed it. For guaranteed delivery use `send_then_wait`. |
| `send_then_wait` | Send a message and block until the agent has echoed it and the pane has settled. The canonical loop primitive. |
| `wait_idle` | Poll until output has been unchanged for `idleWindowMs`, or `timeoutMs` elapses. |
| `wait_for_ready` | Poll until the pane's last non-empty line ends with a known prompt cursor (`❯` for Claude Code, `›` for Codex CLI). Use before sending to a freshly-started session. |
| `create_session` | Create a new agent session (e.g. `aoe add`). Returns the new session id and title. |
| `start_session` | Start a stopped agent session. |
| `stop_session` | Stop a running agent session. |
| `restart_session` | Restart a session (stop then start). |
| `remove_session` | Remove a session record, optionally also deleting its worktree and branch. |

### Handling tool results

Every tool returns a single text content block. The shape depends on whether the call succeeded:

- **Success.** `result.isError` is `false` (or absent). `result.content[0].text` is JSON-stringified application data — `JSON.parse` it.
- **Failure.** `result.isError` is `true`. `result.content[0].text` is a plain error string (e.g. `MCP error -32602: Input validation error: ...` from Zod, or the message thrown by an adapter). It is **not** JSON; `JSON.parse` will throw on it.

Clients must branch on `isError` before parsing. The MCP SDK packages both Zod validation errors and adapter throws this way — it's spec-compliant but easy to miss when most success responses look like JSON.

## Quick start

Natural-language queries from the host map onto tool chains the model picks:

- *"What's the status of fender-evals?"* — `resolve_session` then `get_session`.
- *"Tell skill-evals to commit and push."* — `resolve_session` then `send_then_wait`.
- *"Show me what fender-evals is working on."* — `resolve_session` then `get_output`.

## Project layout

```
src/
├── index.ts                # MCP server entry (stdio transport)
├── adapters/
│   ├── types.ts            # Adapter interface — getOutput required; sendInput/waitIdle/lifecycle optional
│   ├── aoe/
│   │   ├── index.ts        # AoeAdapter (read + write)
│   │   ├── cli.ts          # Bun.spawn wrapper for `aoe` JSON commands
│   │   └── schemas.ts      # Zod schemas for aoe's 3 shapes
│   └── claude-code/
│       ├── index.ts        # ClaudeCodeAdapter (read-only transcripts)
│       └── transcripts.ts  # jsonl discovery, parse, summarize, render
├── core/
│   ├── session.ts          # normalized Session type
│   └── registry.ts         # AdapterRegistry
└── resolver/
    └── index.ts            # token-extracted filters + Fuse.js fuzzy match
```

Tests live in `tests/`.

## Local dev

```bash
bun run dev                 # MCP server with file-watch reload
bun test                    # bun:test unit tests
bun run typecheck           # tsc --noEmit
bun run tests/mcp_smoke.ts  # end-to-end MCP JSON-RPC smoke
bun run tests/smoke.ts      # in-process adapter + resolver smoke
```

## Adding an adapter

1. Write `docs/research/<name>.md` first — capture the target system's CLI, HTTP surface, session model, status semantics, and any schema quirks. See [`docs/research/agent-of-empires.md`](docs/research/agent-of-empires.md) and [`docs/research/claude-code.md`](docs/research/claude-code.md) for reference shapes. The "research before writing" rule in [`CLAUDE.md`](CLAUDE.md) exists because guessing endpoints loses time.
2. Implement the `Adapter` interface in [`src/adapters/types.ts`](src/adapters/types.ts) under `src/adapters/<name>/`. Only `name`, `listSessions`, `getSession`, and `getOutput` are required. `sendInput`, `waitIdle`, `sendThenWait`, `waitForReady`, and the lifecycle methods (`createSession`, `startSession`, `stopSession`, `restartSession`, `removeSession`) are all optional — omit any the underlying system doesn't support and the MCP tool routes will surface a `not implemented` response automatically.
3. Register the adapter in [`src/index.ts`](src/index.ts) by adding it to the `AdapterRegistry`.

Keep adapter-specific concerns (idle detection, status mapping, normalization) inside the adapter. If a change to the core is motivated by one adapter's needs, the abstraction is leaking — push the specifics back into the adapter.
