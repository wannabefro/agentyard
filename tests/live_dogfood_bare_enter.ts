#!/usr/bin/env bun
// Probe: AoeAdapter.sendInput("") routes through tmux send-keys to deliver
// a bare Enter, dismissing default selections in TUI prompts (notably the
// Claude Code first-boot trust prompt). 0.2.0 claimed this in the schema
// description but aoe send rejects empty input; this verifies the new path.
//
// Run: bun run tests/live_dogfood_bare_enter.ts

import { AoeAdapter } from "@/adapters/aoe/index.ts";

const adapter = new AoeAdapter();
const ts = Date.now();
const targetPath = `/tmp/ay-bare-enter-${ts}`;
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
    title: `ay-bare-enter-${ts}`,
  });
  sessionId = created.id;
  console.log(`  id=${sessionId}`);

  await adapter.startSession(sessionId);
  console.log("Boot delay (3s)");
  await Bun.sleep(3000);

  await snapshot(sessionId, "before bare-Enter");

  console.log("\n=== PROBE: sendInput('') routes through tmux send-keys ===");
  const t0 = Date.now();
  const result = await adapter.sendInput(sessionId, "");
  console.log(`sendInput(empty) result: ${JSON.stringify(result)} in ${Date.now() - t0}ms`);

  if (!result.ok) {
    console.error("FAIL: bare-Enter path did not return ok");
    process.exitCode = 1;
  } else {
    // Wait for the trust prompt to be dismissed and the real prompt to appear.
    console.log("\nWaiting for real prompt...");
    const ready = await adapter.waitForReady(sessionId, { timeoutMs: 15_000, pollIntervalMs: 500 });
    console.log(`waitForReady: ready=${ready.ready} lastLine="${ready.lastLine}"${ready.reason ? ` reason="${ready.reason}"` : ""}`);
    await snapshot(sessionId, "after bare-Enter + waitForReady");

    if (ready.ready && ready.lastLine.trim() === "❯") {
      console.log("\nPASS: bare Enter dismissed the trust prompt and the agent is at the real prompt.");
    } else if (ready.ready) {
      console.log(`\nPARTIAL: ready=true but lastLine="${ready.lastLine}" (expected just ❯)`);
    } else {
      console.log(`\nFAIL: still not ready after bare-Enter. lastLine="${ready.lastLine}"`);
      process.exitCode = 1;
    }
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
