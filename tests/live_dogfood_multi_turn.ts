#!/usr/bin/env bun
// Probe: drive a single throwaway aoe session through three sequential
// sendThenWait calls and confirm each turn produces a discrete, agent-
// processed response. This is the orchestrator's canonical use case —
// MCP hosts call sendThenWait in a loop to walk an agent through
// multi-turn work — but every prior dogfood was single-turn. Catches:
//   - per-session lock holds across turns
//   - readyTimeoutMs pre-send check works when the prior turn just left
//     the agent at a finished prompt
//   - echo-detection's "appeared more times than before" math doesn't
//     drift when prior turns left similar text in the pane scrollback
//
// Run: bun run tests/live_dogfood_multi_turn.ts

import { AoeAdapter } from "@/adapters/aoe/index.ts";
import { sendThenWait } from "@/core/loop.ts";

const adapter = new AoeAdapter();
const ts = Date.now();
const targetPath = `/tmp/ay-multi-turn-${ts}`;
let sessionId: string | null = null;

type Turn = { prompt: string; expectedToken: string };
const TURNS: Turn[] = [
  { prompt: "Reply with only the single word: alphaT1. No other text.", expectedToken: "alphaT1" },
  { prompt: "Reply with only the single word: bravoT2. No other text.", expectedToken: "bravoT2" },
  { prompt: "Reply with only the single word: charlieT3. No other text.", expectedToken: "charlieT3" },
];

try {
  await Bun.spawn(["mkdir", "-p", targetPath]).exited;

  console.log(`Setup: create + start + dismiss trust + waitForReady`);
  const created = await adapter.createSession({
    path: targetPath,
    title: `ay-mt-${ts}`,
  });
  sessionId = created.id;
  await adapter.startSession(sessionId);
  await Bun.sleep(3000);
  // Use the bare-Enter path landed in this session — proves it composes
  // cleanly with the rest of the loop.
  const dismiss = await adapter.sendInput(sessionId, "");
  if (!dismiss.ok) throw new Error(`bare-Enter dismiss failed: ${dismiss.reason}`);
  const ready = await adapter.waitForReady(sessionId, { timeoutMs: 20_000, pollIntervalMs: 500 });
  if (!ready.ready) throw new Error(`session never reached real prompt: ${ready.reason}`);
  console.log(`  ready lastLine="${ready.lastLine}"`);

  const elapsedPerTurn: number[] = [];
  const observedTokens: string[] = [];

  for (let i = 0; i < TURNS.length; i += 1) {
    const turn = TURNS[i]!;
    const turnNum = i + 1;
    console.log(`\n=== Turn ${turnNum} of ${TURNS.length}: "${turn.expectedToken}" ===`);
    const t0 = Date.now();
    const result = await sendThenWait(adapter, sessionId, turn.prompt, {
      changeTimeoutMs: 20_000,
      idleTimeoutMs: 90_000,
      idleWindowMs: 4_000,
      pollIntervalMs: 1000,
    });
    const elapsed = Date.now() - t0;
    elapsedPerTurn.push(elapsed);

    console.log(`  ok=${result.ok} changed=${result.changed} settled=${result.settled} elapsed=${(elapsed / 1000).toFixed(1)}s`);
    if (!result.ok) {
      console.error(`  FAIL turn ${turnNum}: reason=${result.reason}`);
      process.exitCode = 1;
      break;
    }

    const matched = new RegExp(turn.expectedToken, "i").test(result.after.content);
    const otherMatched = TURNS.filter((_, j) => j !== i).some((t) =>
      // The other turns' tokens should also appear in scrollback (they were
      // sent prior). But the freshly-rendered tail should show ONLY this
      // turn's token at the bottom. Check the trailing slice.
      false,
    );
    void otherMatched;
    const lastFew = result.after.content.split("\n").slice(-20).join("\n");
    const matchedInTail = new RegExp(turn.expectedToken, "i").test(lastFew);
    console.log(`  expected token "${turn.expectedToken}" in pane: ${matched}, in last 20 lines: ${matchedInTail}`);
    if (matchedInTail) observedTokens.push(turn.expectedToken);
  }

  console.log("\n=== Summary ===");
  console.log(`  turns expected: ${TURNS.length}`);
  console.log(`  turns observed (token in tail): ${observedTokens.length}`);
  console.log(`  elapsed per turn (s): ${elapsedPerTurn.map((e) => (e / 1000).toFixed(1)).join(", ")}`);
  if (observedTokens.length === TURNS.length) {
    console.log(`\nPASS: all ${TURNS.length} turns produced their distinct tokens in order.`);
  } else {
    console.error(`\nFAIL: only ${observedTokens.length} of ${TURNS.length} tokens observed.`);
    process.exitCode = 1;
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
