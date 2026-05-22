// Session lifecycle: create, start, stop, restart, remove. These all
// mutate adapter state and invalidate the registry's session cache.
// create_session also auto-selects the freshly created session.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Deps } from "@/mcp/deps.ts";
import { asJsonText, notImplemented } from "@/mcp/helpers.ts";

export function register(server: McpServer, deps: Deps) {
  const { registry, selectionStore, resolveTarget } = deps;

  server.registerTool(
    "create_session",
    {
      title: "Create session",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
      // Auto-select the newly created session — the natural next action is
      // to interact with it, and re-typing (adapter, id) every call defeats
      // the point of having a selection.
      await selectionStore.set({ adapter, id: result.id, title: result.title });
      return asJsonText({ adapter, ...result, selected: true });
    },
  );

  server.registerTool(
    "start_session",
    {
      title: "Start session",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      description: "Start a stopped agent session.",
      inputSchema: {
        adapter: z.string().optional(),
        id: z.string().optional(),
      },
    },
    async ({ adapter, id }) => {
      const t = await resolveTarget({ adapter, id });
      if (!t.ok) return asJsonText({ error: t.reason });
      const a = registry.get(t.adapter);
      if (!a.startSession) return notImplemented(t.adapter, "startSession");
      await a.startSession(t.id);
      registry.invalidate();
      return asJsonText({ ok: true, adapter: t.adapter, id: t.id });
    },
  );

  server.registerTool(
    "stop_session",
    {
      title: "Stop session",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      description: "Stop a running agent session.",
      inputSchema: {
        adapter: z.string().optional(),
        id: z.string().optional(),
      },
    },
    async ({ adapter, id }) => {
      const t = await resolveTarget({ adapter, id });
      if (!t.ok) return asJsonText({ error: t.reason });
      const a = registry.get(t.adapter);
      if (!a.stopSession) return notImplemented(t.adapter, "stopSession");
      await a.stopSession(t.id);
      registry.invalidate();
      return asJsonText({ ok: true, adapter: t.adapter, id: t.id });
    },
  );

  server.registerTool(
    "restart_session",
    {
      title: "Restart session",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      description: "Restart a session (stop then start).",
      inputSchema: {
        adapter: z.string().optional(),
        id: z.string().optional(),
      },
    },
    async ({ adapter, id }) => {
      const t = await resolveTarget({ adapter, id });
      if (!t.ok) return asJsonText({ error: t.reason });
      const a = registry.get(t.adapter);
      if (!a.restartSession) return notImplemented(t.adapter, "restartSession");
      await a.restartSession(t.id);
      registry.invalidate();
      return asJsonText({ ok: true, adapter: t.adapter, id: t.id });
    },
  );

  server.registerTool(
    "remove_session",
    {
      title: "Remove session",
      // Genuinely destructive — deletes session record, and optionally
      // worktree/branch. The host should require explicit user confirmation.
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        "Remove a session record and optionally its worktree/branch. " +
        "If the removed session is the current selection, the selection is auto-cleared.",
      inputSchema: {
        adapter: z.string().optional(),
        id: z.string().optional(),
        deleteWorktree: z.boolean().default(false),
        deleteBranch: z.boolean().default(false),
        force: z.boolean().default(false),
      },
    },
    async ({ adapter, id, deleteWorktree, deleteBranch, force }) => {
      const t = await resolveTarget({ adapter, id });
      if (!t.ok) return asJsonText({ error: t.reason });
      const a = registry.get(t.adapter);
      if (!a.removeSession) return notImplemented(t.adapter, "removeSession");
      await a.removeSession(t.id, { deleteWorktree, deleteBranch, force });
      registry.invalidate();
      // If we just removed the selected session, dropping the stale pointer
      // avoids confusing every subsequent call with "session not found".
      const sel = await selectionStore.get();
      if (sel && sel.adapter === t.adapter && sel.id === t.id) {
        await selectionStore.clear();
      }
      return asJsonText({ ok: true, adapter: t.adapter, id: t.id });
    },
  );
}
