import { describe, expect, test } from "bun:test";
import { sendThenWait } from "@/core/loop.ts";
import type {
  Adapter,
  IdleWaitOptions,
  OutputSnapshot,
  SendResult,
} from "@/adapters/types.ts";

type Script = Array<string>;

function mockAdapter(opts: {
  paneScript: Script;
  sendOk?: boolean;
  sendFailReason?: string;
}): Adapter & { sendCount: number } {
  let cursor = 0;
  const pane = () => opts.paneScript[Math.min(cursor, opts.paneScript.length - 1)] ?? "";

  const adapter: Adapter & { sendCount: number } = {
    name: "mock",
    sendCount: 0,
    listSessions: async () => [],
    getSession: async () => null,
    getOutput: async (): Promise<OutputSnapshot> => {
      const content = pane();
      cursor += 1;
      return { content, lines: 200 };
    },
    sendInput: async (): Promise<SendResult> => {
      adapter.sendCount += 1;
      if (opts.sendOk === false) {
        return { ok: false, reason: opts.sendFailReason ?? "mock send failure" };
      }
      return { ok: true };
    },
    waitIdle: async (_id: string, waitOpts: IdleWaitOptions) => {
      let lastContent = pane();
      let lastChange = Date.now();
      const deadline = Date.now() + waitOpts.timeoutMs;
      while (Date.now() < deadline) {
        const content = pane();
        cursor += 1;
        if (content !== lastContent) {
          lastChange = Date.now();
          lastContent = content;
        }
        if (Date.now() - lastChange >= waitOpts.idleWindowMs) {
          return { settled: true, lastSnapshot: { content, lines: 200 } };
        }
        await Bun.sleep(20);
      }
      return { settled: false, lastSnapshot: { content: pane(), lines: 200 } };
    },
    createSession: async () => { throw new Error("not implemented"); },
    startSession: async () => {},
    stopSession: async () => {},
    restartSession: async () => {},
    removeSession: async () => {},
  };
  return adapter;
}

