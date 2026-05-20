#!/usr/bin/env bun
// Live dogfood: verify the AoeAdapter lifecycle lock serializes concurrent
// create/start across distinct sessions. Phase-3 stress (2026-05-20) found
// that `Promise.all([setupSession(A), setupSession(B)])` collided on aoe's
// internal state — `session start` failed exit 1. After the adapter-wide
// lifecycle queue (0.1.6+), this same parallel pattern should succeed
// because the adapter internally serializes the lifecycle calls.
//
// Requires a live aoe install on $PATH. Not part of `bun test`.
// Run with: bun run tests/live_dogfood_concurrent_lifecycle.ts

import { AoeAdapter } from "@/adapters/aoe/index.ts";

const adapter = new AoeAdapter();
const ts = Date.now();
const targets = [
  { label: "A", path: `/tmp/ay-lock-target-a-${ts}` },
  { label: "B", path: `/tmp/ay-lock-target-b-${ts}` },
];

const createdIds: string[] = [];

async function ensureDir(path: string): Promise<void> {
  await Bun.spawn(["mkdir", "-p", path]).exited;
}

try {
  await Promise.all(targets.map((t) => ensureDir(t.path)));

  console.log("=== concurrent createSession (was: races on sessions.json) ===");
  const t0 = Date.now();
  const created = await Promise.all(
    targets.map((t) =>
      adapter.createSession({
        path: t.path,
        title: `ay-lock-${t.label}-${ts}`,
      }),
    ),
  );
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  for (const c of created) {
    console.log(`  created id=${c.id} title=${c.title}`);
    createdIds.push(c.id);
  }

  console.log("\n=== concurrent startSession (was: exit 1 from aoe) ===");
  const t1 = Date.now();
  await Promise.all(created.map((c) => adapter.startSession(c.id)));
  console.log(`  done in ${((Date.now() - t1) / 1000).toFixed(2)}s`);

  console.log("\n=== concurrent waitForReady (reads — already parallel-safe) ===");
  // Boot delay, then dismiss the Claude Code trust prompt on each so the
  // sessions actually reach a real prompt cursor instead of sitting on the
  // "Do you trust the files?" selector forever.
  await new Promise((r) => setTimeout(r, 3000));
  await Promise.all(created.map((c) => adapter.sendInput(c.id, "1")));

  const t2 = Date.now();
  const readiness = await Promise.all(
    created.map((c) =>
      adapter.waitForReady(c.id, { timeoutMs: 25_000, pollIntervalMs: 500 }),
    ),
  );
  console.log(`  done in ${((Date.now() - t2) / 1000).toFixed(2)}s`);
  for (let i = 0; i < readiness.length; i += 1) {
    const r = readiness[i]!;
    console.log(`  ${targets[i]!.label}: ready=${r.ready} lastLine="${r.lastLine}"`);
  }

  const allReady = readiness.every((r) => r.ready);
  if (!allReady) {
    console.error("\nFAIL: at least one session did not reach ready");
    process.exitCode = 1;
  } else {
    console.log("\nPASS: concurrent create+start+ready succeeded on two sessions");
  }
} catch (err) {
  console.error("\nUNEXPECTED ERROR:", err);
  process.exitCode = 1;
} finally {
  console.log("\n=== cleanup (concurrent removeSession) ===");
  const results = await Promise.allSettled(
    createdIds.map((id) =>
      adapter.removeSession(id, { deleteWorktree: false, deleteBranch: false, force: true }),
    ),
  );
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i]!;
    if (r.status === "fulfilled") {
      console.log(`  removed ${createdIds[i]}`);
    } else {
      console.error(`  remove failed for ${createdIds[i]}: ${r.reason}`);
    }
  }
}
