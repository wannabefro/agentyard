import { homedir } from "node:os";
import { join } from "node:path";

import type {
  Adapter,
  ListSessionsOptions,
  OutputSnapshot,
} from "@/adapters/types.ts";
import type { Session } from "@/core/session.ts";
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