describe("sendThenWait with echo verification", () => {
  test("happy path: pane echoes the sent text, then settles", async () => {
    const sentText = "please summarize the codebase";
    const adapter = mockAdapter({
      paneScript: [
        "before-send",
        "before-send",
        `❯ ${sentText}`,
        `❯ ${sentText}\nagent thinking...`,
        `❯ ${sentText}\nthe codebase is structured as...`,
        `❯ ${sentText}\nthe codebase is structured as... done.`,
        `❯ ${sentText}\nthe codebase is structured as... done.`,
        `❯ ${sentText}\nthe codebase is structured as... done.`,
        `❯ ${sentText}\nthe codebase is structured as... done.`,
      ],
    });
    const result = await sendThenWait(adapter, "sess", sentText, {
      changeTimeoutMs: 1000,
      idleTimeoutMs: 2000,
      idleWindowMs: 50,
      pollIntervalMs: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.settled).toBe(true);
    expect(result.after.content).toContain(sentText);
    expect(result.after.content).toContain("done.");
    expect(adapter.sendCount).toBe(1);
  });

  test("TUI churn without echo: ok=false (this is the real-world readiness bug)", async () => {
    // Pane changes (welcome animation, status bar updates) but never contains the sent text.
    const adapter = mockAdapter({
      paneScript: [
        "Welcome to Sam Claude!",
        "Welcome to Sam Claude!\n[loading...]",
        "Welcome to Sam Claude!\n[loading...]\n[ready]",
        "Welcome to Sam Claude!\n[loading...]\n[ready]\n❯ ",
        "Welcome to Sam Claude!\n[loading...]\n[ready]\n❯ ",
        "Welcome to Sam Claude!\n[loading...]\n[ready]\n❯ ",
      ],
    });
    const result = await sendThenWait(adapter, "sess", "please run the tests and report back", {
      changeTimeoutMs: 100,
      idleTimeoutMs: 200,
      idleWindowMs: 50,
      pollIntervalMs: 20,
    });
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true); // pane DID change — just not in the way we wanted
    expect(result.settled).toBe(false);
    expect(result.reason).toContain("did not appear in pane");
  });

  test("send failure short-circuits — never polls for echo", async () => {
    const adapter = mockAdapter({
      paneScript: ["x"],
      sendOk: false,
      sendFailReason: "session stopped",
    });
    const result = await sendThenWait(adapter, "sess", "please summarize the codebase", {
      changeTimeoutMs: 500,
      idleTimeoutMs: 500,
      idleWindowMs: 50,
      pollIntervalMs: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("send failed");
    expect(result.reason).toContain("session stopped");
  });

  test("echo seen but agent never settles → ok=true, settled=false", async () => {
    const sentText = "please summarize the codebase";
    const paneScript: Script = ["before"];
    for (let i = 0; i < 200; i += 1) {
      paneScript.push(`❯ ${sentText}\ntick-${i}`);
    }
    const adapter = mockAdapter({ paneScript });
    const result = await sendThenWait(adapter, "sess", sentText, {
      changeTimeoutMs: 500,
      idleTimeoutMs: 200,
      idleWindowMs: 1000,
      pollIntervalMs: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.settled).toBe(false);
    expect(result.reason).toContain("did not settle");
  });

  test("short text (< 8 chars) falls back to change detection", async () => {
    const adapter = mockAdapter({
      paneScript: ["before", "before", "any change at all", "any change at all", "any change at all", "any change at all"],
    });
    const result = await sendThenWait(adapter, "sess", "y", {
      changeTimeoutMs: 500,
      idleTimeoutMs: 500,
      idleWindowMs: 50,
      pollIntervalMs: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
  });

  test("per-session lock serializes concurrent calls on the same session", async () => {
    // Concurrent send_then_wait against the same (adapter, id) used to be
    // racy — both calls would observe pane changes from the other and
    // potentially report misleading settled flags. The lock added in 0.1.5
    // makes them serialize: B waits for A to complete before starting.
    let inFlight = 0;
    let maxInFlight = 0;
    const adapter: Adapter = {
      name: "lock-test",
      listSessions: async () => [],
      getSession: async () => null,
      getOutput: async () => ({ content: "", lines: 0 }),
      sendInput: async () => ({ ok: true }),
      waitIdle: async () => ({ settled: true, lastSnapshot: { content: "", lines: 0 } }),
      createSession: async () => { throw new Error("not implemented"); },
      startSession: async () => {},
      stopSession: async () => {},
      restartSession: async () => {},
      removeSession: async () => {},
      sendThenWait: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(30); // simulate work
        inFlight -= 1;
        return {
          ok: true,
          changed: true,
          settled: true,
          before: { content: "", lines: 0 },
          after: { content: "", lines: 0 },
          elapsedMs: 30,
        };
      },
    };
    await Promise.all([
      sendThenWait(adapter, "sess-1", "first call here", { changeTimeoutMs: 1, idleTimeoutMs: 1, idleWindowMs: 1 }),
      sendThenWait(adapter, "sess-1", "second call here", { changeTimeoutMs: 1, idleTimeoutMs: 1, idleWindowMs: 1 }),
      sendThenWait(adapter, "sess-1", "third call here", { changeTimeoutMs: 1, idleTimeoutMs: 1, idleWindowMs: 1 }),
    ]);
    expect(maxInFlight).toBe(1);
  });

  test("per-session lock does not block calls to different sessions", async () => {
    // Cross-session concurrency is the common case (driving multiple
    // agents in parallel) and must remain fast — the lock is keyed by
    // (adapter.name, id) so different ids run in parallel.
    let inFlight = 0;
    let maxInFlight = 0;
    const adapter: Adapter = {
      name: "lock-test-cross",
      listSessions: async () => [],
      getSession: async () => null,
      getOutput: async () => ({ content: "", lines: 0 }),
      sendInput: async () => ({ ok: true }),
      waitIdle: async () => ({ settled: true, lastSnapshot: { content: "", lines: 0 } }),
      createSession: async () => { throw new Error("not implemented"); },
      startSession: async () => {},
      stopSession: async () => {},
      restartSession: async () => {},
      removeSession: async () => {},
      sendThenWait: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(30);
        inFlight -= 1;
        return {
          ok: true,
          changed: true,
          settled: true,
          before: { content: "", lines: 0 },
          after: { content: "", lines: 0 },
          elapsedMs: 30,
        };
      },
    };
    await Promise.all([
      sendThenWait(adapter, "session-A", "first call here", { changeTimeoutMs: 1, idleTimeoutMs: 1, idleWindowMs: 1 }),
      sendThenWait(adapter, "session-B", "second call here", { changeTimeoutMs: 1, idleTimeoutMs: 1, idleWindowMs: 1 }),
      sendThenWait(adapter, "session-C", "third call here", { changeTimeoutMs: 1, idleTimeoutMs: 1, idleWindowMs: 1 }),
    ]);
    expect(maxInFlight).toBe(3);
  });

  test("a failed call doesn't poison the lock for subsequent callers", async () => {
    // If a sendThenWait rejects (e.g. sendInput throws), the next caller
    // queued behind it should still run, not see a stale rejected promise.
    let callIdx = 0;
    const adapter: Adapter = {
      name: "lock-poison-test",
      listSessions: async () => [],
      getSession: async () => null,
      getOutput: async () => ({ content: "", lines: 0 }),
      sendInput: async () => ({ ok: true }),
      waitIdle: async () => ({ settled: true, lastSnapshot: { content: "", lines: 0 } }),
      createSession: async () => { throw new Error("not implemented"); },
      startSession: async () => {},
      stopSession: async () => {},
      restartSession: async () => {},
      removeSession: async () => {},
      sendThenWait: async () => {
        const i = callIdx++;
        if (i === 0) throw new Error("first call fails");
        return {
          ok: true,
          changed: true,
          settled: true,
          before: { content: "", lines: 0 },
          after: { content: "", lines: 0 },
          elapsedMs: 1,
        };
      },
    };
    const [first, second] = await Promise.allSettled([
      sendThenWait(adapter, "sess-1", "first call here", { changeTimeoutMs: 1, idleTimeoutMs: 1, idleWindowMs: 1 }),
      sendThenWait(adapter, "sess-1", "second call here", { changeTimeoutMs: 1, idleTimeoutMs: 1, idleWindowMs: 1 }),
    ]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("fulfilled");
  });

  test("adapter sendThenWait override is preferred", async () => {
    const adapter: Adapter = {
      name: "override-adapter",
      listSessions: async () => [],
      getSession: async () => null,
      getOutput: async () => ({ content: "", lines: 0 }),
      sendInput: async () => ({ ok: true }),
      waitIdle: async () => ({ settled: true, lastSnapshot: { content: "", lines: 0 } }),
      createSession: async () => { throw new Error("not implemented"); },
      startSession: async () => {},
      stopSession: async () => {},
      restartSession: async () => {},
      removeSession: async () => {},
      sendThenWait: async () => ({
        ok: true,
        changed: true,
        settled: true,
        before: { content: "B", lines: 0 },
        after: { content: "A", lines: 0 },
        elapsedMs: 42,
        reason: "from override",
      }),
    };
    const result = await sendThenWait(adapter, "sess", "anything goes here", {
      changeTimeoutMs: 1,
      idleTimeoutMs: 1,
      idleWindowMs: 1,
    });
    expect(result.reason).toBe("from override");
    expect(result.elapsedMs).toBe(42);
  });
});
