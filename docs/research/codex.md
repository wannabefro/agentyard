# Codex CLI — research notes

Raw findings from probing a live install on macOS (`codex` 0.132.0, `~/.codex/`), captured to inform the Codex adapter. Verify each "assumption" item against the actual transcript before relying on it. Mirror-structured against [claude-code.md](claude-code.md) so the two are easy to diff.

## Identity

- Source: OpenAI Codex CLI (`codex`, also `codex-cli` in version output). Distributed via Homebrew on this machine (`/opt/homebrew/bin/codex`). Distinct from the older "Codex" research preview models — this is the Rust-based CLI agent.
- Probed version: `0.132.0` (visible as `cli_version` in `session_meta.payload`).
- Format: newline-delimited JSON (`.jsonl`), one record per line, **append-only** during a session. On-disk format is internal — not a public schema, expect drift between versions.
- Multiple record `type`s coexist in one file. Each turn is bracketed by `task_started` and `task_complete` event_msg records.

## On-disk layout

```
~/.codex/
├── sessions/
│   └── YYYY/MM/DD/
│       └── rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl   # one file per session, date-partitioned
├── archived_sessions/                                  # rotated/older sessions (not yet probed)
├── session_index.jsonl                                 # NOT the authoritative session list — see below
├── history.jsonl                                       # ~1.4MB on this machine; user-prompt history (unrelated to sessions)
├── state_5.sqlite                                      # opaque internal state
├── logs_2.sqlite                                       # ~128MB log database (not yet probed)
├── config.toml                                         # user config
├── auth.json                                           # credentials — DO NOT READ from the adapter
├── memories/, rules/, skills/, hooks.json              # codex's own skill/memory system (not adapter-relevant for v1)
└── ...
```

On this machine: 285 rollout files across `sessions/`, ranging from 2025 through 2026. Date-partitioning means listSessions can prune by year/month before opening files.

### Filename carries timestamp + UUID

```
rollout-2026-05-20T18-07-28-019e465b-49f8-7d93-b9cb-1f30dd3a3283.jsonl
        └────── creation time ──────┘ └──────────── session UUID ──────────┘
```

The UUID is the *last 5 dash-separated groups* of the basename minus `.jsonl`. Don't split on `-` and take the last N — the timestamp also uses `-` as a separator. Parse with a regex anchored on `rollout-` prefix and `.jsonl` suffix:

```typescript
const m = filename.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]+)\.jsonl$/);
```

The UUID is also present inside the file at `session_meta.payload.id` — the adapter should read it from the record, not parse the filename, except for fast bulk-listing where filename parsing avoids opening every file.

### Path is NOT encoded into the directory tree

Unlike Claude Code (which encodes the cwd into the project directory name lossily), Codex stores all sessions in a flat date-partitioned tree. The cwd is **only** available from `session_meta.payload.cwd` inside the file. Adapter must read at least the first line of each rollout to know which workspace it belongs to.

This is a **bigger deal for performance than for correctness**: Claude Code's adapter can filter by encoded directory name before opening files; Codex's must open every file at least to the first line. The mitigation is that line 1 is always `session_meta` (see below) and is small.

## `session_meta` is one record per file

Verified: **every rollout file's first line is a `session_meta` record. Resumes do not append a new one.** The 29-line test file (one create + two resumes) had exactly one `session_meta` record.

```json
{
  "timestamp": "2026-05-20T18:07:28.686Z",
  "type": "session_meta",
  "payload": {
    "id": "019e465b-49f8-7d93-b9cb-1f30dd3a3283",
    "timestamp": "2026-05-20T18:07:28.282Z",
    "cwd": "/private/tmp/codex-research",
    "originator": "codex_exec",
    "cli_version": "0.132.0",
    "source": "cli",
    "thread_source": "user",
    "model_provider": "openai",
    "git": {
      "commit_hash": "ead0411bc0a167e6621ef90e5c82be66af140e5b",
      "branch": "more-fun",
      "repository_url": "git@github.com:klaviyo/app.git"
    },
    "base_instructions": { "text": "You are Codex, ...long system prompt..." },
    ...
  }
}
```

Fields that matter to the adapter:

