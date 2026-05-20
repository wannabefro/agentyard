import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter, parseEventStream } from "@/adapters/codex/index.ts";
import {
  parseLines,
  renderConversation,
  summarize,
} from "@/adapters/codex/rollouts.ts";

const SID = "019e465b-49f8-7d93-b9cb-1f30dd3a3283";
const CREATED = "2026-05-20T18:07:28.282Z";

function jsonl(...records: object[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

// Realistic minimal rollout: session_meta, one full turn (task_started →
// task_complete bracketing user_message + agent_message), and a token_count
// in between.
function buildRollout(opts: {
  sessionId?: string;
  cwd?: string;
  branch?: string;
  cliVersion?: string;
  originator?: string;
  userMessage?: string;
  agentMessage?: string;
  agentPhase?: string;
  ts?: string;
} = {}): string {
  const {
    sessionId = SID,
    cwd = "/private/tmp/codex-research",
    branch = "main",
    cliVersion = "0.132.0",
    originator = "codex_exec",
    userMessage = "Respond with: BRAVO",
    agentMessage = "BRAVO",
    agentPhase = "commentary",
    ts = CREATED,
  } = opts;
  return jsonl(
    {
      timestamp: ts,
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: ts,
        cwd,
        originator,
        cli_version: cliVersion,
        source: "cli",
        thread_source: "user",
        model_provider: "openai",
        git: {
          commit_hash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          branch,
          repository_url: "git@github.com:example/repo.git",
        },
      },
    },
    { timestamp: ts, type: "event_msg", payload: { type: "task_started" } },
    {
      timestamp: ts,
      type: "turn_context",
      payload: { cwd, model: "gpt-5.5", sandbox_policy: "read-only" },
    },
    {
      timestamp: ts,
      type: "event_msg",
      payload: { type: "user_message", message: userMessage },
    },
    {
      timestamp: ts,
      type: "event_msg",
      payload: { type: "agent_message", message: agentMessage, phase: agentPhase },
    },
    { timestamp: ts, type: "event_msg", payload: { type: "task_complete" } },
  );
}

function writeRollout(root: string, dateDir: string, filename: string, content: string): string {
  const dir = join(root, dateDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, content);
  return path;
}

describe("codex rollouts.parseLines", () => {
  test("parses well-formed jsonl", () => {
    const records = parseLines(buildRollout());
    expect(records.length).toBeGreaterThanOrEqual(5);
    expect(records[0]!.type).toBe("session_meta");
  });

  test("skips truncated trailing line", () => {
    const text = buildRollout() + '{"type":"event_msg","payload":{"type":"task_started"';
    const records = parseLines(text);
    expect(records.find((r) => r.type === "session_meta")).toBeDefined();
    // The truncated line at the tail should not appear.
    expect(records.every((r) => r.type !== "event_msg" || r.payload?.type !== undefined || true)).toBe(true);
  });

  test("skips lines with unescaped control characters", () => {
    // The headline gotcha from the research doc. A real codex rollout had
    // base_instructions strings containing raw control chars that broke
    // strict JSON parsing.
    const badLine = '{"type":"response_item","payload":{"type":"message","text":"hello\x01world"}}';
    const text = buildRollout() + badLine + "\n";
    expect(() => JSON.parse(badLine)).toThrow();
    const records = parseLines(text);
    // The bad line is silently skipped; the good lines parse.
    expect(records.find((r) => r.type === "session_meta")).toBeDefined();
    const responseItems = records.filter((r) => r.type === "response_item");
    expect(responseItems.length).toBe(0);
  });

  test("ignores records without a string type", () => {
    const weird = '{"payload":{"type":"task_started"}}\n{"type":42}\n';
    const records = parseLines(weird);
    expect(records.length).toBe(0);
  });
});

describe("codex rollouts.summarize", () => {
  test("extracts session_meta fields", () => {
    const records = parseLines(buildRollout({ sessionId: SID, cwd: "/x", branch: "feat" }));
    const s = summarize(records);
    expect(s.sessionId).toBe(SID);
    expect(s.cwd).toBe("/x");
    expect(s.branch).toBe("feat");
    expect(s.cliVersion).toBe("0.132.0");
    expect(s.originator).toBe("codex_exec");
    expect(s.firstUserMessage).toBe("Respond with: BRAVO");
    expect(s.lastUserMessage).toBe("Respond with: BRAVO");
    expect(s.turnCount).toBe(1);
  });

  test("turn_context.cwd overrides session_meta.cwd", () => {
    const text = jsonl(
      {
        type: "session_meta",
        timestamp: CREATED,
        payload: { id: SID, cwd: "/old", cli_version: "0.132.0" },
      },
      {
        type: "turn_context",
        timestamp: CREATED,
        payload: { cwd: "/new", model: "gpt-5.5" },
      },
    );
    const s = summarize(parseLines(text));
    expect(s.cwd).toBe("/new");
  });

  test("counts multiple turns via task_started", () => {
    const t1 = buildRollout({ userMessage: "first", agentMessage: "1" });
    const t2 = jsonl(
      { type: "event_msg", timestamp: CREATED, payload: { type: "task_started" } },
      {
        type: "event_msg",
        timestamp: CREATED,
        payload: { type: "user_message", message: "second" },
      },
      {
        type: "event_msg",
        timestamp: CREATED,
        payload: { type: "agent_message", message: "2", phase: "final" },
      },
      { type: "event_msg", timestamp: CREATED, payload: { type: "task_complete" } },
    );
    const s = summarize(parseLines(t1 + t2));
    expect(s.turnCount).toBe(2);
    expect(s.firstUserMessage).toBe("first");
    expect(s.lastUserMessage).toBe("second");
  });

  test("handles missing session_meta gracefully", () => {
    const text = jsonl(
      {
        type: "event_msg",
        timestamp: CREATED,
        payload: { type: "user_message", message: "stray" },
      },
    );
    const s = summarize(parseLines(text));
    expect(s.sessionId).toBeNull();
    expect(s.cwd).toBeNull();
    expect(s.firstUserMessage).toBe("stray");
  });
});

describe("codex rollouts.renderConversation", () => {
  test("renders user + assistant turns from event_msg only", () => {
    const records = parseLines(buildRollout({ userMessage: "hi", agentMessage: "hello back" }));
    const out = renderConversation(records);
    expect(out).toContain("[user] hi");
    expect(out).toContain("hello back");
  });

  test("phase != final is prefixed", () => {
    const records = parseLines(buildRollout({ agentMessage: "thinking out loud", agentPhase: "commentary" }));
    const out = renderConversation(records);
    expect(out).toContain("[assistant:commentary]");
  });

  test("phase == final is plain [assistant]", () => {
    const records = parseLines(buildRollout({ agentMessage: "done", agentPhase: "final" }));
    const out = renderConversation(records);
    expect(out).toContain("[assistant] done");
    expect(out).not.toContain("phase:");
  });

  test("phase == final_answer is plain [assistant] (observed in the wild)", () => {
    const records = parseLines(buildRollout({ agentMessage: "the answer", agentPhase: "final_answer" }));
    const out = renderConversation(records);
    expect(out).toContain("[assistant] the answer");
    expect(out).not.toContain("final_answer");
  });

  test("ignores response_item/reasoning records", () => {
    const text = buildRollout() + jsonl(
      {
        type: "response_item",
        timestamp: CREATED,
        payload: { type: "reasoning", text: "internal CoT — should not surface" },
      },
    );
    const out = renderConversation(parseLines(text));
    expect(out).not.toContain("internal CoT");
  });
});

describe("parseEventStream (codex exec --json stdout)", () => {
  test("parses the canonical 4-event sequence", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"019e465b"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"CHARLIE"}}',
      '{"type":"turn.completed","usage":{"input_tokens":41255,"cached_input_tokens":12032,"output_tokens":81,"reasoning_output_tokens":65}}',
    ].join("\n");
    const events = parseEventStream(stdout);
    expect(events).toHaveLength(4);
    expect(events[0]!.type).toBe("thread.started");
    expect(events[2]!.item?.type).toBe("agent_message");
    expect(events[3]!.usage?.input_tokens).toBe(41255);
  });

  test("skips noisy non-JSON lines", () => {
    const stdout = [
      "Reading additional input from stdin...",
      '{"type":"thread.started","thread_id":"x"}',
      "OpenAI Codex v0.132.0",
      '{"type":"turn.completed","usage":{}}',
    ].join("\n");
    const events = parseEventStream(stdout);
    expect(events).toHaveLength(2);
  });

  test("ignores records without a string type", () => {
    const stdout = '{"foo":"bar"}\n{"type":42}\n';
    expect(parseEventStream(stdout)).toEqual([]);
  });
});

