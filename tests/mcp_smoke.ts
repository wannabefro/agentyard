#!/usr/bin/env bun
// Spawn the agentyard MCP server, drive it over stdio with raw JSON-RPC frames,
// and assert the two key flows: list_sessions returns sessions, and
// resolve_session("fender evals") puts fender-evals on top.
//
// Uses AGENTYARD_MOCK=1 so the assertions are deterministic on machines with
// no aoe CLI or local Claude Code transcripts (e.g. GitHub runners).

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_CMD = ["bun", "run", "src/index.ts"];
// Override the selection state path so the smoke test doesn't touch
// ~/.agentyard/state.json on the developer's machine.
const stateDir = mkdtempSync(join(tmpdir(), "agentyard-mcp-smoke-"));
const statePath = join(stateDir, "state.json");
const SERVER_ENV = {
  ...process.env,
  AGENTYARD_MOCK: "1",
  AGENTYARD_STATE_PATH: statePath,
};

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

const proc = Bun.spawn(SERVER_CMD, {
  cwd: import.meta.dir + "/..",
  env: SERVER_ENV,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});

const stdin = proc.stdin;
const decoder = new TextDecoder();
let buffer = "";
const pending = new Map<number, (msg: JsonRpcMessage) => void>();

async function pump(): Promise<void> {
  for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as JsonRpcMessage;
      if (typeof msg.id === "number") {
        const cb = pending.get(msg.id);
        if (cb) {
          pending.delete(msg.id);
          cb(msg);
        }
      }
    }
  }
}
pump().catch((e) => console.error("read pump error:", e));

let nextId = 1;
async function send(method: string, params?: unknown): Promise<JsonRpcMessage> {
  const id = nextId++;
  const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  const reply = new Promise<JsonRpcMessage>((res) => pending.set(id, res));
  stdin.write(frame);
  await stdin.flush();
  return reply;
}

async function notify(method: string, params?: unknown): Promise<void> {
  const frame = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  stdin.write(frame);
  await stdin.flush();
}

function expect(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    proc.kill();
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

const init = await send("initialize", {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "agentyard-smoke", version: "0.0.0" },
});
expect((init.result as { serverInfo: { name: string } }).serverInfo.name === "agentyard", "initialize -> serverInfo.name == 'agentyard'");

await notify("notifications/initialized");

const tools = await send("tools/list", {});
const toolList = (tools.result as { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] }).tools;
const toolNames = toolList.map((t) => t.name).sort();
const expectedTools = [
  "create_session",
  "get_output",
  "get_session",
  "list_sessions",
  "remove_session",
  "resolve_session",
  "restart_session",
  "select_session",
  "send_input",
  "send_then_wait",
  "start_session",
  "stop_session",
  "wait_for_ready",
  "wait_idle",
];
expect(
  expectedTools.every((n) => toolNames.includes(n)),
  `tools/list -> ${toolNames.join(", ")}`,
);

const sendThenWait = toolList.find((t) => t.name === "send_then_wait");
const props = sendThenWait?.inputSchema.properties ?? {};
expect(
  ["adapter", "id", "text", "changeTimeoutMs", "idleTimeoutMs", "idleWindowMs", "readyTimeoutMs"].every(
    (k) => k in props,
  ),
  `send_then_wait input schema has expected keys: ${Object.keys(props).join(", ")}`,
);

const listResp = await send("tools/call", {
  name: "list_sessions",
  arguments: {},
});
const listText = ((listResp.result as { content: { text: string }[] }).content[0]?.text) ?? "";
const listPayload = JSON.parse(listText) as {
  total: number;
  offset: number;
  limit: number;
  returned: number;
  sessions: { title: string; summary?: unknown; raw?: unknown }[];
};
expect(listPayload.total > 0, `list_sessions -> total=${listPayload.total}`);
expect(
  listPayload.returned <= listPayload.limit,
  `list_sessions -> returned=${listPayload.returned} <= limit=${listPayload.limit}`,
);
// Default shape is slim: each session must omit summary + raw.
const firstSession = listPayload.sessions[0];
expect(
  firstSession !== undefined && !("summary" in firstSession) && !("raw" in firstSession),
  `list_sessions default omits summary+raw (first session keys: ${firstSession ? Object.keys(firstSession).join(",") : "n/a"})`,
);

const resolveResp = await send("tools/call", {
  name: "resolve_session",
  arguments: { query: "fender evals", limit: 3 },
});
const resolveText = ((resolveResp.result as { content: { text: string }[] }).content[0]?.text) ?? "";
const resolvePayload = JSON.parse(resolveText) as {
  candidates: { title: string; score: number }[];
};
expect(
  resolvePayload.candidates[0]?.title === "fender-evals",
  `resolve_session("fender evals") -> top candidate: ${resolvePayload.candidates[0]?.title} (score ${resolvePayload.candidates[0]?.score.toFixed(2)})`,
);

// --- selection flow ---

async function callTool(name: string, args: Record<string, unknown>) {
  const resp = await send("tools/call", { name, arguments: args });
  const text = ((resp.result as { content: { text: string }[] }).content[0]?.text) ?? "";
  return JSON.parse(text);
}

// 1. Read selection — should be empty initially since we use a fresh tmp state.
const initialSel = await callTool("select_session", {});
expect(initialSel.selected === null, `select_session({}) initially -> selected=${JSON.stringify(initialSel.selected)}`);

// 2. Set selection to a known mock session.
const setResp = await callTool("select_session", { adapter: "mock", id: "mock-fender-evals" });
expect(
  setResp.action === "set" && setResp.selected?.id === "mock-fender-evals",
  `select_session(set) -> action=${setResp.action} title=${setResp.title}`,
);
expect(existsSync(statePath), `state file persisted at ${statePath}`);
const onDisk = JSON.parse(readFileSync(statePath, "utf8"));
expect(onDisk.selected?.id === "mock-fender-evals", `on-disk state.selected.id == mock-fender-evals`);

// 3. get_output WITHOUT adapter/id — must fall back to the selection.
const fallbackOutput = await callTool("get_output", { lines: 10 });
expect(
  typeof fallbackOutput.content === "string" && fallbackOutput.content.includes("fender-evals"),
  `get_output() with no args falls back to selection: content head="${(fallbackOutput.content as string).slice(0, 60).replace(/\n/g, " ")}"`,
);

// 4. Setting a nonexistent session must fail with a "session not found" error.
const badSet = await callTool("select_session", { adapter: "mock", id: "does-not-exist" });
expect(
  typeof badSet.error === "string" && badSet.error.includes("session not found"),
  `select_session(invalid) -> error: ${badSet.error}`,
);

// 5. Setting only one of adapter/id is rejected with a clear error.
const halfSet = await callTool("select_session", { adapter: "mock" });
expect(
  typeof halfSet.error === "string" && halfSet.error.includes("both adapter and id"),
  `select_session(half) -> error: ${halfSet.error}`,
);

// 6. Clear the selection.
const cleared = await callTool("select_session", { clear: true });
expect(cleared.selected === null && cleared.action === "cleared", `select_session(clear) -> ${JSON.stringify(cleared)}`);

// 7. After clear, get_output with no args must error rather than crash.
const noSelection = await callTool("get_output", { lines: 10 });
expect(
  typeof noSelection.error === "string" && noSelection.error.includes("no session selected"),
  `get_output() without selection -> error: ${noSelection.error}`,
);

proc.kill();
rmSync(stateDir, { recursive: true, force: true });
console.log("\nMCP smoke test OK");
