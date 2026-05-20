import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type TranscriptRecord = {
  type: string;
  [key: string]: unknown;
};

export type TranscriptSummary = {
  sessionId: string | null;
  title: string | null;
  lastPrompt: string | null;
  cwd: string | null;
  branch: string | null;
  version: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  recordCount: number;
};

const TEXT_DECODER = new TextDecoder();

export async function readAllRecords(path: string): Promise<TranscriptRecord[]> {
  const bytes = await Bun.file(path).arrayBuffer();
  const text = TEXT_DECODER.decode(bytes);
  return parseLines(text);
}

function parseLines(text: string): TranscriptRecord[] {
  const lines = text.split("\n");
  const out: TranscriptRecord[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as TranscriptRecord;
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        out.push(parsed);
      }
    } catch {
      // Tolerate truncated/partial trailing line and any malformed entries.
    }
  }
  return out;
}

export function summarize(records: TranscriptRecord[]): TranscriptSummary {
  const summary: TranscriptSummary = {
    sessionId: null,
    title: null,
    lastPrompt: null,
    cwd: null,
    branch: null,
    version: null,
    firstTimestamp: null,
    lastTimestamp: null,
    recordCount: records.length,
  };

  for (const r of records) {
    if (r.type === "ai-title" && typeof r.aiTitle === "string") {
      summary.title = r.aiTitle;
      if (typeof r.sessionId === "string") summary.sessionId = r.sessionId;
    } else if (r.type === "last-prompt" && typeof r.lastPrompt === "string") {
      summary.lastPrompt = r.lastPrompt;
      if (typeof r.sessionId === "string") summary.sessionId = r.sessionId;
    } else if (r.type === "user" || r.type === "assistant") {
      if (!summary.cwd && typeof r.cwd === "string") summary.cwd = r.cwd;
      if (!summary.branch && typeof r.gitBranch === "string") summary.branch = r.gitBranch;
      if (!summary.version && typeof r.version === "string") summary.version = r.version;
      if (!summary.sessionId && typeof r.sessionId === "string") summary.sessionId = r.sessionId;
      if (typeof r.timestamp === "string") {
        if (!summary.firstTimestamp) summary.firstTimestamp = r.timestamp;
        summary.lastTimestamp = r.timestamp;
      }
    }
  }

  return summary;
}

export type RenderOptions = {
  maxRecords?: number;
};

type AssistantContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking?: string }
  | { type: "tool_use"; name?: string; input?: unknown }
  | { type: string };

export function renderConversation(records: TranscriptRecord[], opts: RenderOptions = {}): string {
  const max = opts.maxRecords ?? 50;
  const chat = records.filter((r) => r.type === "user" || r.type === "assistant");
  const tail = chat.slice(-max);

  const out: string[] = [];
  for (const r of tail) {
    const message = (r as { message?: { role?: string; content?: unknown } }).message;
    if (!message) continue;

    if (r.type === "user") {
      const text = renderUserContent(message.content);
      if (text) out.push(`[user] ${text}`);
    } else if (r.type === "assistant") {
      const text = renderAssistantContent(message.content as AssistantContentBlock[] | string | undefined);
      if (text) out.push(`[assistant] ${text}`);
    }
  }
  return out.join("\n\n");
}

function renderUserContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object" && "type" in item) {
        const node = item as { type: string; content?: unknown; text?: string };
        if (node.type === "tool_result") {
          const c = node.content;
          if (typeof c === "string") texts.push(`[tool_result] ${truncate(c)}`);
        } else if (node.type === "text" && typeof node.text === "string") {
          texts.push(node.text);
        }
      }
    }
    return texts.join("\n").trim();
  }
  return "";
}

function renderAssistantContent(content: AssistantContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      const t = (block as { text?: string }).text;
      if (t) texts.push(t);
    } else if (block.type === "tool_use") {
      const name = (block as { name?: string }).name ?? "tool";
      texts.push(`[tool_use ${name}]`);
    }
    // Skip thinking blocks — internal reasoning, not output.
  }
  return texts.join("\n").trim();
}

function truncate(s: string, max = 400): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

export type DiscoveredTranscript = {
  sessionId: string;
  path: string;
  projectDir: string;
  mtime: Date;
};

export async function discoverTranscripts(projectsRoot: string): Promise<DiscoveredTranscript[]> {
  let entries: string[];
  try {
    entries = await readdir(projectsRoot);
  } catch {
    return [];
  }

  const results: DiscoveredTranscript[] = [];
  for (const projDirName of entries) {
    const projDir = join(projectsRoot, projDirName);
    let projStat;
    try {
      projStat = await stat(projDir);
    } catch {
      continue;
    }
    if (!projStat.isDirectory()) continue;

    let files: string[];
    try {
      files = await readdir(projDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.slice(0, -".jsonl".length);
      const path = join(projDir, file);
      let fStat;
      try {
        fStat = await stat(path);
      } catch {
        continue;
      }
      if (!fStat.isFile()) continue;
      results.push({ sessionId, path, projectDir: projDir, mtime: fStat.mtime });
    }
  }
  return results;
}
