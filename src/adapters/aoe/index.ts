import type {
  Adapter,
  CreateSessionOpts,
  IdleWaitOptions,
  OutputSnapshot,
  ReadyWaitOptions,
  ReadyWaitResult,
  RemoveSessionOpts,
  SendResult,
} from "@/adapters/types.ts";
import type { Session, SessionStatus } from "@/core/session.ts";
import { AoeCliError, runJson, runRaw, runVoid } from "@/adapters/aoe/cli.ts";
import {
  aoeCaptureSchema,
  aoeListSchema,
  aoeSessionShowSchema,
  type AoeListEntry,
  type AoeSessionShow,
} from "@/adapters/aoe/schemas.ts";

const ADAPTER_NAME = "aoe";

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

// Returns the most recent line that looks like a prompt-cursor line
// (cursor at line-start, optionally followed by whitespace or menu/text),
// or null if no such line is in the recent pane window. This replaces the
// older "lastNonEmptyLine ends with cursor" heuristic, which broke when
// agents started rendering footers below the input.
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
        return line;
      }
    }
  }
  return null;
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

  async listSessions(): Promise<Session[]> {
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
          summaryFor(e.id),
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
    const argv = ["add", opts.path];
    if (opts.title) argv.push("--title", opts.title);
    if (opts.cmd) argv.push("--cmd", opts.cmd);
    const { stdout } = await runRaw(argv);
    const match = SESSION_ID_RE.exec(stdout);
    if (!match || !match[1]) {
      throw new Error(`aoe add did not return a session ID in stdout:\n${stdout}`);
    }
    return { id: match[1], title: opts.title ?? match[1] };
  }

  async startSession(id: string): Promise<void> {
    await runVoid(["session", "start", id]);
  }

  async stopSession(id: string): Promise<void> {
    await runVoid(["session", "stop", id]);
  }

  async restartSession(id: string): Promise<void> {
    await runVoid(["session", "restart", id]);
  }

  async removeSession(id: string, opts: RemoveSessionOpts = {}): Promise<void> {
    const argv = ["remove", id];
    if (opts.deleteWorktree) argv.push("--delete-worktree");
    if (opts.deleteBranch) argv.push("--delete-branch");
    if (opts.force) argv.push("--force");
    await runVoid(argv);
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
    const snap = await this.getOutput(id, 30);
    const lastLine = lastNonEmptyLine(snap.content);
    return {
      ready: false,
      reason: `prompt cursor not detected within ${opts.timeoutMs}ms`,
      lastLine,
    };
  }
}
