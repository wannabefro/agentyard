#!/usr/bin/env bun
// Live dogfood: drive a throwaway pepper-dogfood aoe session through
// resolve → send_then_wait. The host machine must already have an aoe
// session titled "pepper-dogfood" in idle state.

import { AoeAdapter } from "@/adapters/aoe/index.ts";
import { sendThenWait } from "@/core/loop.ts";
import { resolve } from "@/resolver/index.ts";

const adapter = new AoeAdapter();
const sessions = await adapter.listSessions();

const ranked = resolve("pepper dogfood", sessions);
const top = ranked[0];
if (!top || top.session.title !== "pepper-dogfood") {
  console.error("resolver did not find pepper-dogfood; ranked:", ranked.map((c) => c.session.title));
  process.exit(1);
}
console.log(`resolved: ${top.session.title} (id=${top.session.id}, score=${top.score.toFixed(2)})`);
console.log(`reasons: ${top.reasons.join("; ")}`);
console.log(`status: ${top.session.status}\n`);

console.log("send_then_wait: 'Reply with the single word: pong. No other output.'");
const t0 = Date.now();
const result = await sendThenWait(adapter, top.session.id, "Reply with the single word: pong. No other output.", {
  changeTimeoutMs: 20_000,
  idleTimeoutMs: 90_000,
  idleWindowMs: 5_000,
  pollIntervalMs: 1000,
});

console.log(`\nelapsed: ${(result.elapsedMs / 1000).toFixed(1)}s (wall: ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log(`ok=${result.ok} changed=${result.changed} settled=${result.settled}`);
if (result.reason) console.log(`reason: ${result.reason}`);

const tail = (s: string, n = 8) => s.split("\n").slice(-n).join("\n");
console.log(`\n--- before (last 6 lines) ---\n${tail(result.before.content, 6)}`);
console.log(`\n--- after (last 12 lines) ---\n${tail(result.after.content, 12)}`);