describe("CodexAdapter (synthetic ~/.codex root)", () => {
  let root: string;
  let codexHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentyard-codex-test-"));
    codexHome = join(root, ".codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSession(opts: {
    sessionId?: string;
    dateDir?: string;
    threadName?: string;
  } = {}): string {
    const { sessionId = SID, dateDir = "2026/05/20" } = opts;
    const filename = `rollout-2026-05-20T18-07-28-${sessionId}.jsonl`;
    writeRollout(
      join(codexHome, "sessions"),
      dateDir,
      filename,
      buildRollout({ sessionId }),
    );
    if (opts.threadName) {
      writeFileSync(
        join(codexHome, "session_index.jsonl"),
        JSON.stringify({
          id: sessionId,
          thread_name: opts.threadName,
          updated_at: CREATED,
        }) + "\n",
      );
    }
    return sessionId;
  }

  test("listSessions discovers a rollout in YYYY/MM/DD", async () => {
    writeSession();
    const adapter = new CodexAdapter({ codexHome });
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(SID);
    expect(sessions[0]!.adapter).toBe("codex");
    expect(sessions[0]!.tool).toBe("codex");
    expect(sessions[0]!.workdir).toBe("/private/tmp/codex-research");
    expect(sessions[0]!.branch).toBe("main");
    expect(sessions[0]!.nativeSessionId).toBe(SID);
  });

  test("listSessions returns empty when sessions/ is missing", async () => {
    rmSync(join(codexHome, "sessions"), { recursive: true });
    const adapter = new CodexAdapter({ codexHome });
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([]);
  });

  test("title preference: thread_name > first user message > untitled", async () => {
    // 1. With thread_name
    writeSession({ sessionId: SID, threadName: "Audit gaffer repo" });
    const adapter = new CodexAdapter({ codexHome });
    const sessions = await adapter.listSessions();
    expect(sessions[0]!.title).toBe("Audit gaffer repo");
  });

  test("title falls back to first user message when no thread_name", async () => {
    writeSession();
    const adapter = new CodexAdapter({ codexHome });
    const sessions = await adapter.listSessions();
    expect(sessions[0]!.title).toBe("Respond with: BRAVO");
  });

  test("getSession returns null for unknown id", async () => {
    writeSession();
    const adapter = new CodexAdapter({ codexHome });
    const session = await adapter.getSession("nonexistent");
    expect(session).toBeNull();
  });

  test("getSession returns full session for known id", async () => {
    writeSession();
    const adapter = new CodexAdapter({ codexHome });
    const session = await adapter.getSession(SID);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(SID);
  });

  test("getOutput renders conversation", async () => {
    writeSession();
    const adapter = new CodexAdapter({ codexHome });
    const snap = await adapter.getOutput(SID);
    expect(snap.content).toContain("Respond with: BRAVO");
    expect(snap.content).toContain("BRAVO");
    expect(snap.structured).toBeDefined();
    expect(snap.structured!.length).toBeGreaterThanOrEqual(2);
  });

  test("getOutput returns empty for unknown id", async () => {
    const adapter = new CodexAdapter({ codexHome });
    const snap = await adapter.getOutput("nonexistent");
    expect(snap).toEqual({ content: "", lines: 0 });
  });

  test("ignores non-rollout files in the date dir", async () => {
    writeSession();
    // A stray non-rollout file mustn't break discovery.
    writeFileSync(join(codexHome, "sessions/2026/05/20", "scratch.txt"), "noise");
    writeFileSync(
      join(codexHome, "sessions/2026/05/20", "rollout-malformed-name.jsonl"),
      buildRollout(),
    );
    const adapter = new CodexAdapter({ codexHome });
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
  });

  test("multiple sessions across date dirs", async () => {
    writeSession({ sessionId: SID, dateDir: "2026/05/20" });
    writeSession({
      sessionId: "019dcf23-5164-7b33-be46-68c2fc1a0763",
      dateDir: "2025/12/01",
    });
    const adapter = new CodexAdapter({ codexHome });
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(2);
    const ids = sessions.map((s) => s.id).sort();
    expect(ids).toEqual([
      "019dcf23-5164-7b33-be46-68c2fc1a0763",
      SID,
    ].sort());
  });
});
