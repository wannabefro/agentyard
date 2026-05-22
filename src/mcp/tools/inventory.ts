// Read-only inventory and lookup tools: list_sessions, resolve_session,
// get_session, get_output. None of these mutate selection state.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolve } from "@/resolver/index.ts";
import type { Deps } from "@/mcp/deps.ts";
import { asJsonText, slimSession } from "@/mcp/helpers.ts";

export function register(server: McpServer, deps: Deps) {
  const { registry, resolveTarget } = deps;

  server.registerTool(
    "list_sessions",
    {
      title: "List sessions",
      // annotations.readOnlyHint=true is required by Codex 0.132 in `codex exec`
      // mode — any MCP tool without this annotation is silently cancelled with
      // "user cancelled MCP tool call". See docs/integrations/codex-host.md.
      annotations: { readOnlyHint: true },
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

  server.registerTool(
    "resolve_session",
    {
      title: "Resolve session",
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
      description:
        "Fetch full detail for one session, including live status. " +
        "When both adapter and id are omitted, falls back to the current selection (see select_session).",
      inputSchema: {
        adapter: z.string().optional().describe("Adapter name, e.g. 'aoe'"),
        id: z.string().optional().describe("Session id"),
      },
    },
    async ({ adapter, id }) => {
      const t = await resolveTarget({ adapter, id });
      if (!t.ok) return asJsonText({ error: t.reason });
      const session = await registry.get(t.adapter).getSession(t.id);
      if (!session) return asJsonText({ error: "session not found", adapter: t.adapter, id: t.id });
      return asJsonText(session);
    },
  );

  server.registerTool(
    "get_output",
    {
      title: "Get session output",
      annotations: { readOnlyHint: true },
      description:
        "Read the last N lines of a session's output. Always returns flat `content` (string) and `lines` (number). Conversation-shaped adapters (e.g. claude-code) also return `structured`: an array of {role, text, timestamp?, kind?} messages so hosts can render or filter typed messages without re-parsing the flat text. " +
        "adapter/id are optional; when omitted, the current selection is used (see select_session).",
      inputSchema: {
        adapter: z.string().optional(),
        id: z.string().optional(),
        lines: z.number().int().min(1).max(2000).default(200),
      },
    },
    async ({ adapter, id, lines }) => {
      const t = await resolveTarget({ adapter, id });
      if (!t.ok) return asJsonText({ error: t.reason });
      const snap = await registry.get(t.adapter).getOutput(t.id, lines);
      return asJsonText(snap);
    },
  );
}
