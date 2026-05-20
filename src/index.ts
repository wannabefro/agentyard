#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { AoeAdapter } from "@/adapters/aoe/index.ts";
import { ClaudeCodeAdapter } from "@/adapters/claude-code/index.ts";
import { CodexAdapter } from "@/adapters/codex/index.ts";
import { MockAdapter } from "@/adapters/mock/index.ts";
import type { Session } from "@/core/session.ts";
import { sendThenWait } from "@/core/loop.ts";
import { AdapterRegistry } from "@/core/registry.ts";
import { resolve } from "@/resolver/index.ts";
import pkg from "../package.json" with { type: "json" };

const registry = new AdapterRegistry();
registry.register(new AoeAdapter());
registry.register(new ClaudeCodeAdapter());
registry.register(new CodexAdapter());
if (process.env.AGENTYARD_MOCK === "1") {
  registry.register(new MockAdapter());
}

const server = new McpServer(
  { name: "agentyard", version: pkg.version },
  {
    instructions:
      "agentyard orchestrates AI coding agent sessions across adapters. " +
      "Use resolve_session to map a natural-language reference to a concrete session, " +
      "then call get_output, send_input, or wait_idle against the chosen (adapter, id) pair.",
  },
);

function asJsonText(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function notImplemented(adapterName: string, method: string) {
  return asJsonText({
    ok: false,
    reason: `adapter '${adapterName}' does not implement ${method}`,
  });
}

server.registerTool(
  "list_sessions",
  {
    title: "List sessions",
    description:
      "List every known agent session across all registered adapters. " +
      "Returns a slim shape by default — per-session `summary` and `raw` " +
      "fields are stripped to keep the response within MCP host token " +
      "budgets (the user's catalog of 149 aoe sessions overflowed without " +
      "this). Set withSummary=true to include the content summary used by " +
      "resolve_session's content matching; set withRaw=true to include the " +
      "adapter-native response objects. Use limit/offset to paginate.",
    inputSchema: {
      withSummary: z.boolean().default(false).describe(
        "Include each session's content summary (~up to 1500 chars per " +
        "aoe session). Adds a CLI capture per aoe session — slow on large " +
        "catalogs.",
      ),
      withRaw: z.boolean().default(false).describe(
        "Include adapter-native raw response objects on each session. " +
        "Verbose; only useful for debugging adapter normalization.",
      ),
      limit: z.number().int().min(1).max(500).default(50).describe(
        "Maximum number of sessions to return (after applying offset).",
      ),
      offset: z.number().int().min(0).default(0).describe(
        "Number of sessions to skip from the start of the catalog.",
      ),
    },
  },
  async ({ withSummary, withRaw, limit, offset }) => {
    const all = await registry.listAllSessions("cached", { withSummary });
    const total = all.length;
    const page = all.slice(offset, offset + limit);
    const sessions = page.map((s) => slimSession(s, { withSummary, withRaw }));
    return asJsonText({
      total,
      offset,
      limit,
      returned: sessions.length,
      sessions,
    });
  },
);

function slimSession(
  s: Session,
  opts: { withSummary: boolean; withRaw: boolean },
): Partial<Session> {
  const { summary: _summary, raw: _raw, ...rest } = s;
  const out: Partial<Session> = { ...rest };
  if (opts.withSummary) out.summary = s.summary;
  if (opts.withRaw) out.raw = s.raw;
  return out;
}

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
    // Resolver's content matching scores against Session.summary; request
    // the full listing so summaries are populated.
    const sessions = await registry.listAllSessions("cached", { withSummary: true });
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
    description:
      "Read the last N lines of a session's output. Always returns flat `content` (string) and `lines` (number). Conversation-shaped adapters (e.g. claude-code) also return `structured`: an array of {role, text, timestamp?, kind?} messages so hosts can render or filter typed messages without re-parsing the flat text.",
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
      "Fire-and-forget send: transmits text to the underlying tmux pane. " +
      "Returns ok:true if the CLI accepted the send — NOT a guarantee the " +
      "agent received and processed it. Against a session aoe classifies " +
      "as `error` or `stopped`, the send may trigger an auto-revive and " +
      "the keystrokes can race the agent's readiness window, leaving the " +
      "input staged but not submitted. For guaranteed delivery use " +
      "send_then_wait, which polls the pane for evidence the agent saw " +
      "the input.",
    inputSchema: {
      adapter: z.string(),
      id: z.string(),
      text: z.string().min(0).describe(
        "Text to send. Empty string sends a bare Enter, useful for confirming " +
        "default selections in TUI prompts (e.g. Claude Code's trust prompt).",
      ),
    },
  },
  async ({ adapter, id, text }) => {
    const a = registry.get(adapter);
    if (!a.sendInput) return notImplemented(adapter, "sendInput");
    const result = await a.sendInput(id, text);
    return asJsonText(result);
  },
);

