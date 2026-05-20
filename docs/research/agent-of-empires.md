# Agent of Empires (`aoe`) — research notes

Raw findings from public docs and source signals, captured to inform the first adapter. Verify each "assumption" item against a live install before relying on it in code.

## Identity

- Project: [njbrake/agent-of-empires](https://github.com/njbrake/agent-of-empires) — open source, Rust, v1.0+.
- Docs: [agent-of-empires.com/docs](https://www.agent-of-empires.com/docs/).
- Purpose: TUI/web session manager for AI coding agents (Claude Code, OpenCode, Codex CLI, Gemini CLI, Copilot CLI, Mistral Vibe, Pi.dev, Factory Droid Coding).
- Underlying primitives: **tmux** sessions, **git worktrees** (one per agent session), optional **Docker** sandboxing.

## Integration surfaces

`aoe` exposes two surfaces an adapter can target. The CLI is more documented and requires no daemon, so it is the default integration path.

### CLI surface (`aoe ...`)

Many read commands accept `--json`, which makes them adapter-friendly.

| Command                                | Purpose                                      | JSON? |
|----------------------------------------|----------------------------------------------|-------|
| `aoe list`                             | enumerate sessions                           | `--json` |
| `aoe list --all`                       | enumerate across profiles                    | `--json` |
| `aoe session show <id>`                | session details                              | `--json` |
| `aoe session capture <id> -n <N>`      | terminal pane snapshot                       | `--json`, `--strip-ansi` |
| `aoe status`                           | fleet summary                                | `--json`, `-v`, `-q` |
| `aoe cockpit ps`                       | cockpit workers                              | `--json` |
| `aoe cockpit tail --since <seq>`       | JSON-lines event stream (cockpit-scoped)     | inherent |
| `aoe send <id> <message>`              | send input to agent                          | n/a (write) |
| `aoe add [PATH]`                       | create session (`-t`, `-g`, `-c`, `--sandbox`, `--cockpit`) | n/a (text — see below) |
| `aoe session start/stop/restart <id>`  | lifecycle                                    | n/a |
| `aoe remove <id>`                      | delete (`--delete-worktree`, `--delete-branch`, `--force`) | n/a |
| `aoe attach <id>` / `session attach`   | interactive — **not for adapter use**        | n/a |
| `aoe serve`                            | start web dashboard / HTTP API               | `--status` |
| `aoe url --token-only`                 | discover bearer token for HTTP API           | n/a |

Session identifier: accepts either the session **ID** or the **title**. The exact ID format (string slug? UUID? numeric?) is not documented — verify by running `aoe list --json` against a live install.

`aoe add` does not support `--json`; it prints a human-readable block to stdout. Verified format from `aoe 1.7.0`:

```text
Running on_create hooks...
✓ on_create hooks completed
✓ Added session: <title>
  Profile: default
  Path:    <abs path>
  Group:
  ID:      <16-char hex>
  Cmd:     <cmd>

Next steps:
  aoe session start <title>   # Start the session
  aoe                         # Open TUI and press Enter to attach
```

The adapter parses the new ID off the `  ID:      <hex>` line with `/^\s*ID:\s+([a-f0-9]+)\s*$/m`. Test fixture in `tests/aoe_cli_parsing.test.ts`. If `aoe` ever changes this format, update both the regex and the fixture.

### HTTP API (`aoe serve`)

- Default port: **7777**.
- Default host: `127.0.0.1` (use `--remote` or `--host 0.0.0.0` to expose).
- Auth: bearer token (recommended), query param `?token=`, or cookie `aoe_token=`. `--no-auth` disables.
- Token discovery: `aoe url --token-only`.

Documented endpoints:

- `POST /api/sessions/{id}/send` — body `{"message": "..."}`; statuses 200/400/403/404/409/500.
- `GET /api/sessions/{id}/output?lines=N&format=text|ansi` — pane snapshot (lines clamped 1–2000, default 200).
- `GET /api/sessions` — list sessions; **referenced but underdocumented**. Verify shape against a live server.

`src/server/` is described as "REST API, WebSocket PTY relay, auth" — the WebSocket relay exists but is not documented on the public API page. It is most likely the terminal-stream backing the web dashboard, not a status-event channel. Don't assume it's a clean push surface for orchestration.

## Session model (verified against `aoe 1.7.0` on this machine)

**Storage**: `~/.agent-of-empires/profiles/<profile>/sessions.json` — JSON array of session objects.

**tmux naming**: prefix `aoe_` (release builds), `aoe_dev_` (debug builds).

### ID format

16-character lowercase hex string, e.g. `09c118b3df9f4d53`. Looks like a rendered 64-bit value. Accepted by every `aoe` subcommand that takes `<IDENTIFIER>`. Session **title** (e.g. `fender-evals`) is also accepted in place of the ID.

### The three shapes (NB: they differ)

Critical detail for the adapter: `aoe list --json`, `aoe session show <id> --json`, and the raw `sessions.json` each return **different field names and different subsets**. The adapter must normalize to one internal model.

**`aoe list --json`** — array of:
```json
{
  "id": "09c118b3df9f4d53",
  "title": "fender-evals",
  "path": "/abs/path/to/worktree",
  "group": "",
  "tool": "codex",
  "command": "codex",        // present when set; missing for default-claude
  "profile": "default",
  "created_at": "2026-05-14T13:35:21.894144Z",
  "workspace_repos": [],     // populated for multi-repo workspaces; empty in single-repo case
  "worktree": {
    "branch": "fender-evals",
    "main_repo_path": "/abs/path/to/main/repo",
    "managed_by_aoe": true
  }
}
```
Notable omission: **no `status` field**. Status is not in `list --json`.

**`aoe session show <id> --json`** — single object, smaller than `list`:
```json
{
  "id": "09c118b3df9f4d53",
  "title": "fender-evals",
  "path": "/abs/path/to/worktree",
  "group": "",
  "tool": "codex",
  "command": "codex",
  "status": "idle",           // <-- present here, absent in list
  "profile": "default"
}
```
Notable omissions: **no `created_at`, no `worktree`, no `workspace_repos`**. So neither CLI surface gives you the full picture — you need both, or the raw `sessions.json`.

**`sessions.json`** (the persistent state) — superset, with different field names again:
```json
{
  "id": "09c118b3df9f4d53",
  "title": "fender-evals",
  "project_path": "/abs/path/to/worktree",   // renamed from "path"
  "group_path": "",                           // renamed from "group"
  "command": "codex",
  "tool": "codex",
  "yolo_mode": true,                          // auto-approve mode
  "status": "idle",
  "created_at": "...",
  "last_accessed_at": "...",                  // present on recently-touched sessions
  "idle_entered_at": "...",                   // present iff status == "idle"
  "worktree_info": {                          // renamed from "worktree"
    "branch": "fender-evals",
    "main_repo_path": "...",
    "managed_by_aoe": true,
    "created_at": "..."
  },
  "agent_session_id": "019df8b4-56cf-74c3-a87f-b7bc344c1018"
                                              // the underlying agent CLI's own session UUID
                                              // (Claude Code / Codex). Present once the agent
                                              // has actually started a session.
}
```

### `status` values (verified)

From `aoe status --json`: `waiting`, `running`, `idle`, `stopped`, `error`. Aggregation example:
```json
{"waiting":0,"running":2,"idle":5,"stopped":0,"error":3,"total":10}
```

`idle_entered_at` in `sessions.json` lets the orchestrator compute time-since-idle without polling history — useful for the resolver's recency matcher and for loop primitives.

### `agent_session_id` is gold

The UUID in `sessions.json` is the *underlying agent's* session ID — Claude Code's session ID, Codex's session ID. That means:

- The orchestrator can correlate `aoe` sessions with logs/transcripts the agent itself persists (e.g. `~/.claude/projects/<proj>/<uuid>.jsonl`).
- This is a fact about agent CLIs more than about `aoe`, but the fact that `aoe` *surfaces* it lets the adapter bridge directly to per-agent introspection. Worth a dedicated adapter capability (`get_native_session_id`) so the core can ask "give me the underlying transcript path" generically.

### `aoe session capture` shape

```json
{
  "id": "...",
  "title": "...",
  "status": "idle",
  "tool": "codex",
  "content": "<terminal pane as string>",
  "lines": 20
}
```
`content` is the pane snapshot. With `--strip-ansi`, it's plain text. With ANSI, the adapter would need to parse escape codes — only do that if there's a need for color/cursor info, which there usually isn't for idle-detection.

### Resolver implications now that schema is known

The resolver has rich keys to work with:
- `title` — primary fuzzy-match target. User says "fender evals" → title `fender-evals` matches obviously.
- `worktree.branch` / `worktree_info.branch` — second fuzzy-match target.
- `worktree.main_repo_path` — discriminates by repo (e.g. "the k-repo one").
- `tool` — discriminates by agent ("the codex one fixing X").
- `status` + `last_accessed_at` + `idle_entered_at` — recency / activity matchers.
- `group_path` — explicit user-set grouping when populated.

Confidence: in this user's catalog, exact-title-substring matching alone would resolve "fender evals" → `09c118b3df9f4d53` unambiguously. The resolver doesn't need to be clever for the common case — deterministic matchers will handle 90%+.

## Config

Three-layer TOML (later overrides earlier):

1. Global: `~/.agent-of-empires/config.toml` (macOS) / `$XDG_CONFIG_HOME/agent-of-empires/config.toml` (Linux).
2. Profile: `~/.agent-of-empires/profiles/<name>/config.toml`.
3. Repo: `.agent-of-empires/config.toml` in the project root.

Repo configs are restricted to `[hooks]`, `[session]`, `[sandbox]`, `[worktree]`.

Hooks exist (repo-only) but the event types, env vars, and return semantics are **not documented on the public configuration page** — full reference deferred to `/guides/repo-config/` which has not yet been read. **Open question** before integrating with hooks.

## Cockpit vs. tmux sessions

`aoe` appears to have two parallel session surfaces:

- Regular tmux-backed sessions (what `aoe add` creates by default).
- "Cockpit" sessions (created with `aoe add --cockpit`; managed with `aoe cockpit *`).

The docs describe cockpit as "native agent rendering" (`/docs/cockpit/`), implying a non-tmux path. `aoe cockpit tail --since <seq>` is the clean JSON-lines event stream — but it's scoped to cockpit. Whether `aoe list`, `aoe send`, and the HTTP endpoints work uniformly across both surfaces is **not clear from the docs**. **Verify before promising cross-surface support in the adapter.**

**Recommendation**: first adapter implementation targets regular tmux sessions only. Cockpit support is a second pass.

## Adapter design implications

Things the adapter contract must accommodate:

1. **`send_input` is documented and supported** — both CLI (`aoe send`) and HTTP (`POST /api/sessions/{id}/send`). External loop driving is feasible.
2. **`get_output` is documented but pull-only** — neither documented surface gives reliable per-event push for non-cockpit sessions. The adapter will likely poll `aoe session capture --json` on an interval, possibly with `aoe cockpit tail` as a fast path when sessions are cockpit-backed.
3. **"Idle detection"** is not exposed directly. The adapter has to compute it from successive `capture` snapshots (pane unchanged for N seconds, or trailing prompt matches a per-agent regex). This is per-agent because the prompt shape differs (Claude Code, Codex CLI, Gemini CLI all render differently).
4. **Session creation by the orchestrator** is supported via `aoe add` — useful for "spawn a fender-evals agent" flows, but lower priority than read + send + loop for the first iteration.

## Bug class: `status=idle` is not the same as "ready for input" (mitigated)

Found during live dogfood (2026-05-19):

- `aoe session show <id> --json` reports `status: "idle"` within seconds of `aoe session start`.
- `aoe send <id> "..."` succeeds at the subprocess level.
- The Claude TUI may still be booting (welcome animation, or a "trust this folder?" confirmation). The send never reaches the agent — post-send pane shows `0% ctx | $0.000`.
- pepper's first `send_then_wait` saw TUI rendering as "change," then "settle," and reported `ok=true changed=true settled=true`. False success.

**Fix shipped — echo verification.** After `sendInput`, `send_then_wait` now waits for the first 30 chars of the (normalized) sent text to appear in the pane more times than they appeared pre-send. Implementation in `src/core/loop.ts` (`waitForEcho`). For text shorter than 8 chars (`y`, `1`, `no`), falls back to plain change detection and labels the result accordingly.

Verified end-to-end (2026-05-19):

- Racing the TUI startup against a freshly-started session that still had the "trust this folder?" prompt up → `ok=false, changed=true, reason: "sent text did not appear in pane within 20000ms — the agent likely did not receive the input (terminal may be booting or unresponsive)"`. The bug now surfaces as a clean failure, not a silent success.
- Same prompt, same code path, against a session whose TUI was at its chat prompt → `ok=true changed=true settled=true`, pane shows `⏺ pong`, agent context 0% → 6%, 13.8s wall.

Other candidate mitigations still on the table for agents that don't echo verbatim:

1. **Pre-send prompt-cursor check.** Wait for `❯` (Claude Code), `›` (Codex), or similar to be the last visible line before even sending. Adapter/tool-specific.
2. **Status transition watch.** Wait for `aoe` status to flip `idle → running → idle`. Layers on top of any other check.

Resolved by direct probe of `aoe 1.7.0` on this machine: session schema, ID format, status values, fields available per surface, `agent_session_id` presence.

Still open:

1. Whether `aoe cockpit tail` covers non-cockpit sessions or is strictly scoped (no cockpit sessions on this machine to test against — all observed sessions are regular tmux-backed).
2. Full hook event catalog and env contract (read `/guides/repo-config/`). **Note**: this machine's hooks are currently broken (`PreToolUse`/`PostToolUse`/`Stop` exit 127, visible in pane capture). User-local config issue, but reminds us the adapter shouldn't assume hooks are healthy.
3. Latency characteristics of `aoe session capture` at polling rates — needs measurement when the adapter is wired.
4. Auth-token rotation behavior for `aoe serve`. Affects HTTP-mode adapter caching.
5. Whether the `command` field is ever something other than `""` or the tool name (e.g. for `aoe add --cmd "claude --resume <uuid>"` patterns).

## Sources

- README: <https://github.com/njbrake/agent-of-empires>
- Docs index: <https://www.agent-of-empires.com/docs/>
- CLI reference: <https://www.agent-of-empires.com/docs/cli/reference/>
- API reference: <https://www.agent-of-empires.com/docs/api/>
- Config guide: <https://www.agent-of-empires.com/docs/guides/configuration/>
- AGENTS.md (source layout): <https://github.com/njbrake/agent-of-empires/blob/main/AGENTS.md>
- HN launch thread: <https://news.ycombinator.com/item?id=47529985>
