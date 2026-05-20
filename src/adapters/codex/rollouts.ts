import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { SessionMessage } from "@/adapters/types.ts";

// One JSONL record. We dispatch on `type` + `payload.type`, but the schema is
// internal to codex 0.132.0 and is expected to drift — keep the type loose.
export type RolloutRecord = {
  type: string;
  timestamp?: string;
  payload?: {
    type?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type RolloutSummary = {
  sessionId: string | null;
  cwd: string | null;
  branch: string | null;
  cliVersion: string | null;
  originator: string | null;
  repositoryUrl: string | null;
  commitHash: string | null;
  // Codex doesn't carry an ai-title equivalent in the rollout. The closest
  // signal is the first user_message ("the first thing the user asked") —
  // surface that as `title` and let the resolver match against it. The
  // session_index.jsonl `thread_name` (when present) is layered in by the
  // adapter, not here.
  firstUserMessage: string | null;
  lastUserMessage: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  turnCount: number;
  recordCount: number;
};

const TEXT_DECODER = new TextDecoder();

// Lenient JSONL parser. Codex sometimes writes records containing literal
// unescaped control characters in payload strings (notably base_instructions
// and summary fields). Strict JSON.parse throws on those — catch and skip.
// Truncated tail lines from mid-write reads are also tolerated.
export async function readAllRecords(path: string): Promise<RolloutRecord[]> {
  const bytes = await Bun.file(path).arrayBuffer();
  const text = TEXT_DECODER.decode(bytes);
  return parseLines(text);
}

export function parseLines(text: string): RolloutRecord[] {
  const lines = text.split("\n");
  const out: RolloutRecord[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as RolloutRecord;
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        out.push(parsed);
      }
    } catch {
      // See header comment — codex emits unescaped control chars in some
      // payload strings, and the last line of a live-write file may be
      // partial. Skipping is the correct policy.
    }
  }
  return out;
}

// Read only enough records to recover identity + activity signals. For the
// 285-file catalog on this machine, full-file reads in listSessions would be
// ~30MB of JSONL parsing per call. The session_meta is line 1, and the most
// recent activity lives at the file's tail. The middle is full of reasoning
// blocks we don't need for listing.
//
// Strategy: read the whole file for now (matches claude-code's approach and
// keeps the parser simple). Revisit with a head+tail streaming reader if
// listSessions latency becomes a problem.
export function summarize(records: RolloutRecord[]): RolloutSummary {
  const summary: RolloutSummary = {
    sessionId: null,
    cwd: null,
    branch: null,
    cliVersion: null,
    originator: null,
    repositoryUrl: null,
    commitHash: null,
    firstUserMessage: null,
    lastUserMessage: null,
    firstTimestamp: null,
    lastTimestamp: null,
    turnCount: 0,
    recordCount: records.length,
  };

  for (const r of records) {
    if (typeof r.timestamp === "string") {
      if (!summary.firstTimestamp) summary.firstTimestamp = r.timestamp;
      summary.lastTimestamp = r.timestamp;
    }

    if (r.type === "session_meta" && r.payload && typeof r.payload === "object") {
      const p = r.payload as Record<string, unknown>;
      if (typeof p.id === "string") summary.sessionId = p.id;
      if (typeof p.cwd === "string") summary.cwd = p.cwd;
      if (typeof p.cli_version === "string") summary.cliVersion = p.cli_version;
      if (typeof p.originator === "string") summary.originator = p.originator;
      const git = p.git;
      if (git && typeof git === "object") {
        const g = git as Record<string, unknown>;
        if (typeof g.branch === "string") summary.branch = g.branch;
        if (typeof g.repository_url === "string") summary.repositoryUrl = g.repository_url;
        if (typeof g.commit_hash === "string") summary.commitHash = g.commit_hash;
      }
    } else if (r.type === "turn_context" && r.payload && typeof r.payload === "object") {
      // turn_context.cwd is the most recent cwd the agent thinks it's in.
      // Prefer the latest turn_context value over session_meta.cwd when both
      // exist — captures `codex exec resume -C <other-dir>` correctly.
      const p = r.payload as Record<string, unknown>;
      if (typeof p.cwd === "string") summary.cwd = p.cwd;
    } else if (r.type === "event_msg" && r.payload && typeof r.payload === "object") {
      const p = r.payload as Record<string, unknown>;
      if (p.type === "task_started") {
        summary.turnCount += 1;
      } else if (p.type === "user_message" && typeof p.message === "string") {
        if (!summary.firstUserMessage) summary.firstUserMessage = p.message;
        summary.lastUserMessage = p.message;
      }
    }
  }

  return summary;
}

export type RenderOptions = {
  maxRecords?: number;
};

