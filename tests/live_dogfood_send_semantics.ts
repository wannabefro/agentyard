#!/usr/bin/env bun
// Diagnose: does AoeAdapter.sendInput actually submit text, or only stage it
// in the input line? Phase-3 dogfood (sendThenWait) consistently submits and
// gets agent responses. A later probe against an idle long-lived session
// staged "ping" without submission. This script isolates the variable by
// running both code paths against a fresh throwaway session.
//
// Requires live aoe on $PATH. Not part of `bun test`.
// Run: bun run tests/live_dogfood_send_semantics.ts

import { AoeAdapter } from "@/adapters/aoe/index.ts";
import { sendThenWait } from "@/core/loop.ts";

const adapter = new AoeAdapter();
const ts = Date.now();
const targetPath = `/tmp/ay-diag-target-${ts}`;
let sessionId: string | null = null;

function tail(s: string, n = 12): string {
  return s.split("\n").slice(-n).join("\n");
}

async function snapshot(id: string, label: string): Promise<string> {
  const { content } = await adapter.getOutput(id, 30);
  console.log(`\n--- ${label} ---\n${tail(content, 12)}`);
  return content;
}

try {
  await Bun.spawn(["mkdir", "-p", targetPath]).exited;

  console.log(`Creating throwaway session at ${targetPath}`);
  const created = await adapter.createSession({
    path: targetPath,
    title: `ay-diag-${ts}`,
  });
  sessionId = created.id;
  console.log(`  id=${sessionId}`);

  console.log("Starting...");
  await adapter.startSession(sessionId);

  console.log("Boot delay (3s) then dismiss trust prompt with '1'");
  await Bun.sleep(3000);
  await adapter.sendInput(sessionId, "1");

  console.log("waitForReady (real prompt cursor)");
  const ready = await adapter.waitForReady(sessionId, {
    timeoutMs: 25_000,
    pollIntervalMs: 500,
  });
  if (!ready.ready) {
    throw new Error(`session never reached ready: ${ready.reason}`);
  }
  console.log(`  ready lastLine="${ready.lastLine}"`);

  // ============================================================
  // PROBE A: adapter.sendInput in isolation. No follow-up wait.
  // Did "hello-probe-A" submit, or just stage in input field?
  // ============================================================
  console.log("\n=== PROBE A: adapter.sendInput only ===");
  await snapshot(sessionId, "before A");
  const sendResultA = await adapter.sendInput(sessionId, "Reply with the single word: alphaA. No other output.");
  console.log(`sendInput result: ${JSON.stringify(sendResultA)}`);

  // Settle window: give the agent time to process IF the input was submitted.
  console.log("Waiting 15s for agent to process (if submitted)...");
  await Bun.sleep(15_000);
  const afterA = await snapshot(sessionId, "after A (+15s)");

  const aSubmitted = /alphaA/i.test(afterA) && afterA.toLowerCase().includes("alphaa");
  const aStaged = afterA.includes("Reply with the single word: alphaA");
  console.log(`\nProbe A signals:`);
  console.log(`  pane contains the prompt text echoed: ${aStaged}`);
  console.log(`  pane contains a response 'alphaA' from agent: ${aSubmitted}`);

  // ============================================================
  // PROBE B: full sendThenWait flow (which we believe DOES submit).
  // ============================================================
  console.log("\n=== PROBE B: sendThenWait full loop ===");
  await snapshot(sessionId, "before B");
  const t0 = Date.now();
  const resultB = await sendThenWait(adapter, sessionId, "Reply with the single word: bravoB. No other output.", {
    changeTimeoutMs: 20_000,
    idleTimeoutMs: 90_000,
    idleWindowMs: 5_000,
    pollIntervalMs: 1000,
  });
  console.log(
    `sendThenWait: ok=${resultB.ok} changed=${resultB.changed} settled=${resultB.settled} elapsed=${(resultB.elapsedMs / 1000).toFixed(1)}s wall=${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  if (resultB.reason) console.log(`  reason: ${resultB.reason}`);
  await snapshot(sessionId, "after B");

  const bSubmitted = /bravoB/i.test(resultB.after.content);
  console.log(`\nProbe B signals:`);
  console.log(`  pane contains a response 'bravoB' from agent: ${bSubmitted}`);

  // ============================================================
  // Summary
  // ============================================================
  console.log("\n=== Summary ===");
  console.log(`  A.sendInput submitted (got alphaA response): ${aSubmitted}`);
  console.log(`  B.sendThenWait submitted (got bravoB response): ${bSubmitted}`);
  if (aSubmitted && bSubmitted) {
    console.log("  -> Both paths submit. The earlier 'ping never submitted' must have been environmental.");
  } else if (!aSubmitted && bSubmitted) {
    console.log("  -> sendInput stages, sendThenWait submits. There must be an Enter/newline in the loop machinery.");
  } else if (!aSubmitted && !bSubmitted) {
    console.log("  -> NEITHER submitted. The throwaway session may have a different problem from the original probe.");
  } else {
    console.log("  -> Unexpected: A submitted but B did not.");
  }
} catch (err) {
  console.error("\nERROR:", err);
  process.exitCode = 1;
} finally {
  if (sessionId) {
    console.log("\nCleanup...");
    try {
      await adapter.removeSession(sessionId, { force: true });
      console.log(`  removed ${sessionId}`);
    } catch (err) {
      console.error(`  remove failed: ${err}`);
    }
  }
}