| Field | Use |
|-------|-----|
| `payload.id` | Session UUID (matches filename and the host's `codex exec resume` argument) |
| `payload.cwd` | Authoritative working directory at session creation |
| `payload.originator` | How the session was created (see below) |
| `payload.cli_version` | Schema-version proxy |
| `payload.git.branch` | Resolver gold — free-text matchable |
| `payload.git.commit_hash` | Useful for "session was started before commit X" |
| `payload.git.repository_url` | Lets the orchestrator group sessions per repo |

`base_instructions.text` is a multi-KB system prompt — don't surface it to users by default. Skip it when summarizing.

### Originators observed (sample of 200 random files)

| Originator | Count | Meaning |
|------------|-------|---------|
| `codex_cli_rs` | 127 | Interactive CLI invocations (`codex <prompt>`, `codex resume`) |
| `codex-tui` | 58 | TUI-mode interactive sessions (the alt-screen interactive surface) |
| `Codex Desktop` | 8 | Mac desktop app |
| `codex_exec` | 7 | Non-interactive (`codex exec`, `codex exec resume`) |

Filter by originator to support "only sessions started via the TUI" vs "include automation runs". Default for resolver matching: include all.

## Record types

Top-level `type` values observed in the wild:

| Type | Purpose | Cardinality per file |
|------|---------|----------------------|
| `session_meta` | One per file at creation. Identity, cwd, git, system-prompt | 1 |
| `turn_context` | Per-turn config (model, sandbox, approval_policy, summary, current_date) | many — one per turn |
| `response_item` | Model-side items: `function_call`, `function_call_output`, `message`, `reasoning`, `custom_tool_call`, `custom_tool_call_output`, `tool_search_call`, `tool_search_output` | many |
| `event_msg` | Semantic events: `task_started`, `task_complete`, `user_message`, `agent_message`, `token_count`, `mcp_tool_call_end`, `patch_apply_end`, `context_compacted` | many |
| `compacted` | Compaction marker (history truncated, reasoning rolled up) | 0 or more |

**Assume schema growth.** The list above is what one TUI session and one exec-resume session emitted. The Codex schema is internal; unknown `type` or `payload.type` values must not error the adapter.

### Turn boundaries are bracketed

Each turn (initial or resumed) emits, in order:

```
event_msg/task_started
turn_context
response_item/message    (the input — system + user prompt)
event_msg/user_message
[response_item/reasoning]    (optional, present when reasoning effort > 0)
event_msg/agent_message
response_item/message    (the output)
event_msg/token_count
event_msg/task_complete
```

For the adapter's `getOutput`-equivalent, the natural unit is the turn: collect `user_message` + `agent_message` pairs, optionally include the `reasoning` block.

### turn_context carries per-turn config

```json
{
  "type": "turn_context",
  "payload": {
    "model": "gpt-5.5",
    "effort": "high",
    "approval_policy": "never",
    "sandbox_policy": "read-only",
    "cwd": "/private/tmp/codex-research",
    "current_date": "2026-05-20",
    "summary": "...",
    "user_instructions": "...",
    "personality": "...",
    "permission_profile": "...",
    "truncation_policy": "...",
    "collaboration_mode": "...",
    "realtime_active": false,
    "timezone": "America/New_York",
    "turn_id": "<uuid>"
  }
}
```

`payload.cwd` here can drift from `session_meta.payload.cwd` if the user uses `-C <DIR>` on resume — but our test resume from a different directory did NOT re-record cwd. The latest `turn_context.payload.cwd` is the most authoritative for "what directory does the agent currently think it's in." Use it when surfacing recent context.

## `session_index.jsonl` is NOT the authoritative session list

This file is small (19 entries vs 285 rollout files on this machine) and is only populated for specific code paths:

```json
{"id":"019e4516-...","thread_name":"Codex Companion Task: <task> Review i18n disaster-recovery...","updated_at":"2026-05-20T11:13:10.899636Z"}
```

Observed entries all had `thread_name` fields, most prefixed `Codex Companion Task:` (apparently populated by a specific integration — not by `codex exec` or `codex` interactive runs). Our two test exec runs did NOT add entries. Treat `session_index.jsonl` as **opportunistic metadata cache** that surfaces named threads, not as the session catalog.

**Adapter rule:** walk `sessions/**/rollout-*.jsonl` for the authoritative list. Optionally enrich with `session_index.jsonl` when an `id` matches — `thread_name` is resolver gold (human-readable, free-text, populated for the most "interesting" sessions).

## Stable fields on response_item / event_msg records

`response_item` payloads embed model-API-shaped data. `event_msg` payloads are agent-system events. Both carry a `payload.type` discriminator. Beyond `payload.type`, the schema varies per subtype — the adapter must dispatch on `(record.type, record.payload.type)`.

For `event_msg.payload.type === "user_message"`:
```json
{ "type": "user_message", "message": "can we auth linear", "images": [], "local_images": [], "text_elements": [] }
```

For `event_msg.payload.type === "agent_message"`:
```json
{ "type": "agent_message", "message": "I'll use the Linear skill here...", "phase": "commentary", "memory_citation": null }
```

`phase` distinguishes intermediate `commentary` from final responses. The adapter's "last agent message" should prefer the final-phase one.

## JSON parse robustness — REQUIRED

A sample of ~30 random rollout files failed strict `jq` parsing at lines like 28, 156, 500, with errors like `Invalid string: control characters from U+0000 through U+001F must be escaped`. Codex sometimes writes records containing **literal unescaped control characters** in payloads — likely inside `base_instructions.text` or `summary` fields that capture user-edited multi-line content.

**Adapter rule:** parse each line with `try/catch`, log-and-skip on parse failure. Do not let one bad line abort the read. This is also true for live-write tail reads (last line may be truncated mid-write).

Bun's `JSON.parse` is strict and will throw on unescaped control chars. Either:
- catch and skip, or
- pre-sanitize with `.replace(/[ -]/g, '')` before parse (lossy but cheap), or
- use a permissive JSONL streamer (`undici-stream` or hand-rolled).

Recommend catch-and-skip; pre-sanitize would mangle legitimate `\n` literals in escaped strings if accidentally applied to the wrong fields.

## Activity signal

Same three signals as Claude Code, in order of cost:

1. **File mtime** — cheapest, append updates it
2. **Last record's `timestamp`** — accurate, reads tail
3. **Most recent `task_started`/`task_complete` pair** — turn-level activity vs intra-turn noise

Recommend mtime for bulk-list; tail-parse for ranking.

## Write path: `codex exec resume`

`codex exec resume <UUID> "<prompt>" --json -o <file>` is the canonical write primitive. Verified live against `codex` 0.132.0.

### Invocation shape

```bash
codex exec resume --skip-git-repo-check --json -o /tmp/codex-last.txt "<uuid>" "<prompt>"
```

`--json` emits a JSONL **event stream** on stdout (4 events for a one-turn run). `-o <file>` writes the final agent message as plain text (no JSON wrapper, no trailing newline). `--skip-git-repo-check` is required when the cwd isn't a git repo (defaults to refusing).

### Output schema (stdout, `--json` mode) — different from on-disk

```jsonl
{"type":"thread.started","thread_id":"019e465b-49f8-7d93-b9cb-1f30dd3a3283"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"CHARLIE"}}
{"type":"turn.completed","usage":{"input_tokens":41255,"cached_input_tokens":12032,"output_tokens":81,"reasoning_output_tokens":65}}
```

**Two distinct schemas to normalize:**

| Surface | Schema family | Example types |
|---------|---------------|---------------|
| On-disk JSONL | `session_meta` / `response_item` / `event_msg` / `turn_context` | `agent_message`, `user_message`, `task_started`, `function_call` |
| stdout `--json` | `thread.started` / `turn.started` / `item.completed` / `turn.completed` | `agent_message` (inside `item`) |

The aoe adapter had a three-shape schema problem. Codex has a two-shape problem. Adapter should expose a single normalized Turn type and translate from whichever surface it's reading.

### Critical: `codex exec resume` is NOT cwd-dependent

Verified: a session created with `cwd: /private/tmp/codex-research` resumed cleanly from `cwd: /tmp` (different absolute path, same logical directory after symlink resolution would be `/private/tmp`, but the shell cwd at resume time was unrelated and resume worked). 

This is a notable simplification over Claude Code, where `claude --resume` fails with `No conversation found with session ID` when invoked from the wrong cwd. **The Codex adapter does not need to chdir before resume.**

That said: the *agent* still sees the cwd it was invoked with for filesystem operations. If the host wants the agent to operate on the original session's workspace, the adapter should chdir (or pass `-C <session.cwd>`) before the resume call. The lookup-by-id works regardless of cwd, but the agent's tool calls don't.

### Cost characteristics

From the test runs:

| Turn type | input_tokens | cached_input_tokens | Cache reuse |
|-----------|--------------|---------------------|-------------|
| One-shot exec (cold) | ~17K total | 0 | None |
| Resume turn 1 | 41K | 12K | ~29% |
| Resume turn 2 (after turn 1) | 62K | 21K | ~33% |

Codex's cache amortizes across resume invocations significantly better than Claude Code's, which creates a fresh ~56K-token prompt cache per `claude --print` subprocess. This is because Codex's transcripts carry the full history at the API level, and the Responses API can warm-cache across calls within a session.

### stderr noise

`codex exec` writes `Reading additional input from stdin...` to stderr when stdin is a pipe (even if PROMPT is provided as an arg). Without `--json`, stdout includes a banner ("OpenAI Codex v0.132.0\n--------\nworkdir: ...") followed by the response. With `--json`, stdout is clean (just the event JSONL).

**Adapter rule:** always use `--json` mode for the write path. Ignore stderr except for non-zero exit. Use `-o <file>` to get the final response without parsing the JSONL stream.

### Failure modes to handle

Not yet probed live but predictable from the help text and analogues to Claude Code:

- **Session not found** — `codex exec resume <bogus-uuid>` likely emits an error to stderr; exit non-zero.
- **Concurrent attach** — what happens if two `codex exec resume` calls run against the same id concurrently? Untested. Probably one wins, the other errors. Treat as "session locked"-style failure.
- **`--ephemeral` resume** — doesn't make sense (you can't resume a session that wasn't persisted). Probably errors. Untested.
- **Sandbox/approval mismatch** — resume can't override the original session's sandbox via `--sandbox` (the flag is rejected on `exec resume`). User-instructions overrides via `-c` should work but weren't tested.

### `--ephemeral` for write-only orchestration

`codex exec --ephemeral "<prompt>" --json -o <file>` runs a one-shot Codex call **without persisting any rollout file**. Verified: file count in `sessions/` stayed flat. This is useful if the orchestrator wants to use Codex as a one-shot subagent (e.g., a one-off code review) without polluting the session catalog.

## Prompt cursor

Codex's CLI prompt cursor is `›` (U+203A) — already registered in `src/adapters/aoe/index.ts:86` (`KNOWN_PROMPT_CURSORS = ["❯", "›"]`). The codex-bundled-in-aoe path has been exercising this in production; no live re-verification of the TUI was performed for this doc. The aoe-wrapped flow is the empirical source.

## CLI surface — full subcommand inventory

```
codex                       interactive TUI (alt-screen)
codex <PROMPT>              shortcut: starts TUI with initial prompt
codex exec                  non-interactive, one-shot — writes a new session
codex exec resume           non-interactive resume — appends to existing session
codex exec resume --last    resume the most recent session
codex resume                interactive picker for resume
codex fork                  fork an existing session into a new id (interactive)
codex review                non-interactive code review (specialized exec mode)
codex login / logout        auth
codex mcp                   manage MCP servers Codex itself connects to
codex mcp-server            start Codex as an MCP server (stdio) — interesting, orthogonal to our adapter
codex app-server            [experimental] app-server daemon
codex remote-control        [experimental] daemon control
codex sandbox               run commands inside Codex's sandbox
codex doctor                installation health
codex apply                 git apply the latest agent-generated diff
```

The two surfaces the adapter cares about: `codex exec resume` (write path) and the on-disk JSONL (read path).

**Note:** `codex mcp-server` is Codex's *own* MCP server — i.e., Codex can be a tool that other agents call. This is **not** what the agentyard codex adapter does. The agentyard adapter is the reverse: agentyard is the orchestrator, Codex is the orchestrated process. They could be composed (an agentyard-managed Codex session could itself talk to MCP servers), but that's a config-level concern, not an adapter design concern.

## Adapter contract proposals

Mapped against `src/adapters/types.ts`:

| Method | Mapping |
|--------|---------|
| `listSessions()` | walk `~/.codex/sessions/**/rollout-*.jsonl`, parse first line of each for `session_meta`. Optionally enrich with `session_index.jsonl` for `thread_name`. |
| `getSession(id)` | open the matching rollout file; read first record (session_meta) + last 50 records for a summary. |
| `getOutput(id, lines, format)` | tail-read the rollout file, extract `user_message`/`agent_message` event_msg payloads, render as text. For ANSI format, include reasoning blocks. |
| `sendInput(id, text)` | **omit at v1.** Codex's write path is fundamentally synchronous (same as Claude Code's), and a misleading fire-and-forget contract is exactly the bug the 0.2.0 `send_input("")` lesson warns against. |
| `sendThenWait(id, text)` | spawn `codex exec resume --json -o <tmpfile> <id> <text>`, capture stdout JSONL, return `SendThenWaitResult { ok, changed, settled: true, before, after, elapsedMs, response }`. The final agent message is in `<tmpfile>` (cleanest) or the last `item.completed` event with `item.type === "agent_message"`. |
| `waitIdle` / `waitForReady` | **omit.** Not applicable — no terminal pane, no boot window. The subprocess blocks until the turn completes. |
| Lifecycle (`createSession`/`start`/`stop`/`restart`/`remove`) | `createSession` could spawn `codex exec --json -o <file> <prompt>` and capture the new session id from `thread.started`. `removeSession` could filesystem-delete the rollout (with archive). Defer for v1 unless a clear use case appears. |
| `subscribe_events` | not yet — no obvious push surface. SQLite logs (`logs_2.sqlite`) may be a candidate but unprobed. |

