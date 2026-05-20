# Conductor.build — preliminary research notes

**Status:** Tabled behind the Claude Code adapter. These notes are a preliminary exploration captured to avoid re-discovery, not a complete adapter spec. Treat as starting hints; verify everything before relying on it.

## Identity

- Product: [Conductor.build](https://conductor.build) — macOS desktop app for orchestrating multiple Claude Code sessions across worktrees, by Melty Labs.
- Distribution: native macOS `.app` bundle (electron-style), not a CLI.
- Storage: local SQLite database — no daemon, no public API.

## On-disk surface

```
~/Library/Application Support/com.conductor.app/
├── conductor.db            # primary SQLite store (~100MB on this user's machine)
├── conductor.db-shm        # SQLite shared memory
├── conductor.db-wal        # SQLite write-ahead log
├── .window-state.json      # UI window position state
├── app-icons/              # cached app icons
└── bin/                    # bundled binaries
```

The presence of `-wal` and `-shm` files means the app uses SQLite in WAL mode and may be holding write locks while running. An adapter that opens the DB read-only must use `mode=ro` (or better, the Bun SQLite `readonly: true` open flag) and may need `PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint;` semantics if reads need to see the latest committed state.

On this user's machine at the time of probing: ~40 sessions tracked, ~100MB DB.

## Open questions (need verification before adapter work begins)

- **Schema.** Tables and columns are not documented externally. `sqlite3 conductor.db .schema` against a quiescent copy is the first step. Expect tables for sessions, messages, worktrees, possibly tool calls.
- **Concurrency.** Whether the Conductor app holds an exclusive lock while running or just regular WAL writes. If the former, the adapter would need to copy the DB or coordinate with the app.
- **Process model.** Does Conductor spawn separate Claude Code processes per session, or proxy through its own runtime? This affects whether the adapter can send input (probably no — it has to go through the GUI's IPC) or only read state (probably yes).
- **Session identifiers.** Whether Conductor uses Claude Code's native session UUIDs (the same ones in `~/.claude/projects/`) or its own surrogate IDs. If the former, a Conductor adapter overlaps significantly with the Claude Code transcript adapter — and the better cross-correlation is to read transcripts directly.
- **Push surface.** None known. If real-time is wanted, the adapter polls.

## Why deferred

The Claude Code adapter (reading `~/.claude/projects/*.jsonl` directly) is a strictly simpler integration target with the same end-user value — transcripts are the source of truth that Conductor itself is presumably reading or correlating with. Once that adapter exists, the residual value of a Conductor adapter is: (a) human-readable session titles set in Conductor's UI, (b) the user's worktree groupings as configured in Conductor. Both are nice-to-have but neither is gating.

If revived later: probe the schema against a quiescent DB copy first, document tables in this file, then decide whether the adapter wraps the DB directly or piggybacks on whatever the Claude Code adapter already produces.
