import { unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Adapter,
  ListSessionsOptions,
  OutputSnapshot,
  SendThenWaitOptions,
  SendThenWaitResult,
} from "@/adapters/types.ts";
import type { Session } from "@/core/session.ts";
import { spawnEnv } from "@/core/spawn_env.ts";
import {
  discoverRollouts,
  extractMessages,
  readAllRecords,
  readThreadIndex,
  renderConversation,
  summarize,
  type DiscoveredRollout,
  type RolloutSummary,
  type ThreadIndexEntry,
} from "@/adapters/codex/rollouts.ts";

const ADAPTER_NAME = "codex";
const SUMMARY_MAX_CHARS = 500;

export type CodexAdapterOptions = {
  codexHome?: string;
};

export class CodexAdapter implements Adapter {
  readonly name = ADAPTER_NAME;
  readonly codexHome: string;
  readonly sessionsRoot: string;
  readonly threadIndexPath: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.codexHome = opts.codexHome ?? join(homedir(), ".codex");
    this.sessionsRoot = join(this.codexHome, "sessions");
    this.threadIndexPath = join(this.codexHome, "session_index.jsonl");
  }

  async listSessions(_opts: ListSessionsOptions = {}): Promise<Session[]> {
    const [rollouts, threadIndex] = await Promise.all([
      discoverRollouts(this.sessionsRoot),
      readThreadIndex(this.threadIndexPath),
    ]);
    const sessions: Session[] = [];
    for (const r of rollouts) {
      const records = await readAllRecords(r.path);
      const summary = summarize(records);
      sessions.push(buildSession(r, summary, threadIndex.get(r.sessionId) ?? null));
    }
    return sessions;
  }

  async getSession(id: string): Promise<Session | null> {
    const rollouts = await discoverRollouts(this.sessionsRoot);
    const match = rollouts.find((r) => r.sessionId === id);
    if (!match) return null;
    const records = await readAllRecords(match.path);
    const threadIndex = await readThreadIndex(this.threadIndexPath);
    return buildSession(match, summarize(records), threadIndex.get(id) ?? null);
  }

  async getOutput(id: string, lines = 200): Promise<OutputSnapshot> {
    const rollouts = await discoverRollouts(this.sessionsRoot);
    const match = rollouts.find((r) => r.sessionId === id);
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

  // Write path: spawn `codex exec resume <id> <text> --json -o <tmpfile>` from
  // the session's recorded cwd, append one agent turn to the rollout JSONL,
  // return before/after snapshots. See docs/research/codex.md ("Write path")
  // for the empirical findings. Notable differences from claude-code:
  //   - cwd is NOT required for the id lookup (codex resume is path-agnostic)
  //     but we still chdir to session.workdir so the agent's tool calls
  //     operate against the original workspace.
  //   - The stdout JSON schema is an event stream (thread.started / turn.started
  //     / item.completed / turn.completed) — NOT the single-object shape
  //     claude --print returns. We parse for turn.completed as the success
  //     signal and read the final message from -o <tmpfile>.
  //   - Cache amortizes across resumes (~30% hit on the second turn),
  //     so this is meaningfully cheaper than claude --resume for multi-turn loops.
  //
  // sendInput is intentionally NOT implemented. Same reasoning as claude-code:
  // the subprocess is fundamentally synchronous, fire-and-forget would be a
  // misleading contract.
  async sendThenWait(
    id: string,
    text: string,
    _opts: SendThenWaitOptions,
  ): Promise<SendThenWaitResult> {
    const started = Date.now();
    const session = await this.getSession(id);
    const empty: OutputSnapshot = { content: "", lines: 0 };
    if (!session) {
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

    const before = await this.getOutput(id, 200);
    const lastMsgFile = join(tmpdir(), `agentyard-codex-${id}-${Date.now()}.txt`);

    // --skip-git-repo-check is defensive: codex refuses to resume outside a
    // git repo by default, and not every session.workdir is one (e.g.
    // /private/tmp scratch sessions). The flag is harmless when cwd IS a
    // repo. --json keeps stdout to a clean event stream so any banner noise
    // codex would otherwise print is suppressed.
    const args = [
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--json",
      "-o",
      lastMsgFile,
      id,
      text,
    ];
    const proc = Bun.spawn(["codex", ...args], {
      cwd: session.workdir || process.cwd(),
      env: spawnEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const after = await this.getOutput(id, 200);
    const changed = after.content !== before.content;

    if (exitCode !== 0) {
      await safeUnlink(lastMsgFile);
      return {
        ok: false,
        changed,
        settled: true,
        before,
        after,
        elapsedMs: Date.now() - started,
        reason: `codex exec resume exit ${exitCode}: ${stderrText.trim() || stdoutText.trim().slice(0, 240)}`,
      };
    }

    const events = parseEventStream(stdoutText);
    const turnCompleted = events.find((e) => e.type === "turn.completed");
    let finalText: string | null = null;
    try {
      const txt = await Bun.file(lastMsgFile).text();
      finalText = txt.length > 0 ? txt : null;
    } catch {
      // -o file may not exist if the run produced no agent_message at all
    }
    await safeUnlink(lastMsgFile);

    if (!turnCompleted) {
      return {
        ok: false,
        changed,
        settled: true,
        before,
        after,
        elapsedMs: Date.now() - started,
        reason: `codex exec resume succeeded but no turn.completed event was emitted (got ${events.length} events): ${stdoutText.slice(0, 240)}`,
      };
    }

    if (finalText === null) {
      // The turn completed but produced no final agent message — surface it
      // distinctly. Could be an interrupted run, a session that hit a
      // tool-approval gate, or a model that emitted only commentary phases.
      return {
        ok: false,
        changed,
        settled: true,
        before,
        after,
        elapsedMs: Date.now() - started,
        reason: `codex turn completed but emitted no final agent message`,
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

// Subset of the events `codex exec --json` writes to stdout. The full set
// observed during research: thread.started, turn.started, item.completed,
// turn.completed. Tolerate unknown event types.
type CodexExecEvent = {
  type: string;
  thread_id?: string;
  item?: { id?: string; type?: string; text?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
};

// Exported for direct test coverage of the event-stream parsing path.
export function parseEventStream(stdout: string): CodexExecEvent[] {
  const out: CodexExecEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as CodexExecEvent;
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        out.push(parsed);
      }
    } catch {
      // skip non-JSON noise (banner lines, partial writes)
    }
  }
  return out;
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best effort cleanup
  }
}

function condenseSummary(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SUMMARY_MAX_CHARS) return collapsed;
  return collapsed.slice(0, SUMMARY_MAX_CHARS) + "…";
}

function buildSession(
  r: DiscoveredRollout,
  summary: RolloutSummary,
  threadIndexEntry: ThreadIndexEntry | null,
): Session {
  const last = summary.lastTimestamp ? new Date(summary.lastTimestamp) : r.mtime;
  const first = summary.firstTimestamp ? new Date(summary.firstTimestamp) : null;

  // Title preference: session_index.jsonl thread_name (the human-readable
  // codename when present) → first user message (what the user originally
  // asked) → fall back to a generic label.
  const title = threadIndexEntry?.thread_name
    ?? (summary.firstUserMessage ? condenseTitle(summary.firstUserMessage) : null)
    ?? "(untitled)";

  // The resolver matches against `summary` — prefer the last user message
  // (most recent intent) over the first.
  const summaryText = summary.lastUserMessage ?? summary.firstUserMessage;

  return {
    adapter: ADAPTER_NAME,
    id: r.sessionId,
    title,
    tool: "codex",
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
    summary: summaryText ? condenseSummary(summaryText) : null,
    raw: summary,
  };
}

const TITLE_MAX_CHARS = 80;

function condenseTitle(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= TITLE_MAX_CHARS) return collapsed;
  return collapsed.slice(0, TITLE_MAX_CHARS) + "…";
}