## Relationship to aoe

The user's catalog already contains aoe sessions wrapping Codex (e.g., `404-mt` with `tool: "codex"`, `cleanup-shared`). When Codex runs inside aoe, it inherits aoe's terminal-pane abstraction and is driven through the aoe adapter via tmux. **That is unchanged by this work.**

The standalone codex adapter is for:

1. **Codex sessions that were never wrapped by aoe** — e.g., a developer's interactive `codex` runs from their own terminal, sessions started by Cursor or another integration, or `codex exec` runs invoked by scripts.
2. **Read access to the full Codex transcript history** — even for aoe-wrapped sessions, aoe's terminal capture is the rendered pane, not the structured turn record. The standalone codex adapter can read the rich JSONL for sessions that aoe knows about, providing per-turn metadata (model used, sandbox policy, token usage) aoe can't.
3. **Headless orchestration** — driving Codex as a one-shot tool without involving tmux. `codex exec --ephemeral` is the right primitive here.

For agentyard's resolver, an aoe-wrapped Codex session and a standalone Codex session are *different* sessions even if they share the same agent_session_id — the aoe one has a terminal pane and lifecycle, the standalone one does not. The resolver should surface both and let the user choose. Whether the join key (`agent_session_id` from aoe's `sessions.json` ↔ `session_meta.payload.id` from the rollout file) should be exposed as a first-class link is an open design question — recommend yes, for the same reason claude-code/aoe cross-correlation was useful.

