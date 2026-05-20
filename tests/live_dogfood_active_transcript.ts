#!/usr/bin/env bun
// Probe: claude-code adapter against an actively-being-written transcript.
// The adapter's JSONL reader (src/adapters/claude-code/transcripts.ts) already
// tolerates malformed/truncated trailing lines, but this confirms the
// behavior against a real in-flight file. Run while a Claude Code session
// is active; pass the active session UUID as ARG1.
//
// Run: bun run tests/live_dogfood_active_transcript.ts <session-uuid>

import { ClaudeCodeAdapter } from "@/adapters/claude-code/index.ts";

const id = process.argv[2];
if (!id) {
  console.error("Usage: bun run tests/live_dogfood_active_transcript.ts <session-uuid>");
  console.error("Tip: ls ~/.claude/projects/<project-slug>/*.jsonl");
  process.exit(2);
}

const adapter = new ClaudeCodeAdapter();

const t0 = Date.now();
const session = await adapter.getSession(id);
const t1 = Date.now();
const output = await adapter.getOutput(id, 50);
const t2 = Date.now();

console.log(`getSession(${id}): ${t1 - t0}ms`);
if (!session) {
  console.error("  null — session not found in any discovered transcripts");
  process.exit(1);
}
console.log(`  title:          ${session.title}`);
console.log(`  workdir:        ${session.workdir}`);
console.log(`  branch:         ${session.branch}`);
console.log(`  createdAt:      ${session.createdAt?.toISOString()}`);
console.log(`  lastActivityAt: ${session.lastActivityAt?.toISOString()}`);
console.log(`  summary chars:  ${session.summary?.length ?? 0}`);

console.log(`\ngetOutput(${id}, 50): ${t2 - t1}ms`);
console.log(`  flat content chars: ${output.content.length}`);
console.log(`  flat content lines: ${output.lines}`);
console.log(`  structured msgs:    ${output.structured?.length ?? 0}`);
if (output.structured && output.structured.length > 0) {
  const last = output.structured[output.structured.length - 1]!;
  console.log(`  last msg: role=${last.role} ts=${last.timestamp ?? "n/a"}`);
  console.log(`    text head: "${(last.text ?? "").slice(0, 100).replace(/\s+/g, " ")}…"`);
}

console.log("\nVerdict: PASS — both calls returned cleanly against an in-flight transcript.");
