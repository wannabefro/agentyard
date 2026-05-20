import type {
  Adapter,
  CreateSessionOpts,
  IdleWaitOptions,
  ListSessionsOptions,
  OutputSnapshot,
  ReadyWaitOptions,
  ReadyWaitResult,
  RemoveSessionOpts,
  SendResult,
} from "@/adapters/types.ts";
import type { Session, SessionStatus } from "@/core/session.ts";
import { findBinary, spawnEnv } from "@/core/spawn_env.ts";
import { AoeCliError, runJson, runRaw, runVoid } from "@/adapters/aoe/cli.ts";
import {
  aoeCaptureSchema,
  aoeListSchema,
  aoeSessionShowSchema,
  type AoeListEntry,
  type AoeSessionShow,
} from "@/adapters/aoe/schemas.ts";

const ADAPTER_NAME = "aoe";

// aoe's lifecycle commands (add / session start / session stop / session restart
// / remove) all mutate shared state — sessions.json and tmux session naming.
// Phase-3 dogfood (2026-05-20) observed `session start` failing with exit 1
// when invoked for two distinct session ids concurrently. Serialize all
// lifecycle calls adapter-wide. Read paths (list, show, capture, send) are
// safe to run in parallel and stay unlocked.
let aoeLifecycleQueue: Promise<unknown> = Promise.resolve();

function withAoeLifecycleLock<T>(fn: () => Promise<T>): Promise<T> {
  // Chain regardless of previous outcome so one failed call doesn't poison
  // the queue for everything behind it.
  const next = aoeLifecycleQueue.then(fn, fn);
  aoeLifecycleQueue = next;
  return next;
}

