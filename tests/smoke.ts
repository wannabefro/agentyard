#!/usr/bin/env bun
import { AoeAdapter } from "@/adapters/aoe/index.ts";
import { resolve } from "@/resolver/index.ts";

const adapter = new AoeAdapter();
const sessions = await adapter.listSessions();
console.log(`listSessions → ${sessions.length} sessions`);
for (const s of sessions.slice(0, 3)) {
  console.log(`  ${s.id}  ${s.title.padEnd(20)} ${s.tool.padEnd(8)} ${s.branch ?? "-"}`);
}

const queries = [
  "fender evals",
  "the codex fender one",
  "skill evals",
  "running",
  "k-repo claude",
];
for (const q of queries) {
  const ranked = resolve(q, sessions).slice(0, 3);
  console.log(`\nquery: "${q}"`);
  for (const c of ranked) {
    console.log(
      `  score=${c.score.toFixed(2)}  ${c.session.title.padEnd(20)} ${c.session.tool.padEnd(8)} :: ${c.reasons.join("; ")}`,
    );
  }
}

if (sessions.length > 0) {
  const fender = sessions.find((s) => s.title === "fender-evals");
  if (fender) {
    const detail = await adapter.getSession(fender.id);
    console.log(`\ngetSession(fender-evals) status: ${detail?.status}`);
  }
}
