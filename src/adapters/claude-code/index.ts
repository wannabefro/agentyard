import { homedir } from "node:os";
import { join } from "node:path";

import type {
  Adapter,
  ListSessionsOptions,
  OutputSnapshot,
  SendThenWaitOptions,
  SendThenWaitResult,
} from "@/adapters/types.ts";
import type { Session } from "@/core/session.ts";
import { ensureSpawnCwd, findBinary, spawnEnv } from "@/core/spawn_env.ts";
import {
  discoverTranscripts,
  extractMessages,
  readAllRecords,
  renderConversation,
  summarize,
  type DiscoveredTranscript,
  type TranscriptSummary,
} from "@/adapters/claude-code/transcripts.ts";

const ADAPTER_NAME = "claude-code";

export type ClaudeCodeAdapterOptions = {
  projectsRoot?: string;
};

export class ClaudeCodeAdapter implements Adapter {
  readonly name = ADAPTER_NAME;
  readonly projectsRoot: string;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.projectsRoot = opts.projectsRoot ?? join(homedir(), ".claude", "projects");
  }

  // `opts` is accepted for interface conformance; the in-process transcript
  // summarize is cheap (no subprocess fan-out) so claude-code always returns
  // a populated summary. The MCP layer is responsible for stripping it from
  // the response when the caller didn't ask for it.
  async listSessions(_opts: ListSessionsOptions = {}): Promise<Session[]> {
    const transcripts = await discoverTranscripts(this.projectsRoot);
    const sessions: Session[] = [];
    for (const t of transcripts) {
      const records = await readAllRecords(t.path);
      const summary = summarize(records);
      sessions.push(buildSession(t, summary));
    }
    return sessions;
  }

  async getSession(id: string): Promise<Session | null> {
    const transcripts = await discoverTranscripts(this.projectsRoot);
    const match = transcripts.find((t) => t.sessionId === id);
    if (!match) return null;
    const records = await readAllRecords(match.path);
    return buildSession(match, summarize(records));
  }

  async getOutput(id: string, lines = 200): Promise<OutputSnapshot> {
    const transcripts = await discoverTranscripts(this.projectsRoot);
    const match = transcripts.find((t) => t.sessionId === id);
    if (!match) return { content: "", lines: 0 };
    const records = await readAllRecords(match.path);
    const content = renderConversation(records, { maxRecords: lines });
    const structured = extractMessages(records, { maxRecords: lines });
    return {
      content,
      lines: content ? content.split("\n").length : 0,
      structured,
    };
  }

  // Write path: spawn `claude --resume <id> --print --output-format json <text>`
  // from the session's original cwd, append one turn to the transcript, return
  // before/after snapshots. See docs/research/claude-code.md ("Write support")
  // for the empirical findings that informed this contract — notably the
  // cwd-dependency of --resume, the JSON output schema, and the per-turn
  // cache-creation cost (~$0.35/turn at the time of writing).
  //
  // sendInput is intentionally NOT implemented. The underlying CLI is
  // fundamentally synchronous (one subprocess = one full agent turn), so
  // claiming fire-and-forget would be a misleading contract. Hosts that
  // want fire-and-forget should use aoe; hosts that need guaranteed
  // delivery should use sendThenWait on either adapter.
  async sendThenWait(
    id: string,
    text: string,
    _opts: SendThenWaitOptions,
  ): Promise<SendThenWaitResult> {
    const started = Date.now();
    const session = await this.getSession(id);
    if (!session) {
      const empty: OutputSnapshot = { content: "", lines: 0 };
      return {
        ok: false,
        changed: false,
        settled: false,
        before: empty,
        after: empty,
        elapsedMs: Date.now() - started,
        reason: `session ${id} not found`,
      };
    }
    if (!session.workdir) {
      const empty: OutputSnapshot = { content: "", lines: 0 };
      return {
        ok: false,
        changed: false,
        settled: false,
        before: empty,
        after: empty,
        elapsedMs: Date.now() - started,
        reason: `session ${id} has no cwd recorded in the transcript — cannot resume`,
      };
    }

    const before = await this.getOutput(id, 200);

    // `claude --resume` is cwd-dependent (see docs/research/claude-code.md):
    // it derives the session-file path from the cwd at session creation, so
    // resuming from a different cwd fails with "No conversation found".
    // The research doc notes that if the original cwd path is gone, an
    // empty directory at that path is sufficient. ensureSpawnCwd with
    // "create" policy handles both the existing-dir and recreate cases.
    const cwdResolved = await ensureSpawnCwd(session.workdir, "create");
    if (cwdResolved.warning) console.error(`[claude-code] ${cwdResolved.warning}`);
    const proc = Bun.spawn(
      [findBinary("claude"), "--resume", id, "--print", "--output-format", "json", text],
      {
        cwd: cwdResolved.cwd,
        env: spawnEnv(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      const after = await this.getOutput(id, 200);
      return {
        ok: false,
        changed: after.content !== before.content,
        settled: true,
        before,
        after,
        elapsedMs: Date.now() - started,
        reason: `claude --resume exit ${exitCode}: ${stderrText.trim() || stdoutText.trim().slice(0, 240)}`,
      };
    }

    // The CLI emits a single JSON object on stdout. Tolerate stray
    // diagnostics by parsing the LAST line that looks like a complete
    // JSON object.
    const parsed = parseClaudePrintResult(stdoutText);
    const after = await this.getOutput(id, 200);
    const changed = after.content !== before.content;

    if (!parsed) {
      return {
        ok: false,
        changed,
        settled: true,
        before,
        after,
        elapsedMs: Date.now() - started,
        reason: `claude --resume succeeded but stdout did not contain a parseable JSON result: ${stdoutText.slice(0, 240)}`,
      };
    }
    if (parsed.is_error) {
      return {
        ok: false,
        changed,
        settled: true,
        before,
        after,
        elapsedMs: Date.now() - started,
        reason: parsed.api_error_status
          ? `claude returned api_error_status=${parsed.api_error_status}`
          : `claude --print reported is_error=true (subtype=${parsed.subtype ?? "unknown"})`,
      };
    }

    return {
      ok: true,
      changed,
      settled: true,
      before,
      after,
      elapsedMs: Date.now() - started,
    };
  }
}

// Subset of the JSON object emitted by `claude --print --output-format json`.
// We only consume the fields that affect orchestration decisions; the full
// schema (usage, modelUsage, permission_denials, etc.) is captured in
// docs/research/claude-code.md.
type ClaudePrintResult = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: string | null;
  result?: string;
  session_id?: string;
};