// aoe's tmux session naming convention is `aoe_<title>_<id[:8]>`. Rather
// than reconstructing the exact string (titles may be sanitized in ways we
// don't model), enumerate tmux sessions and find the one ending in
// `_<id[:8]>` — this is unambiguous since aoe ids are unique.
async function findAoeTmuxSession(id: string): Promise<string | null> {
  const idPrefix = id.slice(0, 8);
  const proc = Bun.spawn([findBinary("tmux"), "ls", "-F", "#{session_name}"], {
    env: spawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return null;
  const suffix = `_${idPrefix}`;
  for (const line of out.split("\n")) {
    const name = line.trim();
    if (name.endsWith(suffix)) return name;
  }
  return null;
}

async function sendBareEnter(id: string): Promise<SendResult> {
  const target = await findAoeTmuxSession(id);
  if (!target) {
    return {
      ok: false,
      reason: `no tmux session matching aoe_*_${id.slice(0, 8)} — session may be stopped or aoe naming changed`,
    };
  }
  // C-m is the canonical tmux key for Enter. "Enter" also works on most
  // tmux versions; C-m is the lower-level form, less likely to collide
  // with a literal "Enter" string.
  const proc = Bun.spawn([findBinary("tmux"), "send-keys", "-t", target, "C-m"], {
    env: spawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    return { ok: false, reason: `tmux send-keys -t ${target} C-m failed (exit ${code}): ${err.trim()}` };
  }
  return { ok: true };
}

// U+276F (heavy right-pointing angle quotation mark) — Claude Code prompt cursor.
// U+203A (single right-pointing angle quotation mark) — Codex CLI prompt cursor.
const KNOWN_PROMPT_CURSORS = ["❯", "›"] as const;

const SESSION_ID_RE = /^\s*ID:\s+([a-f0-9]+)\s*$/m;

function lastNonEmptyLine(content: string): string {
  const lines = content.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? "";
}

// How many of the most recent non-empty lines to scan for a prompt cursor.
// Recent Claude Code versions render a multi-line status footer below the
// input cursor (model name, ctx %, MCP status, hints), so the cursor is no
// longer the absolute trailing position. 20 lines comfortably spans those
// footers and any selector menus while staying tight enough to not match
// cursors embedded in scrollback content.
const PROMPT_SCAN_WINDOW = 20;

// How many lines on either side of a candidate cursor line to scan for
// menu-disambiguation signals (peer numbered options, navigation hints).
const MENU_DISAMBIG_WINDOW = 5;

// `❯ N. text` — the cursor sitting on a numbered menu option.
const NUMBERED_OPTION_RE = /^(\d+)\.\s+\S/;

// Navigation hints rendered by selector menus. Trust prompt: "Enter to
// confirm · Esc to cancel". Many other menus use "↑/↓" or "Tab".
const MENU_NAV_HINT_RE = /(enter to (confirm|select)|esc to (cancel|exit)|↑.{0,3}↓|use\s+(arrow|↑|↓))/i;

// Returns the most recent line that looks like a real prompt cursor line —
// cursor at line-start, optionally followed by free user input. Selector
// menus (cursor sitting on a numbered option with peer options or a nav
// hint nearby) are rejected and the scan continues looking further up the
// pane for a real prompt. Returns null if no real prompt cursor is in the
// recent window.
//
// Exported only for direct test coverage — production callers should use
// AoeAdapter.waitForReady.
export function findRecentPromptCursorLine(content: string): string | null {
  const lines = content
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const tail = lines.slice(-PROMPT_SCAN_WINDOW);
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = tail[i]!;
    const trimmed = line.trimStart();
    for (const cursor of KNOWN_PROMPT_CURSORS) {
      // Match "❯" alone or "❯ <anything>". Avoids matching a cursor
      // glyph embedded mid-word.
      if (trimmed === cursor || trimmed.startsWith(cursor + " ")) {
        if (isMenuCursor(tail, i, trimmed, cursor)) continue;
        return line;
      }
    }
  }
  return null;
}

// Companion scan for the rejected case: returns the most recent line that
// looks like a selector menu cursor (`❯ N. <text>` with peer options or
// nav-hint corroboration). Used only by waitForReady to produce a precise
// timeout reason when no real prompt was found.
export function findRecentMenuCursorLine(content: string): string | null {
  const lines = content
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const tail = lines.slice(-PROMPT_SCAN_WINDOW);
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = tail[i]!;
    const trimmed = line.trimStart();
    for (const cursor of KNOWN_PROMPT_CURSORS) {
      if (trimmed === cursor || trimmed.startsWith(cursor + " ")) {
        if (isMenuCursor(tail, i, trimmed, cursor)) return line;
      }
    }
  }
  return null;
}

function isMenuCursor(
  tail: string[],
  idx: number,
  trimmedCursorLine: string,
  cursor: string,
): boolean {
  const afterCursor = trimmedCursorLine.slice(cursor.length).trimStart();
  const cursorMatch = NUMBERED_OPTION_RE.exec(afterCursor);
  if (!cursorMatch) return false;
  const cursorNumber = cursorMatch[1];

  // Scan a small window around the candidate for corroborating signals.
  // A real prompt with the user typing "1. foo" has no peer numbered line
  // and no nav hint — it falls through to "not a menu". A selector menu
  // typically has at least one of these.
  const lo = Math.max(0, idx - MENU_DISAMBIG_WINDOW);
  const hi = Math.min(tail.length - 1, idx + MENU_DISAMBIG_WINDOW);
  for (let j = lo; j <= hi; j += 1) {
    if (j === idx) continue;
    const peer = tail[j]!.trimStart();
    const peerMatch = NUMBERED_OPTION_RE.exec(peer);
    if (peerMatch && peerMatch[1] !== cursorNumber) return true;
    if (MENU_NAV_HINT_RE.test(peer)) return true;
  }
  return false;
}

function parseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function entryToSession(
  entry: AoeListEntry,
  status: SessionStatus = "unknown",
  summary: string | null = null,
): Session {
  return {
    adapter: ADAPTER_NAME,
    id: entry.id,
    title: entry.title,
    tool: entry.tool,
    status,
    workdir: entry.path,
    branch: entry.worktree?.branch ?? null,
    repoRoot: entry.worktree?.main_repo_path ?? null,
    group: entry.group || null,
    profile: entry.profile,
    createdAt: parseDate(entry.created_at),
    lastActivityAt: null,
    idleSinceAt: null,
    nativeSessionId: null,
    summary,
    raw: entry,
  };
}

// Cap the per-session summary so the field is small enough to ride along on
// list_sessions output without blowing the host's context budget. We collapse
// whitespace then take the TAIL — recent activity beats startup banners, but
// we need enough chars to span the work narrative AND the wrap-up. Empirically
// (404-mt aoe session, 5m of activity) 500 chars only catches the wrap-up,
// which is content-poor; 1500 chars catches the narrative too.
const SUMMARY_MAX_CHARS = 1500;
const SUMMARY_CAPTURE_LINES = 120;

function condenseSummary(content: string): string {
  const collapsed = content.replace(/[ \t]+/g, " ").trim();
  if (collapsed.length <= SUMMARY_MAX_CHARS) return collapsed;
  return "…" + collapsed.slice(-SUMMARY_MAX_CHARS);
}

async function summaryFor(id: string): Promise<string | null> {
  try {
    const capture = await runJson(aoeCaptureSchema, [
      "session",
      "capture",
      id,
      "--json",
      "--strip-ansi",
      "-n",
      String(SUMMARY_CAPTURE_LINES),
    ]);
    return condenseSummary(capture.content);
  } catch {
    // Capture failures shouldn't fail the whole list. Sessions in error
    // state are common in this user's catalog and may not have capturable
    // panes.
    return null;
  }
}

function showToSession(show: AoeSessionShow, base: Session | null): Session {
  return {
    adapter: ADAPTER_NAME,
    id: show.id,
    title: show.title,
    tool: show.tool,
    status: show.status,
    workdir: show.path,
    branch: base?.branch ?? null,
    repoRoot: base?.repoRoot ?? null,
    group: show.group || null,
    profile: show.profile,
    createdAt: base?.createdAt ?? null,
    lastActivityAt: null,
    idleSinceAt: null,
    nativeSessionId: null,
    summary: base?.summary ?? null,
    raw: { show, list: base?.raw ?? null },
  };
}

export class AoeAdapter implements Adapter {
  readonly name = ADAPTER_NAME;

  async listSessions(opts: ListSessionsOptions = {}): Promise<Session[]> {
    const wantSummary = opts.withSummary === true;
    const entries = await runJson(aoeListSchema, ["list", "--json"]);
    const enriched = await Promise.all(
      entries.map(async (e) => {
        const [show, summary] = await Promise.all([
          runJson(aoeSessionShowSchema, [
            "session",
            "show",
            e.id,
            "--json",
          ]).catch(() => null),
          // Skip the expensive per-session aoe capture unless requested.
          // For N sessions the unfiltered path fires N captures even when
          // the caller only wants list_sessions to enumerate ids/titles.
          wantSummary ? summaryFor(e.id) : Promise.resolve(null),
        ]);
        return entryToSession(e, show?.status ?? "unknown", summary);
      }),
    );
    return enriched;
  }

  async getSession(id: string): Promise<Session | null> {
    const [show, list] = await Promise.all([
      runJson(aoeSessionShowSchema, ["session", "show", id, "--json"]).catch(
        () => null,
      ),
      runJson(aoeListSchema, ["list", "--json"]),
    ]);
    if (!show) return null;
    const base = list.find((e) => e.id === show.id);
    return showToSession(show, base ? entryToSession(base) : null);
  }

  async getOutput(id: string, lines = 200): Promise<OutputSnapshot> {
    try {
      const capture = await runJson(aoeCaptureSchema, [
        "session",
        "capture",
        id,
        "--json",
        "--strip-ansi",
        "-n",
        String(lines),
      ]);
      return { content: capture.content, lines: capture.lines };
    } catch (err) {
      // Match the graceful "session not found" pattern used by
      // claude-code's getOutput and by AoeAdapter.getSession itself.
      // Loop primitives (waitIdle / sendThenWait) call getOutput in
      // polling loops; if the session disappeared mid-flight we want
      // them to observe an empty pane, not hard-throw and abort cleanup.
      // Other CLI errors (aoe daemon missing, permission denied) still
      // propagate.
      if (err instanceof AoeCliError && /session not found/i.test(err.stderr)) {
        return { content: "", lines: 0 };
      }
      throw err;
    }
  }

  async sendInput(id: string, text: string): Promise<SendResult> {
    // aoe's CLI hard-rejects empty messages ("Message cannot be empty"),
    // but the MCP schema admits empty for bare-Enter semantics. When the
    // caller asks for an empty send (e.g. to confirm a default selection
    // in a TUI prompt), bypass `aoe send` and push Enter into aoe's tmux
    // pane directly. The tmux session name follows aoe's convention
    // `aoe_<title>_<id[:8]>`; we resolve it by id-prefix match rather than
    // composing it ourselves, since aoe may sanitize titles in ways we
    // don't fully model.
    if (text === "") return sendBareEnter(id);
    try {
      await runVoid(["send", id, text]);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async waitIdle(
    id: string,
    opts: IdleWaitOptions,
  ): Promise<{ settled: boolean; lastSnapshot: OutputSnapshot }> {
    const pollMs = opts.pollIntervalMs ?? 1000;
    const deadline = Date.now() + opts.timeoutMs;
    let lastSnapshot = await this.getOutput(id);
    let lastChangedAt = Date.now();
    let lastContent = lastSnapshot.content;

    while (Date.now() < deadline) {
      await Bun.sleep(pollMs);
      const snap = await this.getOutput(id);
      if (snap.content !== lastContent) {
        lastContent = snap.content;
        lastChangedAt = Date.now();
      }
      lastSnapshot = snap;
      if (Date.now() - lastChangedAt >= opts.idleWindowMs) {
        return { settled: true, lastSnapshot };
      }
    }
    return { settled: false, lastSnapshot };
  }

  async createSession(opts: CreateSessionOpts): Promise<{ id: string; title: string }> {
    return withAoeLifecycleLock(async () => {
      const argv = ["add", opts.path];
      if (opts.title) argv.push("--title", opts.title);
      if (opts.cmd) argv.push("--cmd", opts.cmd);
      const { stdout } = await runRaw(argv);
      const match = SESSION_ID_RE.exec(stdout);
      if (!match || !match[1]) {
        throw new Error(`aoe add did not return a session ID in stdout:\n${stdout}`);
      }
      return { id: match[1], title: opts.title ?? match[1] };
    });
  }

  async startSession(id: string): Promise<void> {
    await withAoeLifecycleLock(() => runVoid(["session", "start", id]));
  }

  async stopSession(id: string): Promise<void> {
    await withAoeLifecycleLock(() => runVoid(["session", "stop", id]));
  }

  async restartSession(id: string): Promise<void> {
    await withAoeLifecycleLock(() => runVoid(["session", "restart", id]));
  }

  async removeSession(id: string, opts: RemoveSessionOpts = {}): Promise<void> {
    await withAoeLifecycleLock(() => {
      const argv = ["remove", id];
      if (opts.deleteWorktree) argv.push("--delete-worktree");
      if (opts.deleteBranch) argv.push("--delete-branch");
      if (opts.force) argv.push("--force");
      return runVoid(argv);
    });
  }

  async waitForReady(id: string, opts: ReadyWaitOptions): Promise<ReadyWaitResult> {
    const pollMs = opts.pollIntervalMs ?? 500;
    const deadline = Date.now() + opts.timeoutMs;

    while (Date.now() < deadline) {
      const snap = await this.getOutput(id, 30);
      const cursorLine = findRecentPromptCursorLine(snap.content);
      if (cursorLine !== null) {
        return { ready: true, lastLine: cursorLine };
      }
      await Bun.sleep(pollMs);
    }

    // For the timeout reason we surface the actual trailing line so the
    // caller can see what the agent was rendering instead of a prompt.
    // If we detected a menu cursor (rejected from the ready check) the
    // caller gets a more actionable reason — dismiss the menu before
    // sending text.
    const snap = await this.getOutput(id, 30);
    const menuLine = findRecentMenuCursorLine(snap.content);
    if (menuLine !== null) {
      return {
        ready: false,
        reason: `agent showing a selector menu; dismiss it (e.g. send_input("") for default, or send_input("<digit>") for a specific option) before sending text`,
        lastLine: menuLine,
      };
    }
    const lastLine = lastNonEmptyLine(snap.content);
    return {
      ready: false,
      reason: `prompt cursor not detected within ${opts.timeoutMs}ms`,
      lastLine,
    };
  }
}
