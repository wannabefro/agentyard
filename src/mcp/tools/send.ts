// Write-path tools: send_input (fire-and-forget), send_then_wait
// (guaranteed-delivery loop primitive), chat (shorthand against selection).
//
// All three carry the ROUTING_HEADER_DIRECTIVE in their description; all
// three return adapter/id/title on the wire so the host can render the
// route header back to the user.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { sendThenWait } from "@/core/loop.ts";
import type { Deps } from "@/mcp/deps.ts";
import {
  asJsonText,
  hintForChatFailure,
  lastAssistantText,
  lastNonEmptyLine,
  notImplemented,
  ROUTING_HEADER_DIRECTIVE,
  trailingSnippet,
} from "@/mcp/helpers.ts";

export function register(server: McpServer, deps: Deps) {
  const { registry, resolveTarget } = deps;

  server.registerTool(
    "send_input",
    {
      title: "Send input to session",
      // Sends to a running agent — not destructive per se, but the agent
      // can do anything in response. Codex exec auto-cancels; Codex TUI
      // approves interactively.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Fire-and-forget send: transmits text to the underlying tmux pane. " +
        "Returns ok:true if the CLI accepted the send — NOT a guarantee the " +
        "agent received and processed it. Against a session aoe classifies " +
        "as `error` or `stopped`, the send may trigger an auto-revive and " +
        "the keystrokes can race the agent's readiness window, leaving the " +
        "input staged but not submitted. For guaranteed delivery use " +
        "send_then_wait, which polls the pane for evidence the agent saw " +
        "the input." + ROUTING_HEADER_DIRECTIVE,
      inputSchema: {
        adapter: z.string().optional(),
        id: z.string().optional(),
        text: z.string().min(0).describe(
          "Text to send. Empty string sends a bare Enter, useful for confirming " +
          "default selections in TUI prompts (e.g. Claude Code's trust prompt).",
        ),
      },
    },
    async ({ adapter, id, text }) => {
      const t = await resolveTarget({ adapter, id });
      if (!t.ok) return asJsonText({ error: t.reason });
      const a = registry.get(t.adapter);
      if (!a.sendInput) return notImplemented(t.adapter, "sendInput");
      const result = await a.sendInput(t.id, text);
      // Surface routing fields so the host can echo a `→ adapter/id (title):`
      // header back to the user (see tool description). title may be
      // undefined; JSON.stringify drops undefined-valued keys on the wire.
      return asJsonText({
        ...result,
        adapter: t.adapter,
        id: t.id,
        title: t.title,
      });
    },
  );

  server.registerTool(
    "send_then_wait",
    {
      title: "Send input and wait for the agent to settle",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Send a message to a session and block until the agent has processed it: " +
        "(1) snapshot the pane, (2) send the text, (3) wait for the pane to change " +
        "(proves the agent received it), (4) wait for the pane to stop changing for " +
        "`idleWindowMs` (proves the agent is done). Returns before/after snapshots and " +
        "whether each phase succeeded. This is the canonical loop primitive — call it " +
        "in a loop from a host to drive an agent through multi-turn work." +
        ROUTING_HEADER_DIRECTIVE,
      inputSchema: {
        adapter: z.string().optional(),
        id: z.string().optional(),
        text: z.string().min(1),
        changeTimeoutMs: z.number().int().min(500).max(120_000).default(15_000),
        idleTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
        idleWindowMs: z.number().int().min(500).max(60_000).default(5_000),
        pollIntervalMs: z.number().int().min(250).max(10_000).default(1000),
        readyTimeoutMs: z.number().int().min(500).max(120_000).default(30_000),
      },
    },
    async ({ adapter, id, text, changeTimeoutMs, idleTimeoutMs, idleWindowMs, pollIntervalMs, readyTimeoutMs }) => {
      const t = await resolveTarget({ adapter, id });
      if (!t.ok) {
        return asJsonText({
          ok: false,
          error: t.reason,
          hint: hintForChatFailure(t.reason),
        });
      }
      const result = await sendThenWait(
        registry.get(t.adapter),
        t.id,
        text,
        {
          changeTimeoutMs,
          idleTimeoutMs,
          idleWindowMs,
          pollIntervalMs,
          readyTimeoutMs,
        },
        // Pass the registry so the loop's cross-adapter ownership preflight
        // can run — refuses send when another adapter (typically aoe) has a
        // live attach to the same underlying agent session.
        registry,
      );
      // Mirror chat()'s affordances: attach adapter/id and (on failure) a
      // hint so callers don't need to inspect before/after to know what to
      // try next. Full before/after still travel through unchanged for
      // callers that want them. `title` carries the routing label so hosts
      // can echo it back to the user (see tool description). May be
      // undefined; JSON.stringify drops it from the wire.
      const enriched: Record<string, unknown> = {
        ...result,
        adapter: t.adapter,
        id: t.id,
        title: t.title,
      };
      if (!result.ok) {
        const h = hintForChatFailure(result.reason);
        if (h) enriched.hint = h;
      }
      return asJsonText(enriched);
    },
  );

  server.registerTool(
    "chat",
    {
      title: "Chat: send a message to the selected session (shorthand)",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Minimal shorthand for send_then_wait against the current selection. " +
        "Requires that a session is already selected (via select_session or switch_session). " +
        "On success returns {ok, adapter, id, title?, response, elapsedMs, warnings?}. " +
        "On failure returns {ok:false, adapter?, id?, title?, error, lastLine?, hint?, elapsedMs?, warnings?} — " +
        "lastLine is the last non-empty line of the session's pane (so the caller can see " +
        "WHAT is on screen), and hint is a one-line suggestion for the next tool to call. " +
        "For full before/after snapshots and ANSI use send_then_wait." +
        ROUTING_HEADER_DIRECTIVE,
      inputSchema: {
        text: z.string().min(1).describe("Message to send to the selected session"),
        changeTimeoutMs: z.number().int().min(500).max(120_000).default(15_000),
        idleTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
        idleWindowMs: z.number().int().min(500).max(60_000).default(5_000),
        readyTimeoutMs: z.number().int().min(500).max(120_000).default(30_000),
      },
    },
    async ({ text, changeTimeoutMs, idleTimeoutMs, idleWindowMs, readyTimeoutMs }) => {
      const t = await resolveTarget({});
      if (!t.ok) {
        return asJsonText({
          ok: false,
          error: t.reason,
          hint: hintForChatFailure(t.reason),
        });
      }
      const result = await sendThenWait(
        registry.get(t.adapter),
        t.id,
        text,
        { changeTimeoutMs, idleTimeoutMs, idleWindowMs, readyTimeoutMs },
        registry,
      );
      if (!result.ok) {
        // Surface adapter/id (which session we tried), the last visible line
        // on its pane (what state it's actually in), and a hint mapping the
        // failure reason to the next tool the caller should reach for. The
        // last line is the highest-signal single fact: it shows selector
        // menus, half-rendered prompts, "Bash needs approval" gates, etc.
        const lastLine = lastNonEmptyLine(result.after.content);
        return asJsonText({
          ok: false,
          adapter: t.adapter,
          id: t.id,
          title: t.title,
          error: result.reason,
          lastLine: lastLine || undefined,
          hint: hintForChatFailure(result.reason),
          elapsedMs: result.elapsedMs,
          warnings: result.warnings,
        });
      }
      // Extract just the most recent assistant message. Adapters that
      // populate `structured` (claude-code, codex) give us a clean
      // role-tagged message list; for adapters without structured output
      // (aoe pane captures), fall back to the trailing snippet of content.
      const response = lastAssistantText(result.after) ?? trailingSnippet(result.after.content);
      return asJsonText({
        ok: true,
        adapter: t.adapter,
        id: t.id,
        title: t.title,
        response,
        elapsedMs: result.elapsedMs,
        warnings: result.warnings,
      });
    },
  );
}
