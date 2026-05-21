#!/usr/bin/env bun
// Live dogfood: verify agentyard's tools/list response remains compatible
// with Codex CLI's MCP host gate.
//
// Codex 0.132 silently cancels any MCP tool call whose tool was not
// annotated `readOnlyHint: true` in non-interactive (`codex exec`) mode.
// See docs/integrations/codex-host.md for the full diagnosis.
//
// This script spawns the agentyard MCP server the same way Codex would
// (via `bun run src/index.ts` over stdio), exchanges the MCP handshake,
// fetches tools/list, and asserts every tool carries an `annotations`
// object with a defined `readOnlyHint`. It does NOT invoke codex itself
// — the protocol-level check is the regression surface that matters.
//
// Run: bun run tests/live_dogfood_codex_host.ts
//
// Exit code 0 on success, 1 on any failure. Intended for occasional manual
// regression checks; not part of `bun test` because it spawns a subprocess
// and reads files from the repo.

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const serverPath = resolve(import.meta.dir, "..", "src", "index.ts");
const bun = process.execPath; // run with the same bun that started this script

const child = spawn(bun, ["run", serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const messages: Array<Record<string, unknown>> = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // ignore non-JSON lines
    }
  }
});

function send(msg: Record<string, unknown>): void {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

async function waitForMessage(id: number, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = messages.find((x) => x.id === id);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for message id=${id}`);
}

const fails: string[] = [];

try {
  send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "live_dogfood_codex_host", version: "0" },
    },
  });
  await waitForMessage(0);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const resp = (await waitForMessage(1)) as {
    result?: {
      tools?: Array<{
        name: string;
        annotations?: { readOnlyHint?: boolean };
      }>;
    };
  };
  const tools = resp.result?.tools ?? [];
  if (tools.length === 0) fails.push("tools/list returned no tools");

  let readCount = 0;
  let writeCount = 0;
  for (const t of tools) {
    const ann = t.annotations;
    if (!ann || typeof ann.readOnlyHint !== "boolean") {
      fails.push(
        `tool "${t.name}" is missing annotations.readOnlyHint — Codex 0.132 will cancel it ` +
          `in codex exec. See docs/integrations/codex-host.md.`,
      );
      continue;
    }
    if (ann.readOnlyHint) readCount += 1;
    else writeCount += 1;
  }

  console.log(`tools/list: ${tools.length} tools (${readCount} read-only, ${writeCount} write)`);
  if (fails.length === 0) {
    console.log("OK — every tool declares annotations.readOnlyHint; Codex exec gate satisfied.");
  } else {
    console.error(`FAIL — ${fails.length} tool(s) violate the Codex annotations contract:`);
    for (const f of fails) console.error(`  - ${f}`);
  }
} finally {
  child.kill("SIGTERM");
}

process.exit(fails.length === 0 ? 0 : 1);
