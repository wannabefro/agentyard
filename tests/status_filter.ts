#!/usr/bin/env bun
import { AoeAdapter } from "@/adapters/aoe/index.ts";
import { resolve } from "@/resolver/index.ts";

const adapter = new AoeAdapter();
const sessions = await adapter.listSessions();

for (const query of ["idle codex", "error", "idle fender"]) {
  console.log(`\nquery: "${query}"`);
  for (const c of resolve(query, sessions).slice(0, 5)) {
    console.log(
      `  ${c.score.toFixed(2)}  ${c.session.title.padEnd(20)} ${c.session.tool.padEnd(8)} ${c.session.status.padEnd(8)} :: ${c.reasons.join("; ")}`,
    );
  }
}