// Render a flat-text transcript: user_message and agent_message pairs in
// chronological order. Skips reasoning blocks (codex's internal CoT) and the
// raw response_item/message records that wrap the same content with model-API
// envelopes. The event_msg surface is the "rendered" view; response_item is
// the "raw" view. We prefer event_msg.
export function renderConversation(records: RolloutRecord[], opts: RenderOptions = {}): string {
  const max = opts.maxRecords ?? 50;
  const turns: string[] = [];
  for (const r of records) {
    if (r.type !== "event_msg" || !r.payload || typeof r.payload !== "object") continue;
    const p = r.payload as Record<string, unknown>;
    if (p.type === "user_message" && typeof p.message === "string") {
      turns.push(`[user] ${p.message.trim()}`);
    } else if (p.type === "agent_message" && typeof p.message === "string") {
      const phase = typeof p.phase === "string" ? p.phase : "";
      const prefix = isTerminalPhase(phase) ? "[assistant]" : `[assistant:${phase}]`;
      turns.push(`${prefix} ${p.message.trim()}`);
    }
  }
  const tail = turns.slice(-max);
  return tail.join("\n\n");
}

export function extractMessages(
  records: RolloutRecord[],
  opts: RenderOptions = {},
): SessionMessage[] {
  const max = opts.maxRecords ?? 50;
  const out: SessionMessage[] = [];
  for (const r of records) {
    if (r.type !== "event_msg" || !r.payload || typeof r.payload !== "object") continue;
    const p = r.payload as Record<string, unknown>;
    const timestamp = typeof r.timestamp === "string" ? r.timestamp : undefined;
    if (p.type === "user_message" && typeof p.message === "string") {
      out.push({ role: "user", text: p.message, timestamp });
    } else if (p.type === "agent_message" && typeof p.message === "string") {
      const phase = typeof p.phase === "string" ? p.phase : undefined;
      out.push({
        role: "assistant",
        text: p.message,
        timestamp,
        kind: phase && !isTerminalPhase(phase) ? `phase:${phase}` : undefined,
      });
    }
  }
  return out.slice(-max);
}

// codex emits agent_message records with a `phase` field. The phases we've
// observed in the wild (50-file sample of ~/.codex/sessions):
//   commentary   (1055) — intermediate "thinking out loud" output
//   final_answer ( 204) — the user-visible final response
//   <missing>    ( 115) — agent_message with no phase field at all
// We treat final_answer and missing-phase as terminal (plain [assistant]).
// Everything else gets a phase suffix so renderers can distinguish them.
function isTerminalPhase(phase: string): boolean {
  return phase === "" || phase === "final" || phase === "final_answer";
}

export type DiscoveredRollout = {
  sessionId: string;
  path: string;
  mtime: Date;
};

// codex stores rollouts as ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// Walk three nested levels of date directories. Tolerate missing intermediate
// dirs (a freshly-installed codex has none yet).
const ROLLOUT_FILENAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]+)\.jsonl$/;

export async function discoverRollouts(sessionsRoot: string): Promise<DiscoveredRollout[]> {
  const out: DiscoveredRollout[] = [];

  const years = await safeReaddir(sessionsRoot);
  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearDir = join(sessionsRoot, year);
    if (!(await isDir(yearDir))) continue;

    const months = await safeReaddir(yearDir);
    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue;
      const monthDir = join(yearDir, month);
      if (!(await isDir(monthDir))) continue;

      const days = await safeReaddir(monthDir);
      for (const day of days) {
        if (!/^\d{2}$/.test(day)) continue;
        const dayDir = join(monthDir, day);
        if (!(await isDir(dayDir))) continue;

        const files = await safeReaddir(dayDir);
        for (const file of files) {
          const m = file.match(ROLLOUT_FILENAME);
          if (!m) continue;
          const path = join(dayDir, file);
          let fStat;
          try {
            fStat = await stat(path);
          } catch {
            continue;
          }
          if (!fStat.isFile()) continue;
          out.push({ sessionId: m[1]!, path, mtime: fStat.mtime });
        }
      }
    }
  }

  return out;
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// session_index.jsonl is a small, opportunistic cache of named threads.
// See docs/research/codex.md — NOT the authoritative session list. We layer
// it in as resolver-friendly free-text titles when an id matches.
export type ThreadIndexEntry = {
  id: string;
  thread_name: string;
  updated_at: string;
};

export async function readThreadIndex(path: string): Promise<Map<string, ThreadIndexEntry>> {
  const map = new Map<string, ThreadIndexEntry>();
  let text: string;
  try {
    text = TEXT_DECODER.decode(await Bun.file(path).arrayBuffer());
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as ThreadIndexEntry;
      if (parsed && typeof parsed.id === "string" && typeof parsed.thread_name === "string") {
        map.set(parsed.id, parsed);
      }
    } catch {
      // skip malformed
    }
  }
  return map;
}
