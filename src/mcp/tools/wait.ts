// Polling tools: wait_idle (pane unchanged for N ms) and wait_for_ready
// (last line ends with a known prompt cursor). Both target the current
// selection by default; both are read-only.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Deps } from "@/mcp/deps.ts";
import { asJsonText, notImplemented } from "@/mcp/helpers.ts";

export function register(server: McpServer, deps: Deps) {
  const { registry, resolveTarget } = deps;

  server.registerTool(
    "wait_idle",
    {
      title: "Wait for session to settle",
      annotations: { readOnlyHint: true },
      description:
        "Poll the session's pane until output has been unchanged for `idleWindowMs`, or until `timeoutMs` elapses.",
      inputSchema: {
        adapter: z.string().optional(),
        id: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
        idleWindowMs: z.number().int().min(500).max(60_000).default(3000),
        pollIntervalMs: z.number().int().min(250).max(10_000).default(1000),
      },
    },
    async ({ adapter, id, timeoutMs, idleWindowMs, pollIntervalMs }) => {
      const t = await resolveTarget({ adapter, id });
      if (!t.ok) return asJsonText({ error: t.reason });
      const a = registry.get(t.adapter);
      if (!a.waitIdle) return notImplemented(t.adapter, "waitIdle");
      const result = await a.waitIdle(t.id, {
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
      annotations: { readOnlyHint: true },
      description:
        "Poll the session's pane until the last non-empty line ends with a known prompt cursor, " +
        "or until timeoutMs elapses. Use this before send_input when a session has just been started " +
        "and the TUI may still be booting. Currently detects cursors for Claude Code (❯) and Codex CLI (›); " +
        "agents with other prompt shapes (OpenCode, Gemini CLI, Copilot CLI, Mistral Vibe, Pi.dev, " +
        "Factory Droid Coding) will time out — call this only for the supported tools.",
      inputSchema: {
        adapter: z.string().optional(),
        id: z.string().optional(),
        timeoutMs: z.number().int().min(500).max(120_000).default(30_000),
        pollIntervalMs: z.number().int().min(250).max(10_000).default(500),
      },
    },
    async ({ adapter, id, timeoutMs, pollIntervalMs }) => {
      const t = await resolveTarget({ adapter, id });
      if (!t.ok) return asJsonText({ ready: false, reason: t.reason, lastLine: "" });
      const a = registry.get(t.adapter);
      if (!a.waitForReady) {
        return asJsonText({
          ready: false,
          reason: `adapter '${t.adapter}' does not implement waitForReady`,
          lastLine: "",
        });
      }
      const result = await a.waitForReady(t.id, { timeoutMs, pollIntervalMs });
      return asJsonText(result);
    },
  );
}