## Anti-patterns to avoid

- **Do not parse the rollout filename as the source of truth for session id.** Use `session_meta.payload.id` from the first record. Filename parsing is a perf shortcut, not a correctness primitive.
- **Do not assume JSON.parse will succeed on every line.** Tolerate unescaped control characters; log-and-skip bad lines.
- **Do not treat `session_index.jsonl` as the session catalog.** It's a curated subset.
- **Do not chdir blindly before `codex exec resume`.** The lookup-by-id does not require it. But pass `-C <session.cwd>` (or chdir) if you want the agent to see the original workspace for tool calls.
- **Do not use non-`--json` mode for the write path.** The banner output on stdout pollutes anything that wants to parse the response.
- **Do not call `codex exec` without `--skip-git-repo-check` outside a git repo.** It will refuse and exit non-zero. The aoe-wrapped flow doesn't hit this because aoe runs from within a worktree.
- **Do not read `~/.codex/auth.json`.** The adapter has no business with user credentials.

## Open items not yet probed

- `archived_sessions/` directory contents and rotation rules.
- `logs_2.sqlite` schema — possible push-stream substrate for `subscribe_events`.
- `state_5.sqlite` schema — possible source of in-progress state or running-session tracking.
- Concurrent `codex exec resume` on the same id — race semantics.
- Resume of an `--ephemeral` session — predicted to fail; not verified.
- Behavior with `-c model_provider=anthropic` or other non-OpenAI providers — schema may carry provider-specific fields not seen in this probe.
- `codex fork` semantics — does it produce a new UUID with a parent link in the new file's `session_meta`? Useful for resolver if so.
- Whether `codex exec resume` against a session currently open in the TUI causes corruption or just queues. (Claude Code has the same unknown.)
