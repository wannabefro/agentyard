# Running agentyard inside Codex CLI

Status as of **codex 0.132.0** (2026-05-20) and **agentyard 0.3.x**.

`agentyard` is an MCP server. Codex CLI is an MCP host. This doc covers how to register agentyard with Codex, what works, what doesn't, and the one Codex-specific quirk that bit hardest during integration.

## TL;DR

```bash
# Register (writes ~/.codex/config.toml)
codex mcp add agentyard -- /Users/$(whoami)/.bun/bin/bun run /absolute/path/to/agentyard/src/index.ts

# Verify
codex mcp get agentyard

# Smoke
codex exec "Use the agentyard MCP tool list_sessions with limit=3."
```

After this:
- **Codex TUI (`codex` interactive):** all 16 agentyard tools are available. Write tools (chat, send_then_wait, remove_session, etc.) prompt for approval the first time, then the host remembers your choice for the session.
- **`codex exec` non-interactive:** only the **read** tools work. Codex silently cancels MCP tool calls not annotated `readOnlyHint: true` with the message `user cancelled MCP tool call`. See the [quirk section](#the-readonlyhint-quirk).

## Registration

### Option A — `codex mcp add`

```bash
codex mcp add agentyard -- /absolute/path/to/bun run /absolute/path/to/agentyard/src/index.ts
```

Use absolute paths. Codex inherits the launching shell's PATH but does not source your interactive rc files, so a bare `bun` may not resolve. `agentyard`'s own `src/core/spawn_env.ts` then augments PATH for any binaries the MCP server itself spawns (codex, claude, aoe, tmux) — Apple Silicon Homebrew (`/opt/homebrew/bin`) and Intel Homebrew (`/usr/local/bin`) are covered there, so the registration command does not need to add them.

`codex mcp add` writes a TOML block under `[mcp_servers.agentyard]`:

```toml
[mcp_servers.agentyard]
command = "/Users/<you>/.bun/bin/bun"
args = ["run", "/path/to/agentyard/src/index.ts"]
```

### Option B — hand-edit `~/.codex/config.toml`

If `codex mcp add` is unavailable or you prefer reproducible config, add the block above directly. Both `command` and `args` are required; `env` and `cwd` keys are optional. Restart any running `codex` processes for it to pick up the change.

### Verification

```bash
codex mcp list                  # should show agentyard in the stdio table
codex mcp get agentyard         # full record
```

A successful registration shows `enabled: true` and `transport: stdio`.

## What works

**In Codex TUI (`codex` interactive mode):**

- `list_sessions`, `resolve_session`, `switch_session`, `select_session`, `get_session`, `get_output`, `chat`, `send_then_wait`, `send_input`, `wait_idle`, `wait_for_ready`, lifecycle (`create_session`, `start_session`, `stop_session`, `restart_session`, `remove_session`).
- First call to a write tool prompts for approval. Choose **Allow and don't ask me again** to grant per-session trust. Subsequent calls fire without prompts.
- The Codex TUI is the canonical surface for conversational session orchestration via agentyard.

**In `codex exec` non-interactive mode:**

- All tools annotated `readOnlyHint: true` — `list_sessions`, `resolve_session`, `get_session`, `get_output`, `wait_idle`, `wait_for_ready`.
- Useful for scripted catalog queries (`codex exec "list my idle sessions"`) and one-shot reads from CI/cron.

## What doesn't work

**In `codex exec` non-interactive mode:**

- Any tool not annotated `readOnlyHint: true` is silently cancelled with `user cancelled MCP tool call` before the request even reaches the agentyard server. This affects `chat`, `send_then_wait`, `send_input`, `switch_session`, `select_session` (set/clear modes), and all lifecycle tools.
- There is no config flag in codex 0.132 that bypasses this — `default_tools_approval_mode`, `approval_policy`, and `mcp_servers.<name>.approval_mode` all override different gates and none of them fix this specific cancellation. The `--dangerously-bypass-approvals-and-sandbox` flag would bypass it but should not be the default workflow.

The pragmatic split: use `codex exec` for reads; drive write workflows from the Codex TUI or from another MCP host (Claude Code) that doesn't impose this gate.

## The `readOnlyHint` quirk

This took the largest share of integration time and is the only Codex-specific code change agentyard had to make. Writing it down so the next person doesn't relive the diagnosis.

### Symptom

Every `codex exec` invocation calling any agentyard tool produced:

```json
{"type":"mcp_tool_call","server":"agentyard","tool":"list_sessions",
 "result":null,"error":{"message":"user cancelled MCP tool call"},"status":"failed"}
```

The agentyard MCP server's stderr showed only its boot banner — codex was cancelling the call client-side without ever sending `tools/call` to the server.

### What it isn't

Ruled out via direct tests:
- **Server name allowlist.** Renaming agentyard, or registering serena under a new name, did not change behavior. Serena (under any name) worked; agentyard (under any name) did not.
- **Command-path policy.** Registering with `bun run …/src/index.ts`, `/Users/<you>/.local/bin/agentyard` (the installed binary), or a wrapper script all behaved identically.
- **The TS SDK's `execution.taskSupport: "forbidden"` field.** The MCP TypeScript SDK's `registerTool()` hardcodes this on every tool (`mcp.js:704`). Stripping it from the outgoing `tools/list` response had no effect.
- **`$schema` / `additionalProperties: false` on inputSchema.** zod-to-json-schema emits these. Stripping them had no effect.
- **`tools.listChanged` capability.** The TS SDK's `McpServer` hardcodes `true`; serena emits `false`. Switching to the low-level `Server` and matching serena's capabilities exactly had no effect.
- **`serverInfo.title` / `serverInfo.websiteUrl` / top-level `instructions`.** Adding all of these to mimic serena's init response: no effect.

### What it is

Codex 0.132 in non-interactive (`codex exec`) mode requires each MCP tool to declare itself read-only via tool **annotations**:

```typescript
annotations: { readOnlyHint: true }
```

Bisection on a minimal stub:
- No `annotations` → cancelled.
- `annotations: { title: "X" }` → cancelled.
- `annotations: { readOnlyHint: false, destructiveHint: false }` → cancelled.
- `annotations: { destructiveHint: false }` → cancelled.
- `annotations: { readOnlyHint: true }` → **call goes through**.

This is consistent with codex 0.132 treating non-interactive mode as a strict-safety context: the server must self-declare that a tool has no side-effects before codex will dispatch it without human approval. Honest annotation makes write tools require TUI approval, which is correct behavior — but it does close the door on scripted use of write tools via `codex exec`.

### Why Python-SDK servers (serena) worked from day one

The Python `mcp` package surfaces tool annotations as a first-class registration concern, so serena's tools all carry `readOnlyHint: true` (and the destructive/idempotent hints) by default. The TypeScript SDK's `registerTool()` accepts `annotations` in the config object but does not encourage or default it. None of agentyard's pre-codex MCP hosts (Claude Code, the in-process smoke test) gated on annotations, so the omission went unnoticed until codex.

### The fix in agentyard

`src/index.ts` now passes `annotations: { readOnlyHint: true | false, destructiveHint, idempotentHint, openWorldHint }` on every `server.registerTool()` call. Read tools get `readOnlyHint: true`; write tools get `readOnlyHint: false` plus accurate destructive/idempotent/open-world hints so the TUI's approval prompt is honest. The MCP smoke test (`tests/mcp_smoke.ts`) and unit suite both pass unchanged — annotations are pure metadata.

### Carrying this forward

If a future tool is added to `src/index.ts`, **the `annotations` field is mandatory** for `codex exec` to be able to call it. Read tools: `{ readOnlyHint: true }`. Write tools: spell out the hints (`readOnlyHint: false` plus at least one of `destructiveHint`/`idempotentHint`/`openWorldHint`) so the TUI can present an accurate approval prompt.

This is enforced socially, not programmatically. The MCP SDK has no compile-time check; codex's silent cancellation is the runtime signal.

## Other Codex-specific behavior

### PATH

Codex inherits the launching shell's PATH but does not source rc files for the MCP subprocess. `src/core/spawn_env.ts` handles the binary-resolution problem by resolving `codex`/`claude`/`aoe`/`tmux` to absolute paths at call time, with an augmented PATH that includes both Homebrew prefixes. No additional Codex-specific config is needed.

### Sandbox

`codex doctor` reports `restricted fs + restricted network · approval OnRequest` by default. The agentyard MCP server runs as a subprocess of codex and inherits this sandbox. Empirically, this has not blocked the agentyard adapter's own `codex exec resume` spawn calls on macOS Seatbelt — the sandbox permits launching codex from within codex's subprocess tree. If a future restriction changes that, the symptom would be the agentyard server's `codex exec resume` shelling out and getting permission-denied; investigate sandbox policy at that point.

### Approval policy

`approval_policy` (global) and `mcp_servers.<name>.default_tools_approval_mode` (per-server) both exist as `-c` overrides but are orthogonal to the `readOnlyHint` gate above. Valid values for `default_tools_approval_mode` are `auto`, `prompt`, `approve` (verified empirically — `--strict-config` rejects others).

### `codex mcp-server`

Out of scope for this doc. Codex itself can serve MCP via `codex mcp-server`, but that turns codex INTO an MCP server rather than helping codex consume agentyard as one. If you want to compose them — codex-the-agent running inside a session managed by agentyard, with that codex itself exposing tools to its parent — the existing `codex` adapter in `src/adapters/codex/` is the right layer to extend.

## References

- `~/.codex/config.toml` — where MCP server registrations live.
- `codex mcp --help`, `codex exec --help` — the relevant CLI surface.
- [docs/research/codex.md](../research/codex.md) — agentyard's notes on Codex as an *agent* (the read/write surface the codex adapter targets). Distinct from this doc, which is about Codex as a *host*.
- [docs/research/claude-code.md](../research/claude-code.md) — sister doc for the other MCP host agentyard targets, useful for diffing host behaviors.
