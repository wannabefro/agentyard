#!/usr/bin/env bun
// Probe: codex adapter read path against the real ~/.codex/ on this machine.
// Verifies:
//   1. discoverRollouts walks the YYYY/MM/DD tree without errors
//   2. listSessions returns Session shapes for every rollout
//   3. lenient JSONL parsing tolerates whatever control-character oddities
//      the on-disk catalog contains
//   4. getSession + getOutput work on the most recently active session
//
// Run: bun run tests/live_dogfood_codex_read.ts

import { CodexAdapter } from "@/adapters/codex/index.ts";

const adapter = new CodexAdapter();

const t0 = Date.now();
const sessions = await adapter.listSessions();
const t1 = Date.now();

console.log(`listSessions: ${t1 - t0}ms, ${sessions.length} sessions`);
if (sessions.length === 0) {
  console.error("FAIL — no sessions discovered (expected ~285 on this machine)");
  process.exit(1);
}

const withCwd = sessions.filter((s) => s.workdir).length;
const withBranch = sessions.filter((s) => s.branch).length;
const withSummary = sessions.filter((s) => s.summary).length;
const withTitle = sessions.filter((s) => s.title && s.title !== "(untitled)").length;
console.log(`  with workdir:  ${withCwd}/${sessions.length}`);
console.log(`  with branch:   ${withBranch}/${sessions.length}`);
console.log(`  with summary:  ${withSummary}/${sessions.length}`);
console.log(`  with title:    ${withTitle}/${sessions.length}`);

const byOriginator = new Map<string, number>();
for (const s of sessions) {
  const raw = s.raw as { originator?: string } | null;
  const orig = raw?.originator ?? "unknown";
  byOriginator.set(orig, (byOriginator.get(orig) ?? 0) + 1);
}
console.log(`  by originator:`);
for (const [k, v] of [...byOriginator.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k}: ${v}`);
}

const sorted = [...sessions].sort(
  (a, b) => (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0),
);
const recent = sorted[0]!;
console.log(`\nMost recent session: ${recent.id}`);
console.log(`  title:          ${recent.title}`);
console.log(`  workdir:        ${recent.workdir}`);
console.log(`  branch:         ${recent.branch ?? "(none)"}`);
console.log(`  lastActivityAt: ${recent.lastActivityAt?.toISOString()}`);
console.log(`  summary:        ${(recent.summary ?? "").slice(0, 120)}`);

const t2 = Date.now();
const fetched = await adapter.getSession(recent.id);
const t3 = Date.now();
if (!fetched) {
  console.error(`FAIL — getSession(${recent.id}) returned null after listSessions found it`);
  process.exit(1);
}
console.log(`\ngetSession(${recent.id}): ${t3 - t2}ms`);

const t4 = Date.now();
const output = await adapter.getOutput(recent.id, 50);
const t5 = Date.now();
console.log(`\ngetOutput(${recent.id}, 50): ${t5 - t4}ms`);
console.log(`  flat content chars: ${output.content.length}`);
console.log(`  flat content lines: ${output.lines}`);
console.log(`  structured msgs:    ${output.structured?.length ?? 0}`);
if (output.structured && output.structured.length > 0) {
  const last = output.structured[output.structured.length - 1]!;
  console.log(`  last msg: role=${last.role} ts=${last.timestamp ?? "n/a"} kind=${last.kind ?? "—"}`);
  console.log(`    text head: "${(last.text ?? "").slice(0, 120).replace(/\s+/g, " ")}…"`);
}

const unknown = await adapter.getSession("00000000-0000-0000-0000-000000000000");
if (unknown !== null) {
  console.error("FAIL — getSession for a fake id should return null");
  process.exit(1);
}

console.log("\nVerdict: PASS — read path works against the live ~/.codex/ catalog.");
