import { homedir } from "node:os";
import { join } from "node:path";

import type { Adapter, OutputSnapshot } from "@/adapters/types.ts";
import type { Session } from "@/core/session.ts";
import {
  discoverTranscripts,
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

  async listSessions(): Promise<Session[]> {
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
    return { content, lines: content ? content.split("\n").length : 0 };
  }
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
    raw: summary,
  };
}
