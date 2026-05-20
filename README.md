# pepper

## What pepper is

`pepper` is an adapter-based MCP orchestrator for AI coding agents. It exposes a conversational interface through an MCP host (such as Claude Code): the user asks about "the fender evals" or "the codex session fixing auth", and `pepper` resolves the reference, dispatches the interaction, and returns the result. The first adapter targets [Agent of Empires](https://github.com/njbrake/agent-of-empires) (`aoe`); the core stays agent-system-agnostic so new platforms land as new adapters, not core changes.

## Install

Requires Bun >= 1.3, macOS or Linux, and the `aoe` CLI (1.7+) for the `aoe` adapter.

```bash
bun install
```

## Register as MCP server in Claude Code

```bash
claude mcp add pepper -s user -- bun /absolute/path/to/pepper/src/index.ts
```

`-s user` registers the server in the user-scoped Claude Code config, making `pepper` available across every Claude Code session on the machine. Replace `/absolute/path/to/pepper` with the absolute path to your checkout.

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

1. Write `docs/research/<name>.md` first — capture the target system's CLI, HTTP surface, session model, status semantics, and any schema quirks. See [`docs/research/agent-of-empires.md`](docs/research/agent-of-empires.md) for the reference shape. The "research before writing" rule in [`CLAUDE.md`](CLAUDE.md) exists because guessing endpoints loses time.
2. Implement the `Adapter` interface in [`src/adapters/types.ts`](src/adapters/types.ts) under `src/adapters/<name>/`.
3. Register the adapter in [`src/index.ts`](src/index.ts) by adding it to the `AdapterRegistry`.

Keep adapter-specific concerns (idle detection, status mapping, normalization) inside the adapter. If a change to the core is motivated by one adapter's needs, the abstraction is leaking — push the specifics back into the adapter.
