#!/usr/bin/env bun
// Spawn the pepper MCP server, drive it over stdio with raw JSON-RPC frames,
// and assert the two key flows: list_sessions returns aoe sessions, and
// resolve_session("fender evals") puts fender-evals on top.

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_CMD = ["bun", "run", "src/index.ts"];

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
  clientInfo: { name: "pepper-smoke", version: "0.0.0" },
});
expect((init.result as { serverInfo: { name: string } }).serverInfo.name === "pepper", "initialize -> serverInfo.name == 'pepper'");

await notify("notifications/initialized");

const tools = await send("tools/list", {});
const toolNames = (tools.result as { tools: { name: string }[] }).tools
  .map((t) => t.name)
  .sort();
expect(
  ["get_output", "get_session", "list_sessions", "resolve_session", "send_input", "wait_idle"]
    .every((n) => toolNames.includes(n)),
  `tools/list -> ${toolNames.join(", ")}`,
);

const listResp = await send("tools/call", {
  name: "list_sessions",
  arguments: {},
});
const listText = ((listResp.result as { content: { text: string }[] }).content[0]?.text) ?? "";
const listPayload = JSON.parse(listText) as { count: number; sessions: { title: string }[] };
expect(listPayload.count > 0, `list_sessions -> ${listPayload.count} sessions`);

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

proc.kill();
console.log("\nMCP smoke test OK");
