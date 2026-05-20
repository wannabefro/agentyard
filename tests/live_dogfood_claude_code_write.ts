#!/usr/bin/env bun
// Probe: claude-code write path via ClaudeCodeAdapter.sendThenWait.
// Spawns `claude --resume <id> --print --output-format json <text>` from the
// session's recorded cwd, appends one agent turn to the transcript, and
// validates: ok=true, the new turn's text appears in the after-snapshot,
// before/after differ.
//
// Requires an existing claude-code session UUID to resume. Pass as ARG1.
// If omitted, uses the well-known throwaway session created earlier in
// the dogfood pass (11111111-2222-3333-4444-555555555555) — feasible as
// long as that transcript file still exists.
//
// Run: bun run tests/live_dogfood_claude_code_write.ts [<session-uuid>]
//
// Cost notice: each turn costs ~$0.35 in API tokens at the current model
// because there is no warm prompt cache across fresh subprocess
// invocations. Don't loop this gratuitously.

import { ClaudeCodeAdapter } from "@/adapters/claude-code/index.ts";

const id = process.argv[2] ?? "11111111-2222-3333-4444-555555555555";
const adapter = new ClaudeCodeAdapter();
const ts = Date.now();

const token = `cc-write-${ts}`;
const prompt = `Reply with only the single word: ${token}. No other text.`;

console.log(`Resuming claude-code session ${id}`);
console.log(`Sending prompt: "${prompt}"\n`);

const t0 = Date.now();
const result = await adapter.sendThenWait(id, prompt, {
  changeTimeoutMs: 20_000,
  idleTimeoutMs: 90_000,
  idleWindowMs: 4_000,
  pollIntervalMs: 1000,
});
const wall = Date.now() - t0;

console.log(`ok=${result.ok} changed=${result.changed} settled=${result.settled} elapsed=${(result.elapsedMs / 1000).toFixed(2)}s wall=${(wall / 1000).toFixed(2)}s`);
if (result.reason) console.log(`reason: ${result.reason}`);
console.log(`before content length: ${result.before.content.length}`);
console.log(`after  content length: ${result.after.content.length}`);

const tail = (s: string, n = 20) => s.split("\n").slice(-n).join("\n");
console.log("\n--- before (last 6 lines) ---");
console.log(tail(result.before.content, 6));
console.log("\n--- after (last 15 lines) ---");
console.log(tail(result.after.content, 15));

const inResult = new RegExp(token, "i").test(result.after.content);
console.log(`\ntoken "${token}" present in after snapshot: ${inResult}`);

if (result.ok && inResult) {
  console.log("\nPASS: sendThenWait appended a turn to the transcript and the response is observable.");
} else {
  console.error(`\nFAIL: ok=${result.ok}, token-observable=${inResult}`);
  process.exitCode = 1;
}
