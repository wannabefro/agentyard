#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { AoeAdapter } from "@/adapters/aoe/index.ts";
import { AdapterRegistry } from "@/core/registry.ts";
import { resolve } from "@/resolver/index.ts";

const registry = new AdapterRegistry();
registry.register(new AoeAdapter());

const server = new McpServer(
  { name: "pepper", version: "0.0.1" },
  {
    instructions:
      "pepper orchestrates AI coding agent sessions across adapters. " +
      "Use resolve_session to map a natural-language reference to a concrete session, " +
      "then call get_output, send_input, or wait_idle against the chosen (adapter, id) pair.",
  },
);

function asJsonText(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

server.registerTool(
  "list_sessions",
  {
    title: "List sessions",
    description: "List every known agent session across all registered adapters.",
    inputSchema: {},
  },
  async () => {
    const sessions = await registry.listAllSessions();
    return asJsonText({ count: sessions.length, sessions });
  },
);

server.registerTool(
  "resolve_session",
  {
    title: "Resolve session",
    description:
      "Map a natural-language reference (e.g. 'the fender evals one', 'the running codex session') " +
      "to ranked session candidates with reasons. Returns the top N matches.",
    inputSchema: {
      query: z.string().min(1).describe("Free-text reference to a session"),
      limit: z.number().int().min(1).max(20).default(5),
    },
  },
  async ({ query, limit }) => {
    const sessions = await registry.listAllSessions();
    const candidates = resolve(query, sessions).slice(0, limit);
    return asJsonText({
      query,
      count: candidates.length,
      candidates: candidates.map((c) => ({
        adapter: c.session.adapter,
        id: c.session.id,
        title: c.session.title,
        tool: c.session.tool,
        branch: c.session.branch,
        repoRoot: c.session.repoRoot,
        score: c.score,
        reasons: c.reasons,
      })),
    });
  },
);

server.registerTool(
  "get_session",
  {
    title: "Get session",
    description: "Fetch full detail for one session, including live status.",
    inputSchema: {
      adapter: z.string().describe("Adapter name, e.g. 'aoe'"),
      id: z.string().describe("Session id"),
    },
  },
  async ({ adapter, id }) => {
    const session = await registry.get(adapter).getSession(id);
    if (!session) return asJsonText({ error: "session not found", adapter, id });
    return asJsonText(session);
  },
);

server.registerTool(
  "get_output",
  {
    title: "Get session output",
    description: "Read the last N lines of a session's terminal pane.",
    inputSchema: {
      adapter: z.string(),
      id: z.string(),
      lines: z.number().int().min(1).max(2000).default(200),
    },
  },
  async ({ adapter, id, lines }) => {
    const snap = await registry.get(adapter).getOutput(id, lines);
    return asJsonText(snap);
  },
);

server.registerTool(
  "send_input",
  {
    title: "Send input to session",
    description:
      "Send a message to a running agent session. The agent will receive it as if the user typed it.",
    inputSchema: {
      adapter: z.string(),
      id: z.string(),
      text: z.string().min(1),
    },
  },
  async ({ adapter, id, text }) => {
    const result = await registry.get(adapter).sendInput(id, text);
    return asJsonText(result);
  },
);

server.registerTool(
  "wait_idle",
  {
    title: "Wait for session to settle",
    description:
      "Poll the session's pane until output has been unchanged for `idleWindowMs`, or until `timeoutMs` elapses.",
    inputSchema: {
      adapter: z.string(),
      id: z.string(),
      timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
      idleWindowMs: z.number().int().min(500).max(60_000).default(3000),
      pollIntervalMs: z.number().int().min(250).max(10_000).default(1000),
    },
  },
  async ({ adapter, id, timeoutMs, idleWindowMs, pollIntervalMs }) => {
    const result = await registry.get(adapter).waitIdle(id, {
      timeoutMs,
      idleWindowMs,
      pollIntervalMs,
    });
    return asJsonText(result);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`pepper MCP server up; adapters: ${registry.list().join(", ")}`);

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});
