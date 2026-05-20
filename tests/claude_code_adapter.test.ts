import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Adapter } from "@/adapters/types.ts";
import { ClaudeCodeAdapter, parseClaudePrintResult } from "@/adapters/claude-code/index.ts";

function makeTranscriptLine(record: object): string {
  return JSON.stringify(record) + "\n";
}

function buildMinimalTranscript(opts: {
  sessionId: string;
  cwd: string;
  branch?: string;
  title?: string;
  lastPrompt?: string;
  userText?: string;
  assistantText?: string;
}): string {
  const {
    sessionId,
    cwd,
    branch = "main",
    title = "Untitled session",
    lastPrompt = "Hello",
    userText = "Hello",
    assistantText = "Hi there.",
  } = opts;

  const userUuid = "11111111-1111-1111-1111-111111111111";
  const asstUuid = "22222222-2222-2222-2222-222222222222";

  return [
    makeTranscriptLine({
      type: "user",
      uuid: userUuid,
      parentUuid: null,
      sessionId,
      cwd,
      gitBranch: branch,
      version: "2.1.145",
      timestamp: "2026-05-20T09:00:00.000Z",
      userType: "external",
      isSidechain: false,
      message: { role: "user", content: userText },
    }),
    makeTranscriptLine({
      type: "assistant",
      uuid: asstUuid,
      parentUuid: userUuid,
      sessionId,
      cwd,
      gitBranch: branch,
      version: "2.1.145",
      timestamp: "2026-05-20T09:00:05.000Z",
      userType: "internal",
      isSidechain: false,
      message: {
        model: "claude-opus-4-7",
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
      },
    }),
    makeTranscriptLine({ type: "ai-title", aiTitle: title, sessionId }),
    makeTranscriptLine({
      type: "last-prompt",
      lastPrompt,
      leafUuid: asstUuid,
      sessionId,
    }),
  ].join("");
}