server.registerTool(
  "send_then_wait",
  {
    title: "Send input and wait for the agent to settle",
    description:
      "Send a message to a session and block until the agent has processed it: " +
      "(1) snapshot the pane, (2) send the text, (3) wait for the pane to change " +
      "(proves the agent received it), (4) wait for the pane to stop changing for " +
      "`idleWindowMs` (proves the agent is done). Returns before/after snapshots and " +
      "whether each phase succeeded. This is the canonical loop primitive — call it " +
      "in a loop from a host to drive an agent through multi-turn work.",
    inputSchema: {
      adapter: z.string(),
      id: z.string(),
      text: z.string().min(1),
      changeTimeoutMs: z.number().int().min(500).max(120_000).default(15_000),
      idleTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
      idleWindowMs: z.number().int().min(500).max(60_000).default(5_000),
      pollIntervalMs: z.number().int().min(250).max(10_000).default(1000),
      readyTimeoutMs: z.number().int().min(500).max(120_000).default(30_000),
    },
  },
  async ({ adapter, id, text, changeTimeoutMs, idleTimeoutMs, idleWindowMs, pollIntervalMs, readyTimeoutMs }) => {
    const result = await sendThenWait(registry.get(adapter), id, text, {
      changeTimeoutMs,
      idleTimeoutMs,
      idleWindowMs,
      pollIntervalMs,
      readyTimeoutMs,
    });
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
    const a = registry.get(adapter);
    if (!a.waitIdle) return notImplemented(adapter, "waitIdle");
    const result = await a.waitIdle(id, {
      timeoutMs,
      idleWindowMs,
      pollIntervalMs,
    });
    return asJsonText(result);
  },
);

server.registerTool(
  "wait_for_ready",
  {
    title: "Wait for agent prompt cursor",
    description:
      "Poll the session's pane until the last non-empty line ends with a known prompt cursor, " +
      "or until timeoutMs elapses. Use this before send_input when a session has just been started " +
      "and the TUI may still be booting. Currently detects cursors for Claude Code (❯) and Codex CLI (›); " +
      "agents with other prompt shapes (OpenCode, Gemini CLI, Copilot CLI, Mistral Vibe, Pi.dev, " +
      "Factory Droid Coding) will time out — call this only for the supported tools.",
    inputSchema: {
      adapter: z.string(),
      id: z.string(),
      timeoutMs: z.number().int().min(500).max(120_000).default(30_000),
      pollIntervalMs: z.number().int().min(250).max(10_000).default(500),
    },
  },
  async ({ adapter, id, timeoutMs, pollIntervalMs }) => {
    const a = registry.get(adapter);
    if (!a.waitForReady) {
      return asJsonText({
        ready: false,
        reason: `adapter '${adapter}' does not implement waitForReady`,
        lastLine: "",
      });
    }
    const result = await a.waitForReady(id, { timeoutMs, pollIntervalMs });
    return asJsonText(result);
  },
);

server.registerTool(
  "create_session",
  {
    title: "Create session",
    description: "Create a new agent session via the adapter (e.g. `aoe add`). Returns the new session id and title.",
    inputSchema: {
      adapter: z.string().describe("Adapter name, e.g. 'aoe'"),
      path: z.string().min(1).describe("Absolute path the session should work in"),
      title: z.string().optional().describe("Human-readable session title"),
      cmd: z.string().default("claude").describe("Agent command to run (default: claude)"),
    },
  },
  async ({ adapter, path, title, cmd }) => {
    const a = registry.get(adapter);
    if (!a.createSession) return notImplemented(adapter, "createSession");
    const result = await a.createSession({ path, title, cmd });
    registry.invalidate();
    return asJsonText({ adapter, ...result });
  },
);

server.registerTool(
  "start_session",
  {
    title: "Start session",
    description: "Start a stopped agent session.",
    inputSchema: {
      adapter: z.string(),
      id: z.string(),
    },
  },
  async ({ adapter, id }) => {
    const a = registry.get(adapter);
    if (!a.startSession) return notImplemented(adapter, "startSession");
    await a.startSession(id);
    registry.invalidate();
    return asJsonText({ ok: true, adapter, id });
  },
);

server.registerTool(
  "stop_session",
  {
    title: "Stop session",
    description: "Stop a running agent session.",
    inputSchema: {
      adapter: z.string(),
      id: z.string(),
    },
  },
  async ({ adapter, id }) => {
    const a = registry.get(adapter);
    if (!a.stopSession) return notImplemented(adapter, "stopSession");
    await a.stopSession(id);
    registry.invalidate();
    return asJsonText({ ok: true, adapter, id });
  },
);

server.registerTool(
  "restart_session",
  {
    title: "Restart session",
    description: "Restart a session (stop then start).",
    inputSchema: {
      adapter: z.string(),
      id: z.string(),
    },
  },
  async ({ adapter, id }) => {
    const a = registry.get(adapter);
    if (!a.restartSession) return notImplemented(adapter, "restartSession");
    await a.restartSession(id);
    registry.invalidate();
    return asJsonText({ ok: true, adapter, id });
  },
);

server.registerTool(
  "remove_session",
  {
    title: "Remove session",
    description: "Remove a session record and optionally its worktree/branch.",
    inputSchema: {
      adapter: z.string(),
      id: z.string(),
      deleteWorktree: z.boolean().default(false),
      deleteBranch: z.boolean().default(false),
      force: z.boolean().default(false),
    },
  },
  async ({ adapter, id, deleteWorktree, deleteBranch, force }) => {
    const a = registry.get(adapter);
    if (!a.removeSession) return notImplemented(adapter, "removeSession");
    await a.removeSession(id, { deleteWorktree, deleteBranch, force });
    registry.invalidate();
    return asJsonText({ ok: true, adapter, id });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`agentyard MCP server up; adapters: ${registry.list().join(", ")}`);

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});
