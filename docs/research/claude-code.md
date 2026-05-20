# Claude Code transcripts — research notes

Raw findings from probing a live install (`~/.claude/projects/`) on macOS, captured to inform the Claude Code adapter. Verify each "assumption" item against the actual transcript before relying on it.

## Identity

- Source: Claude Code CLI — Anthropic's official CLI for Claude. The transcripts are an undocumented internal format, not a public SDK surface.
- Probed version: `2.1.145` (visible in the `version` field of user/assistant records).
- Format: newline-delimited JSON (`.jsonl`), one record per line, **append-only** during a session.
- Multiple record `type`s coexist in one file. The file is not just a chat log — it interleaves messages, metadata, permission changes, file-history snapshots, and live state pointers.

## On-disk layout

```
~/.claude/projects/
├── <encoded-cwd>/                          # one directory per project working dir
│   ├── <session-uuid>.jsonl                # transcript for that session
│   ├── <session-uuid>/                     # only exists if that session spawned subagents
│   │   └── subagents/
│   │       ├── agent-<id>.jsonl            # subagent transcript
│   │       └── agent-<id>.meta.json        # subagent metadata (see below)
│   └── memory/                             # auto-memory store (cross-session, project-scoped)
│       ├── MEMORY.md
│       └── <named>.md
└── ...
```

On this machine: 252 project directories, ranging from active workspaces to one-off `/tmp` paths and skill-eval scratch dirs.

### Path encoding is lossy

The encoded directory name is `path.replace('/', '-').replace('.', '-')`. Both `/` and `.` collapse to a single `-`. Examples observed:

| Real cwd | Encoded directory |
|----------|-------------------|
| `/Users/sam.mctaggart/Dev/pepper` | `-Users-sam-mctaggart-Dev-pepper` |
| `/Users/sam.mctaggart/.claude` | `-Users-sam-mctaggart--claude` |
| `/Users/sam.mctaggart/code/worktrees/app/authorise-jobs` | `-Users-sam-mctaggart-code-worktrees-app-authorise-jobs` |

**Consequence:** you cannot recover the real cwd from the directory name. The adapter must read the `cwd` field from inside the transcript records (`user` and `assistant` records both carry it) to know the actual project path. Don't write a decoder — it would be wrong for any path containing `.` characters.

### Subagent meta.json

Sibling to each `agent-<id>.jsonl`:

```json
{
  "agentType": "claude",
  "worktreePath": "/Users/sam.mctaggart/Dev/pepper/.claude/worktrees/agent-a09dd16993b40efcb",
  "description": "Lane B: resolver tests + README",
  "name": "lane-b-polish",
  "toolUseId": "toolu_01CQJ7eVCQrqxjrtN5jKvJt3"
}
```

Resolver gold: `name` and `description` are user-facing, free-text, and exactly match the labels the user sees in the Claude Code UI when dispatching agents. Fuzzy-match against these.

### `isSidechain` is unreliable

A 2.5MB transcript that spawned three subagents had **zero** records with `isSidechain=true`. Subagent transcripts live in their own files. Do not try to extract subagent content from the parent transcript via `isSidechain`.

## Record types

Observed in the wild (across two transcripts on this machine):

| Type | Purpose | Cardinality |
|------|---------|-------------|
| `user` | user input + tool results | many |
| `assistant` | assistant turns (with content arrays incl. `thinking`, `tool_use`, `text`) | many |
| `attachment` | system-injected context (deferred-tools delta, MCP instructions, skill listings, hook results, output style, auto-mode flag) | many |
| `system` | local command stdout (e.g., `/clear` output) | many |
| `file-history-snapshot` | tracked-file backup checkpoints — internal undo support | many |
| `ai-title` | auto-generated session title — **overwritten throughout the file; last wins** | many |
| `last-prompt` | pointer to the most recent user prompt + its leaf UUID — **overwritten throughout the file; last wins** | many |
| `permission-mode` | records `permissionMode` transitions (`default`, `acceptEdits`, `auto`, etc.) | many |
| `queue-operation` | message-queue state changes | several |

**Assume schema growth.** The 2.5MB sample had `permission-mode` and `queue-operation` types that the 148K sample did not. The adapter must be tolerant — unknown types must not error.

## Stable fields on `user` / `assistant` records

Verified present on every sampled user/assistant record:

- `uuid` — record ID (UUIDv4)
- `parentUuid` — chain pointer, forms a DAG of the conversation
- `sessionId` — session UUID (matches the filename)
- `timestamp` — ISO 8601 UTC
- `cwd` — absolute path to the working directory **(authoritative — use this, not the directory name)**
- `gitBranch` — current git branch at the time the record was written
- `version` — Claude Code version string
- `userType` — `external` for normal user input, `internal` for tool-result-shaped records
- `entrypoint` — `cli` in all sampled cases
- `isSidechain` — boolean, see warning above
- `message` — for `user`: `{role: "user", content: string | Array<...>}`; for `assistant`: full Anthropic-API message object including `model`, `content`, `usage`, `stop_reason`