describe("ClaudeCodeAdapter", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentyard-claude-code-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("listSessions walks projects tree and reads cwd from inside the file", async () => {
    // Lossy-encoded directory: `/Users/sam.mctaggart/Dev/pepper` -> `-Users-sam-mctaggart-Dev-pepper`
    const projectDir = join(root, "-Users-sam-mctaggart-Dev-pepper");
    mkdirSync(projectDir, { recursive: true });

    const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      buildMinimalTranscript({
        sessionId,
        cwd: "/Users/sam.mctaggart/Dev/pepper",
        branch: "main",
        title: "Hacking on agentyard",
      }),
    );

    const adapter = new ClaudeCodeAdapter({ projectsRoot: root });
    const sessions = await adapter.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!).toMatchObject({
      adapter: "claude-code",
      id: sessionId,
      title: "Hacking on agentyard",
      tool: "claude",
      workdir: "/Users/sam.mctaggart/Dev/pepper",
      branch: "main",
    });
  });

  test("does not decode the directory name to reconstruct cwd", async () => {
    // Real cwd contains `.` characters — the encoded dir name is ambiguous.
    // Adapter must read `cwd` from inside the transcript, not from the dir name.
    const projectDir = join(root, "-Users-sam-mctaggart--claude");
    mkdirSync(projectDir, { recursive: true });

    const sessionId = "b1b2c3d4-e5f6-7890-abcd-ef1234567890";
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      buildMinimalTranscript({
        sessionId,
        cwd: "/Users/sam.mctaggart/.claude",
        title: "Editing claude rules",
      }),
    );

    const adapter = new ClaudeCodeAdapter({ projectsRoot: root });
    const sessions = await adapter.listSessions();
    const session = sessions[0]!;

    expect(session.workdir).toBe("/Users/sam.mctaggart/.claude");
    expect(session.workdir).not.toBe("-Users-sam-mctaggart--claude");
  });

  test("getSession returns null for unknown id", async () => {
    mkdirSync(join(root, "-some-project"), { recursive: true });
    const adapter = new ClaudeCodeAdapter({ projectsRoot: root });
    const session = await adapter.getSession("does-not-exist");
    expect(session).toBeNull();
  });

  test("getSession finds a session by id across project directories", async () => {
    const projA = join(root, "-Users-sam-mctaggart-Dev-pepper");
    const projB = join(root, "-Users-sam-mctaggart-Dev-other");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });

    const targetId = "c1b2c3d4-e5f6-7890-abcd-ef1234567890";
    writeFileSync(
      join(projB, `${targetId}.jsonl`),
      buildMinimalTranscript({
        sessionId: targetId,
        cwd: "/Users/sam.mctaggart/Dev/other",
        title: "Other project work",
      }),
    );

    const adapter = new ClaudeCodeAdapter({ projectsRoot: root });
    const session = await adapter.getSession(targetId);

    expect(session).not.toBeNull();
    expect(session?.title).toBe("Other project work");
    expect(session?.workdir).toBe("/Users/sam.mctaggart/Dev/other");
  });

  test("getOutput renders user prompts and assistant text in chronological order", async () => {
    const projectDir = join(root, "-tmp-x");
    mkdirSync(projectDir, { recursive: true });

    const sessionId = "d1b2c3d4-e5f6-7890-abcd-ef1234567890";
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      buildMinimalTranscript({
        sessionId,
        cwd: "/tmp/x",
        userText: "Make the function faster.",
        assistantText: "I'll profile it first.",
      }),
    );

    const adapter: Adapter = new ClaudeCodeAdapter({ projectsRoot: root });
    const snap = await adapter.getOutput(sessionId);

    expect(snap.content).toContain("Make the function faster.");
    expect(snap.content).toContain("I'll profile it first.");
    expect(snap.content.indexOf("Make the function faster."))
      .toBeLessThan(snap.content.indexOf("I'll profile it first."));
  });

  test("getOutput populates structured messages alongside flat content", async () => {
    const projectDir = join(root, "-tmp-structured");
    mkdirSync(projectDir, { recursive: true });

    const sessionId = "ab000001-0000-0000-0000-000000000000";
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      buildMinimalTranscript({
        sessionId,
        cwd: "/tmp/structured",
        userText: "what's broken?",
        assistantText: "the auth flow.",
      }),
    );

    const adapter: Adapter = new ClaudeCodeAdapter({ projectsRoot: root });
    const snap = await adapter.getOutput(sessionId);

    expect(snap.structured).toBeDefined();
    expect(snap.structured!.length).toBeGreaterThanOrEqual(2);
    const first = snap.structured!.find((m) => m.role === "user");
    const second = snap.structured!.find((m) => m.role === "assistant");
    expect(first?.text).toContain("what's broken?");
    expect(second?.text).toContain("the auth flow.");
  });

  test("tolerates unknown record types and a truncated final line", async () => {
    const projectDir = join(root, "-tmp-y");
    mkdirSync(projectDir, { recursive: true });

    const sessionId = "e1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const valid = buildMinimalTranscript({
      sessionId,
      cwd: "/tmp/y",
      title: "Tolerant parse",
    });
    const unknown = makeTranscriptLine({
      type: "future-record-type-agentyard-doesnt-know",
      sessionId,
      payload: { foo: "bar" },
    });
    // Truncated final line — no trailing newline, broken JSON
    const truncated = '{"type":"assistant","sessionId":"' + sessionId + '","message":{"model":"claude-opus-4-7","content":[{"type":"text","text":"partial';

    writeFileSync(join(projectDir, `${sessionId}.jsonl`), valid + unknown + truncated);

    const adapter = new ClaudeCodeAdapter({ projectsRoot: root });
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.title).toBe("Tolerant parse");
  });

  test("uses the last ai-title and last-prompt when records appear multiple times", async () => {
    const projectDir = join(root, "-tmp-z");
    mkdirSync(projectDir, { recursive: true });

    const sessionId = "f1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const lines = [
      makeTranscriptLine({ type: "ai-title", aiTitle: "Old title", sessionId }),
      makeTranscriptLine({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId,
        cwd: "/tmp/z",
        gitBranch: "main",
        version: "2.1.145",
        timestamp: "2026-05-20T09:00:00.000Z",
        userType: "external",
        message: { role: "user", content: "hi" },
      }),
      makeTranscriptLine({ type: "ai-title", aiTitle: "New title", sessionId }),
    ].join("");

    writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines);

    const adapter = new ClaudeCodeAdapter({ projectsRoot: root });
    const sessions = await adapter.listSessions();
    expect(sessions[0]!.title).toBe("New title");
  });

  test("ignores non-jsonl files and subagent subdirectory entries from top-level list", async () => {
    const projectDir = join(root, "-tmp-w");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, "memory"), { recursive: true });
    writeFileSync(join(projectDir, "memory", "MEMORY.md"), "- index\n");

    const sessionId = "abc11111-1111-1111-1111-111111111111";
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      buildMinimalTranscript({ sessionId, cwd: "/tmp/w", title: "Only one" }),
    );

    // Subagent subdir with its own jsonl — should not show up in top-level listSessions
    const subagentDir = join(projectDir, sessionId, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "agent-deadbeef.jsonl"),
      buildMinimalTranscript({
        sessionId: "agent-deadbeef",
        cwd: "/tmp/w",
        title: "subagent",
      }),
    );
    writeFileSync(
      join(subagentDir, "agent-deadbeef.meta.json"),
      JSON.stringify({
        agentType: "claude",
        name: "lane-x",
        description: "sub work",
        worktreePath: "/tmp/w/.claude/worktrees/agent-deadbeef",
        toolUseId: "toolu_xyz",
      }),
    );

    const adapter = new ClaudeCodeAdapter({ projectsRoot: root });
    const sessions = await adapter.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(sessionId);
  });

  test("does not implement sendInput or waitIdle (write path is sendThenWait)", () => {
    const adapter: Adapter = new ClaudeCodeAdapter({ projectsRoot: root });
    expect(adapter.sendInput).toBeUndefined();
    expect(adapter.waitIdle).toBeUndefined();
    // sendThenWait is the write path — it spawns `claude --resume`. Asserted
    // present so the omission of sendInput/waitIdle reads as intentional.
    expect(adapter.sendThenWait).toBeDefined();
  });
});

describe("parseClaudePrintResult", () => {
  test("parses a single-line success JSON result", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "alphaCC",
      session_id: "abc-123",
    });
    const parsed = parseClaudePrintResult(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed!.result).toBe("alphaCC");
    expect(parsed!.is_error).toBe(false);
  });

  test("walks lines backward and finds the JSON result amid diagnostic lines", () => {
    // Real Claude Code CLI invocations sometimes emit diagnostic lines
    // alongside the JSON result. Parser should be robust to that.
    const stdout = [
      "some diagnostic line",
      "warning: blah blah",
      JSON.stringify({ type: "result", is_error: false, result: "ok" }),
    ].join("\n");
    const parsed = parseClaudePrintResult(stdout);
    expect(parsed?.result).toBe("ok");
  });

  test("returns null when no JSON result is present", () => {
    expect(parseClaudePrintResult("plain text only")).toBeNull();
    expect(parseClaudePrintResult("")).toBeNull();
  });

  test("ignores JSON without a 'type' field (defensive against partial output)", () => {
    // A bare `{}` parses but isn't the result object — must not be returned
    // as a false-positive ClaudePrintResult.
    const stdout = "{}\n" + JSON.stringify({ random: "thing" });
    expect(parseClaudePrintResult(stdout)).toBeNull();
  });
});
