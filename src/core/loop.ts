import type {
  Adapter,
  OutputSnapshot,
  SendThenWaitOptions,
  SendThenWaitResult,
} from "@/adapters/types.ts";

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

  const change = await waitForChange(adapter, id, before.content, opts.changeTimeoutMs, pollMs);
  if (!change.changed) {
    return {
      ok: false,
      changed: false,
      settled: false,
      before,
      after: change.snapshot,
      elapsedMs: Date.now() - started,
      reason: `no pane change within ${opts.changeTimeoutMs}ms after send`,
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