`assistant.message.content` is a typed array — items can be `thinking`, `tool_use`, `text`, `redacted_thinking`. `user.message.content` can be a plain string (first prompt) or an array of `{type: "tool_result", tool_use_id, content}` items for tool results.

## Models

`assistant.message.model` is the model that produced that turn. Observed values: `claude-opus-4-7`, `<synthetic>`. The `<synthetic>` placeholder appears for records the transcript backfills on resume — not a real model. Skip or display as "(resumed)".

## Activity signal

Three viable signals, in order of cost:

1. **File mtime** (`stat`) — cheapest. Updates on every append. Good enough for "when was this session last active."
2. **Last record's `timestamp`** — requires reading the tail of the file. More accurate (mtime can drift on copy, sync). Use when ranking.
3. **Most recent `last-prompt` record** — gives the *prompt-level* last activity (vs. tool-use noise). Useful for "when did the user last say something."

Recommend: use mtime for the bulk-list path, parse the last few lines for ranking and detail views.

## Concurrent-read safety

`.jsonl` is append-only by design — readers and writers do not conflict. Bun's `Bun.file(path).text()` and line-by-line streaming both work while Claude Code is actively writing. **However**, a record being written mid-line will appear as a partial JSON line to a tail-reader; tolerate `JSON.parse` failures on the final line and retry.

## Session identifier vs filename

The filename `<uuid>.jsonl` matches `sessionId` inside records — verified on two samples. This is the same ID format that appears as `agent_session_id` in aoe's `sessions.json`, which means **the join key to the aoe adapter is the file basename**. This is exactly the cross-correlation the project's `CLAUDE.md` predicted.

## What does "list" mean for transcripts?

Each `<uuid>.jsonl` is a *session*. So `listSessions()` walks the projects tree:

```
for projectDir in ~/.claude/projects/*:
    for sessionFile in projectDir/*.jsonl:
        yield Session(adapter="claude-code", id=basename-without-ext, ...)
```

A scan of 252 project dirs returned in well under a second when not parsing file contents (just listing). For metadata enrichment (title, cwd, last activity, git branch), read the last few KB of each file. For full message extraction, read the whole file.

## What does "get output" mean for transcripts?

`OutputSnapshot.text` in the current contract is a flat string designed for a tmux pane. For a transcript, the natural shape is:

- **Recent N records** rendered as text (user turns + final assistant text blocks, skipping `thinking` and `tool_use` plumbing unless asked).
- Or: structured access (extracted `text` blocks + `tool_use` summary). Would require a contract change.

This is one of the contract-pressure points for the adapter brainstorm.

## Subagent transcripts as separate sessions vs sub-objects

Two reasonable models:

- **(a) Each agent-<id>.jsonl is a separate `Session`** with its own ID. The parent session is a peer in `listSessions()`. Consistent with the current contract's flat session model. Resolver can match against the subagent `name`/`description`.
- **(b) Subagents are children of their parent session**, surfaced via a new adapter capability (e.g., `getSubagents(id)`). Cleaner conceptual model but requires extending the contract.

Recommend (a) for the first cut. Subagent meta is fundamentally session-shaped (name, worktree, description, type), and the user can already say "the lane-b-polish session" without caring whether it's a parent or a subagent.

## sendInput at v0.1 — deferred decision

The user deferred this until research was in. Options reconsidered with on-disk evidence in hand:

- **Read-only.** The adapter writes nothing. `sendInput` throws or is omitted (see contract brainstorm). Cleanest first ship.
- **`claude --resume <session-id>`.** Spawns a new Claude Code process with the given session loaded, sends a prompt, exits. *Untested* — needs verification of: does `--resume` actually exist? does it accept `-p <prompt>` for non-interactive use? does it append to the original session file or fork to a new one? If it forks, then the "session-id we sent to" is no longer the session-id we see in subsequent `listSessions` calls — bad.
- **Append-to-jsonl directly.** Tempting and trivial, but Claude Code is the writer; injecting records that the writer didn't emit will at minimum corrupt the in-process state if the session is live. Reject.

Recommend: ship v0.1 read-only. Probe `claude --resume` capability separately and revisit for v0.2 only if it cleanly supports non-interactive prompt injection.

## Anti-patterns to avoid

- Do not decode the encoded directory name to reconstruct the cwd. Read it from inside the transcript.
- Do not assume the schema is closed. Unknown `type` values are normal; ignore them rather than throwing.
- Do not assume the last line is complete JSON when reading a live transcript. Tolerate one truncated line at EOF.
- Do not treat `isSidechain=true` as the way to find subagent content. The flag is unused in practice; subagents are separate files.
- Do not read full files just to list sessions. Walk filenames first; enrich lazily.
