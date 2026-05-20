#!/usr/bin/env bun
// Probe: codex write path via CodexAdapter.sendThenWait.
//
// Spawns `codex exec resume --json -o <tmp> --skip-git-repo-check <id> <text>`
// from the session's recorded cwd, appends one agent turn to the rollout
// JSONL, and validates: ok=true, the new turn's text appears in the after
// snapshot, before/after differ.
//
// Strategy: create a fresh throwaway session via `codex exec` in /tmp, then
// resume it via the adapter. This avoids depending on a pre-existing session
// id and keeps the test self-contained.
//
// Run: bun run tests/live_dogfood_codex_write.ts
//
// Cost notice: each turn pays for input tokens (~17K cold, ~40K warm with
// ~30% cache hit). Don't loop gratuitously.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter } from "@/adapters/codex/index.ts";

const adapter = new CodexAdapter();

// Step 1: create a fresh session by spawning `codex exec` directly. We can't
// use the adapter for creation (no createSession yet) — that's fine, this is
// dogfooding the resume path, not the lifecycle path.
const cwd = mkdtempSync(join(tmpdir(), "agentyard-codex-write-"));
console.log(`Creating throwaway codex session in ${cwd}`);

const before = await adapter.listSessions();
const beforeIds = new Set(before.map((s) => s.id));

const createProc = Bun.spawn(
  [
    "codex",
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "Respond with exactly: BRAVO",
  ],
  { cwd, stdout: "pipe", stderr: "pipe" },
);
const [createStdout, createStderr, createExit] = await Promise.all([
  new Response(createProc.stdout).text(),
  new Response(createProc.stderr).text(),
  createProc.exited,
]);
if (createExit !== 0) {
  console.error(`FAIL: codex exec returned ${createExit}\n${createStderr}`);
  process.exit(1);
}

// Pull the session id out of the thread.started event.
let createdId: string | null = null;
for (const line of createStdout.split("\n")) {
  if (!line) continue;
  try {
    const ev = JSON.parse(line) as { type?: string; thread_id?: string };
    if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
      createdId = ev.thread_id;
      break;
    }
  } catch {
    // skip
  }
}
if (!createdId) {
  console.error(`FAIL: could not find thread.started in stdout:\n${createStdout}`);
  process.exit(1);
}
console.log(`Created session ${createdId}`);

// Step 2: confirm the adapter discovers it.
const after = await adapter.listSessions();
const created = after.find((s) => s.id === createdId);
if (!created) {
  console.error(`FAIL: adapter.listSessions did not surface the new session ${createdId}`);
  console.error(`(before: ${before.length} sessions, after: ${after.length} sessions, new: ${after.filter((s) => !beforeIds.has(s.id)).map((s) => s.id).join(", ")})`);
  process.exit(1);
}
console.log(`Adapter discovered session: workdir=${created.workdir} title="${created.title}"`);

// Step 3: resume via the adapter's write path.
const token = `cdx-${Date.now()}`;
const prompt = `Reply with only the single word: ${token}. No other text.`;
console.log(`\nResuming session ${createdId} via adapter.sendThenWait`);
console.log(`Prompt: "${prompt}"\n`);

const t0 = Date.now();
const result = await adapter.sendThenWait(createdId, prompt, {
  changeTimeoutMs: 20_000,
  idleTimeoutMs: 90_000,
  idleWindowMs: 4_000,
  pollIntervalMs: 1000,
});
const wall = Date.now() - t0;

console.log(`ok=${result.ok} changed=${result.changed} settled=${result.settled} elapsed=${(result.elapsedMs / 1000).toFixed(2)}s wall=${(wall / 1000).toFixed(2)}s`);
if (result.reason) console.log(`reason: ${result.reason}`);
console.log(`before content chars: ${result.before.content.length}`);
console.log(`after  content chars: ${result.after.content.length}`);

const tail = (s: string, n = 15) => s.split("\n").slice(-n).join("\n");
console.log("\n--- after (last 8 lines) ---");
console.log(tail(result.after.content, 8));

const tokenObservable = new RegExp(token, "i").test(result.after.content);
console.log(`\ntoken "${token}" present in after snapshot: ${tokenObservable}`);

// Cleanup the temp workdir (the rollout file in ~/.codex/sessions/... is left;
// it's a real codex session and removing it would race with codex's own state).
rmSync(cwd, { recursive: true, force: true });

if (result.ok && result.changed && tokenObservable) {
  console.log("\nPASS: sendThenWait resumed the session and the response is observable.");
} else {
  console.error(`\nFAIL: ok=${result.ok}, changed=${result.changed}, token-observable=${tokenObservable}`);
  process.exit(1);
}
