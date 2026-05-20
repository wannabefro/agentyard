import { describe, expect, test } from "bun:test";
import { findRecentPromptCursorLine } from "@/adapters/aoe/index.ts";
import { sendThenWait } from "@/core/loop.ts";
import type {
  Adapter,
  IdleWaitOptions,
  OutputSnapshot,
  ReadyWaitOptions,
  ReadyWaitResult,
  SendResult,
} from "@/adapters/types.ts";

const KNOWN_PROMPT_CURSORS = ["❯", "›"] as const;

function lastNonEmptyLine(content: string): string {
  const lines = content.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? "";
}

function mockAdapter(opts: {
  paneScript: string[];
}): Adapter & { sendCount: number } {
  let cursor = 0;
  const pane = () => opts.paneScript[Math.min(cursor, opts.paneScript.length - 1)] ?? "";

  const adapter: Adapter & { sendCount: number } = {
    name: "mock-ready",
    sendCount: 0,
    listSessions: async () => [],
    getSession: async () => null,
    getOutput: async (): Promise<OutputSnapshot> => {
      const content = pane();
      cursor += 1;
      return { content, lines: 30 };
    },
    sendInput: async (): Promise<SendResult> => {
      adapter.sendCount += 1;
      return { ok: true };
    },
    waitIdle: async (_id: string, waitOpts: IdleWaitOptions) => {
      // Settle immediately for tests that get past readiness — the readiness path is what we care about here.
      await Bun.sleep(Math.min(waitOpts.idleWindowMs, 50));
      return { settled: true, lastSnapshot: { content: pane(), lines: 30 } };
    },
    createSession: async () => { throw new Error("not implemented"); },
    startSession: async () => {},
    stopSession: async () => {},
    restartSession: async () => {},
    removeSession: async () => {},
    waitForReady: async (_id: string, waitOpts: ReadyWaitOptions): Promise<ReadyWaitResult> => {
      const pollMs = waitOpts.pollIntervalMs ?? 10;
      const deadline = Date.now() + waitOpts.timeoutMs;
      while (Date.now() < deadline) {
        const content = pane();
        cursor += 1;
        const lastLine = lastNonEmptyLine(content);
        if (KNOWN_PROMPT_CURSORS.some((c) => lastLine.endsWith(c))) {
          return { ready: true, lastLine };
        }
        await Bun.sleep(pollMs);
      }
      const content = pane();
      const lastLine = lastNonEmptyLine(content);
      return {
        ready: false,
        reason: `prompt cursor not detected within ${waitOpts.timeoutMs}ms`,
        lastLine,
      };
    },
  };
  return adapter;
}

describe("waitForReady", () => {
  // The two prior tests here (succeeds-on-cursor / times-out-without-cursor)
  // exercised a hand-rolled copy of the waitForReady logic embedded in
  // mockAdapter — they tested the mock, not the production heuristic. After
  // 0.1.5 extracted findRecentPromptCursorLine, the fixture-driven describe
  // block below is the real coverage, and the sendThenWait short-circuit
  // test below it exercises waitForReady as a dependency of the full loop.
  // The redundant tests were removed.

  // Direct coverage of the real heuristic in src/adapters/aoe/index.ts —
  // distinct from the mock above which has its own copy. The dogfood pass
  // on 0.1.4 caught a regression where the previous "lastNonEmptyLine
  // ends with cursor" check missed real Claude Code TUI panes that render
  // a status footer below the input.
  describe("findRecentPromptCursorLine (real heuristic)", () => {
    test("detects cursor when it is the last non-empty line", () => {
      const pane = "booting...\nsome output\n❯";
      expect(findRecentPromptCursorLine(pane)).toBe("❯");
    });

    test("detects cursor when followed by a multi-line status footer", () => {
      // This is the exact shape current Claude Code TUI renders:
      // a divider, the cursor line, another divider, then footer text.
      // The old heuristic missed this because the last non-empty line is
      // the footer, not the cursor.
      const pane = [
        "Welcome back Sam!",
        "────────────────────────────────────────",
        "❯ ",
        "────────────────────────────────────────",
        "   [Opus 4.7 (1M context)] ay-dogfood-target | 0% ctx | $0.000",
        "  ← for agents",
        "                              1 MCP server failed · /mcp",
      ].join("\n");
      const result = findRecentPromptCursorLine(pane);
      expect(result).toBe("❯");
    });

    test("detects cursor in a menu (cursor + selection text)", () => {
      // Trust prompt on first agent boot. The cursor is on the "Yes"
      // option line, not at the trailing position.
      const pane = [
        "Quick safety check: Is this a project you trust?",
        "",
        "❯ 1. Yes, I trust this folder",
        "  2. No, exit",
        "",
        "Enter to confirm · Esc to cancel",
      ].join("\n");
      const result = findRecentPromptCursorLine(pane);
      expect(result).toBe("❯ 1. Yes, I trust this folder");
    });

    test("detects the Codex CLI single-angle cursor", () => {
      const pane = "loading...\n› hello";
      expect(findRecentPromptCursorLine(pane)).toBe("› hello");
    });

    test("returns null when no cursor is in the recent window", () => {
      const pane = ["initializing...", "still booting...", "more output", "no cursor here"].join(
        "\n",
      );
      expect(findRecentPromptCursorLine(pane)).toBeNull();
    });

    test("ignores a cursor glyph embedded mid-word (false positive guard)", () => {
      // A cursor glyph might appear inside command output or pasted text —
      // we should not treat that as a ready prompt.
      const pane = "some output saying foo❯bar in the middle\nmore output";
      expect(findRecentPromptCursorLine(pane)).toBeNull();
    });
  });

  test("sendThenWait short-circuits on readiness failure and never calls sendInput", async () => {
    const adapter = mockAdapter({
      paneScript: ["booting...", "booting...", "booting..."],
    });
    const result = await sendThenWait(adapter, "sess", "please summarize the codebase", {
      changeTimeoutMs: 500,
      idleTimeoutMs: 500,
      idleWindowMs: 50,
      pollIntervalMs: 20,
      readyTimeoutMs: 80,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("agent not ready");
    expect(result.reason).toContain("prompt cursor not detected");
    expect(adapter.sendCount).toBe(0);
  });
});
