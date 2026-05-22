// Selection state mutation: switch_session (query → top pick → pin) and
// select_session (read / set / clear). These are the canonical surfaces
// for changing which session subsequent tools target.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolve } from "@/resolver/index.ts";
import type { Deps } from "@/mcp/deps.ts";
import { asJsonText } from "@/mcp/helpers.ts";

export function register(server: McpServer, deps: Deps) {
  const { registry, selectionStore } = deps;

  server.registerTool(
    "switch_session",
    {
      title: "Switch to a session by natural-language query",
      // Mutates persistent selection state — not destructive (reversible).
      // Codex exec auto-cancels non-readOnly tools; this is callable from the
      // Codex TUI via interactive approval.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      description:
        "One-call resolve + pin: takes a free-text query, picks the top resolver candidate, " +
        "and sets it as the current selection (persisted via ~/.agentyard/state.json). " +
        "Refuses ambiguous queries — when the top candidate isn't clearly better than the runner-up, " +
        "returns the candidates without pinning so the caller can disambiguate. Pass force=true to " +
        "pick the top anyway, or refine the query (add tool/status filters, more title keywords).",
      inputSchema: {
        query: z.string().min(1).describe("Free-text reference to a session"),
        force: z.boolean().default(false).describe(
          "Pin the top candidate even when the resolver thinks it's ambiguous.",
        ),
      },
    },
    async ({ query, force }) => {
      const sessions = await registry.listAllSessions("cached", { withSummary: true });
      const candidates = resolve(query, sessions).slice(0, 5);
      if (candidates.length === 0) {
        return asJsonText({
          ok: false,
          ambiguous: false,
          error: "no candidates matched the query",
          query,
        });
      }

      const top = candidates[0]!;
      const second = candidates[1];
      // Ambiguity rule: top must be at least 30% higher-scoring than #2.
      // The 1.3x ratio came from the live "recent codex session" probe — that
      // query produced 5 candidates clustered 1.6-1.8, and any of them being
      // auto-picked would have been wrong. A clean win like "fender evals" had
      // the top at ~8 with #2 well below; that ratio is far above 1.3x.
      const isAmbiguous =
        !force && second !== undefined && top.score < 1.3 * second.score;

      const candidateView = candidates.map((c) => ({
        adapter: c.session.adapter,
        id: c.session.id,
        title: c.session.title,
        tool: c.session.tool,
        branch: c.session.branch,
        score: c.score,
        reasons: c.reasons,
      }));

      if (isAmbiguous) {
        return asJsonText({
          ok: false,
          ambiguous: true,
          reason:
            `top candidate score=${top.score.toFixed(2)} is not clearly better than runner-up ${second!.score.toFixed(2)} ` +
            `(threshold: 1.3x). Pass force=true to pick the top anyway, or refine the query.`,
          query,
          candidates: candidateView,
        });
      }

      await selectionStore.set({
        adapter: top.session.adapter,
        id: top.session.id,
        title: top.session.title,
      });
      return asJsonText({
        ok: true,
        selected: { adapter: top.session.adapter, id: top.session.id },
        title: top.session.title,
        workdir: top.session.workdir,
        score: top.score,
        reasons: top.reasons,
        forced: force && second !== undefined && top.score < 1.3 * second.score,
        alternatives: candidateView.slice(1),
      });
    },
  );

  server.registerTool(
    "select_session",
    {
      title: "Select (or read/clear) current session",
      // Dual-purpose: read-only when no args, mutating when adapter/id or
      // clear is set. Annotated as non-readOnly because the mutating shape is
      // the more useful surface — read-only callers can use list_sessions or
      // pass no args and inspect the response (which works fine but is
      // gated by the same approval as the write path under Codex exec).
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      description:
        "Pin a session as the current selection for subsequent tool calls. " +
        "Tools that target a session (get_session, get_output, send_input, " +
        "send_then_wait, wait_idle, wait_for_ready, start/stop/restart/remove_session) " +
        "fall back to this selection when adapter/id are omitted. The selection " +
        "persists across MCP reconnects via ~/.agentyard/state.json. " +
        "Pass {adapter, id} to set; pass {clear: true} to drop the selection; " +
        "pass no args to read the current selection.",
      inputSchema: {
        adapter: z.string().optional().describe(
          "Adapter to select. Required when setting; ignored when reading or clearing.",
        ),
        id: z.string().optional().describe(
          "Session id to select. Required when setting; ignored when reading or clearing.",
        ),
        clear: z.boolean().default(false).describe(
          "If true, drop the current selection. Mutually exclusive with adapter/id.",
        ),
      },
    },
    async ({ adapter, id, clear }) => {
      if (clear) {
        await selectionStore.clear();
        return asJsonText({ selected: null, action: "cleared" });
      }
      if (adapter && id) {
        // Verify the (adapter, id) actually exists before pinning — pinning an
        // invalid pair would just make every subsequent call fail.
        let adapterImpl;
        try {
          adapterImpl = registry.get(adapter);
        } catch (e) {
          return asJsonText({
            error: `unknown adapter '${adapter}'`,
            registered: registry.list(),
          });
        }
        const session = await adapterImpl.getSession(id);
        if (!session) {
          return asJsonText({
            error: `session not found`,
            adapter,
            id,
            hint: "use resolve_session or list_sessions to find a valid id",
          });
        }
        await selectionStore.set({ adapter, id, title: session.title });
        return asJsonText({
          selected: { adapter, id },
          action: "set",
          title: session.title,
          workdir: session.workdir,
        });
      }
      if (adapter || id) {
        return asJsonText({
          error: "to set a selection, provide both adapter and id (or neither to read)",
        });
      }
      const current = await selectionStore.get();
      return asJsonText({ selected: current });
    },
  );
}
