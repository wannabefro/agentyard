# agentyard

> **Pre-1.0 — interfaces are not stable.** Adapter and tool shapes have shifted several times during development and may shift again before the first tagged release. Pin a commit if you depend on this externally.

## What agentyard is

`agentyard` is an adapter-based MCP orchestrator for AI coding agents. It exposes a conversational interface through an MCP host (such as Claude Code): the user asks about "the fender evals" or "the codex session fixing auth", and `agentyard` resolves the reference, dispatches the interaction, and returns the result. The core stays agent-system-agnostic so new platforms land as new adapters, not core changes.

Adapters in this repo:

- **`aoe`** — wraps [Agent of Empires](https://github.com/njbrake/agent-of-empires) (`aoe` 1.7+). Read + write: snapshots tmux panes, sends input, drives loops, manages session lifecycle.
- **`claude-code`** — reads Claude Code session transcripts from `~/.claude/projects/`. Read-only at v0.1; surfaces every transcript on disk as a `Session` with title, working directory, branch, and last-activity time.

## Install

Requires Bun >= 1.3, macOS or Linux. The `aoe` adapter additionally requires the [`aoe` CLI](https://www.agent-of-empires.com) (1.7+). The `claude-code` adapter has no runtime dependencies — it reads transcript files directly.

Install globally from npm:

```bash
bun add -g agentyard
```

Or run from a clone:

```bash
git clone https://github.com/wannabefro/agentyard.git
cd agentyard
bun install
```

## Register as MCP server in Claude Code

If installed globally:

```bash
claude mcp add agentyard -s user -- agentyard
```

If running from a clone:

```bash
claude mcp add agentyard -s user -- bun /absolute/path/to/agentyard/src/index.ts
```

`-s user` registers the server in the user-scoped Claude Code config, making `agentyard` available across every Claude Code session on the machine.

## Available MCP tools

| Tool | Description |
| --- | --- |
| `list_sessions` | List every known agent session across all registered adapters. |
| `resolve_session` | Map a natural-language reference to ranked session candidates with reasons. |
| `get_session` | Fetch full detail for one session, including live status. |
| `get_output` | Read the last N lines of a session's terminal pane. |
| `send_input` | Send a message to a running agent session as if the user typed it. |
| `send_then_wait` | Send a message and block until the agent has echoed it and the pane has settled. The canonical loop primitive. |
| `wait_idle` | Poll until output has been unchanged for `idleWindowMs`, or `timeoutMs` elapses. |
| `wait_for_ready` | Poll until the pane's last non-empty line ends with a known prompt cursor (`❯` for Claude Code, `›` for Codex CLI). Use before sending to a freshly-started session. |
| `create_session` | Create a new agent session (e.g. `aoe add`). Returns the new session id and title. |
| `start_session` | Start a stopped agent session. |
| `stop_session` | Stop a running agent session. |
| `restart_session` | Restart a session (stop then start). |
| `remove_session` | Remove a session record, optionally also deleting its worktree and branch. |

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