// Exported for direct test coverage of the JSON parsing path.
export function parseClaudePrintResult(stdout: string): ClaudePrintResult | null {
  // The CLI typically prints one JSON object on a single line. Walk lines
  // backward and return the first that parses to an object with a "type"
  // field — robust to any leading diagnostic output.
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(lines[i]!) as ClaudePrintResult;
      if (obj && typeof obj === "object" && typeof obj.type === "string") return obj;
    } catch {
      // Try the next-most-recent line.
    }
  }
  return null;
}

// Mirror of aoe's summary cap so search behavior is consistent across adapters.
const SUMMARY_MAX_CHARS = 500;

function condenseSummary(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SUMMARY_MAX_CHARS) return collapsed;
  return collapsed.slice(0, SUMMARY_MAX_CHARS) + "…";
}

function buildSession(
  t: DiscoveredTranscript,
  summary: TranscriptSummary,
): Session {
  const last = summary.lastTimestamp ? new Date(summary.lastTimestamp) : t.mtime;
  const first = summary.firstTimestamp ? new Date(summary.firstTimestamp) : null;
  return {
    adapter: ADAPTER_NAME,
    id: t.sessionId,
    title: summary.title ?? "(untitled)",
    tool: "claude",
    status: "unknown",
    workdir: summary.cwd ?? "",
    branch: summary.branch,
    repoRoot: null,
    group: null,
    profile: null,
    createdAt: first,
    lastActivityAt: last,
    idleSinceAt: null,
    nativeSessionId: summary.sessionId,
    // lastPrompt captures what the user most recently asked the agent to do —
    // a strong signal for resolver queries. Falls back to title (often a
    // descriptive ai-generated phrase) when no prompt was recorded.
    summary: summary.lastPrompt
      ? condenseSummary(summary.lastPrompt)
      : summary.title
      ? condenseSummary(summary.title)
      : null,
    raw: summary,
  };
}
