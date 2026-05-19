import type {
  Adapter,
  OutputSnapshot,
  SendThenWaitOptions,
  SendThenWaitResult,
} from "@/adapters/types.ts";

const ECHO_MIN_LENGTH = 8;
const ECHO_NEEDLE_MAX = 30;

function normalizeForEcho(s: string): string {
  return s
    .replace(/[^\x20-\x7e\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

async function waitForChange(
  adapter: Adapter,
  id: string,
  baseline: string,
  timeoutMs: number,
  pollMs: number,
): Promise<{ changed: boolean; snapshot: OutputSnapshot }> {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await adapter.getOutput(id);
  while (Date.now() < deadline) {
    if (snapshot.content !== baseline) {
      return { changed: true, snapshot };
    }
    await Bun.sleep(pollMs);
    snapshot = await adapter.getOutput(id);
  }
  return { changed: snapshot.content !== baseline, snapshot };
}

type EchoResult = {
  echoed: boolean;
  changed: boolean;
  snapshot: OutputSnapshot;
  tooShort: boolean;
};

async function waitForEcho(
  adapter: Adapter,
  id: string,
  sentText: string,
  beforeContent: string,
  timeoutMs: number,
  pollMs: number,
): Promise<EchoResult> {
  const normalizedSent = normalizeForEcho(sentText);
  if (normalizedSent.length < ECHO_MIN_LENGTH) {
    const change = await waitForChange(adapter, id, beforeContent, timeoutMs, pollMs);
    return { echoed: change.changed, changed: change.changed, snapshot: change.snapshot, tooShort: true };
  }

  const needle = normalizedSent.slice(0, ECHO_NEEDLE_MAX);
  const baselineCount = countOccurrences(normalizeForEcho(beforeContent), needle);

  const deadline = Date.now() + timeoutMs;
  let snapshot = await adapter.getOutput(id);
  while (Date.now() < deadline) {
    const currentCount = countOccurrences(normalizeForEcho(snapshot.content), needle);
    if (currentCount > baselineCount) {
      return { echoed: true, changed: true, snapshot, tooShort: false };
    }
    await Bun.sleep(pollMs);
    snapshot = await adapter.getOutput(id);
  }
  const finalChanged = snapshot.content !== beforeContent;
  return { echoed: false, changed: finalChanged, snapshot, tooShort: false };
}

export async function sendThenWait(
  adapter: Adapter,
  id: string,
  text: string,
  opts: SendThenWaitOptions,
): Promise<SendThenWaitResult> {
  if (adapter.sendThenWait) {
    return adapter.sendThenWait(id, text, opts);
  }

  const pollMs = opts.pollIntervalMs ?? 1000;
  const started = Date.now();
  const before = await adapter.getOutput(id);

  const sendResult = await adapter.sendInput(id, text);
  if (!sendResult.ok) {
    return {
      ok: false,
      changed: false,
      settled: false,
      before,
      after: before,
      elapsedMs: Date.now() - started,
      reason: `send failed: ${sendResult.reason}`,
    };
  }

  const echo = await waitForEcho(adapter, id, text, before.content, opts.changeTimeoutMs, pollMs);
  if (!echo.echoed) {
    return {
      ok: false,
      changed: echo.changed,
      settled: false,
      before,
      after: echo.snapshot,
      elapsedMs: Date.now() - started,
      reason: echo.tooShort
        ? `no pane change within ${opts.changeTimeoutMs}ms after send (text shorter than ${ECHO_MIN_LENGTH} chars — echo check skipped)`
        : `sent text did not appear in pane within ${opts.changeTimeoutMs}ms — the agent likely did not receive the input (terminal may be booting or unresponsive)`,
    };
  }

  const idle = await adapter.waitIdle(id, {
    timeoutMs: opts.idleTimeoutMs,
    idleWindowMs: opts.idleWindowMs,
    pollIntervalMs: pollMs,
  });

  return {
    ok: true,
    changed: true,
    settled: idle.settled,
    before,
    after: idle.lastSnapshot,
    elapsedMs: Date.now() - started,
    reason: idle.settled ? undefined : `agent did not settle within ${opts.idleTimeoutMs}ms`,
  };
}
