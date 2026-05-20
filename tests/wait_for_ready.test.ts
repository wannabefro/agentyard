import { describe, expect, test } from "bun:test";
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
  test("succeeds when last non-empty line ends with the Claude Code cursor", async () => {
    const adapter = mockAdapter({
      paneScript: ["booting...", "some output\n❯", "some output\n❯"],
    });
    const result = await adapter.waitForReady!("sess", { timeoutMs: 1000, pollIntervalMs: 10 });
    expect(result.ready).toBe(true);
    expect(result.lastLine.endsWith("❯")).toBe(true);
  });

  test("times out when no known cursor ever appears", async () => {
    const adapter = mockAdapter({
      paneScript: ["loading...", "still loading..."],
    });
    const result = await adapter.waitForReady!("sess", { timeoutMs: 80, pollIntervalMs: 15 });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("prompt cursor not detected");
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
