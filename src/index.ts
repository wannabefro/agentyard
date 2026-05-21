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
import { SelectionStore } from "@/core/selection.ts";
import { resolve } from "@/resolver/index.ts";
import pkg from "../package.json" with { type: "json" };

const registry = new AdapterRegistry();
registry.register(new AoeAdapter());
registry.register(new ClaudeCodeAdapter());
registry.register(new CodexAdapter());
if (process.env.AGENTYARD_MOCK === "1") {
  registry.register(new MockAdapter());
}

// Persistent "current session" pointer. Tools that act on a session
// (get_output, send_then_wait, lifecycle ops) accept optional adapter/id
// and fall back to this selection. See src/core/selection.ts.
const selectionStore = new SelectionStore(
  process.env.AGENTYARD_STATE_PATH || undefined,
);

// Resolve a session target from optional args + the persistent selection.
// Returns either {adapter, id} or a structured error. Tools should call
// this and short-circuit with notImplemented-style asJsonText when it
// errors. Explicit args always win and do NOT update the selection.
async function resolveTarget(args: {
  adapter?: string | undefined;
  id?: string | undefined;
}): Promise<{ ok: true; adapter: string; id: string } | { ok: false; reason: string }> {
  // Explicit args always win and are not validated — callers passing
  // (adapter, id) directly know what they want; downstream "session not
  // found" failures bubble up from the adapter as normal.
  if (args.adapter && args.id) {
    return { ok: true, adapter: args.adapter, id: args.id };
  }
  const sel = await selectionStore.get();
  if (!sel) {
    return {
      ok: false,
      reason:
        "no session selected and (adapter, id) not provided. Call select_session first, " +
        "or pass both adapter and id explicitly.",
    };
  }

  // Auto-expiry: validate the selection still resolves to a real session
  // before falling back. Without this, every subsequent fallback call would
  // fail with the same "session not found" error against a stale pointer
  // (the canonical case: user selected a session, it got removed by aoe or
  // its transcript file was deleted, and now the selection is stuck).
  // Validation cost is one getSession per fallback — acceptable for the
  // interactive flow this tool surface is designed for.
  try {
    const adapterImpl = registry.get(sel.adapter);
    const session = await adapterImpl.getSession(sel.id);
    if (!session) {
      await selectionStore.clear();
      return {
        ok: false,
        reason:
          `selected session ${sel.adapter}/${sel.id} no longer exists — selection cleared. ` +
          `Use switch_session or select_session to pick a new one.`,
      };
    }
  } catch (e) {
    // Validation itself failed (adapter threw, e.g., the underlying CLI
    // is missing). Prefer to attempt the call rather than incorrectly
    // clearing the selection over a transient error — the downstream
    // tool will produce its own actionable failure.
  }

  return {
    ok: true,
    adapter: args.adapter ?? sel.adapter,
    id: args.id ?? sel.id,
  };
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

// Pull the most recent assistant message text out of an OutputSnapshot's
// structured field. Used by `chat` to return just the response rather than
// the whole before/after blob. Returns null when there's no structured
// data (e.g. aoe pane captures) — caller should fall back to raw content.
function lastAssistantText(snap: { structured?: { role: string; text: string }[] }): string | null {
  const items = snap.structured;
  if (!items || items.length === 0) return null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const m = items[i]!;
    if (m.role === "assistant" && m.text) return m.text;
  }
  return null;
}

const CHAT_FALLBACK_SNIPPET_LINES = 30;

function trailingSnippet(content: string): string {
  const lines = content.split("\n").filter((l) => l.length > 0);
  return lines.slice(-CHAT_FALLBACK_SNIPPET_LINES).join("\n");
}

// Last non-empty line of the captured pane. Useful in error responses so
// the caller can see WHAT the session is showing (e.g. a selector menu,
// a half-rendered prompt, a "Bash command needs approval" gate) instead
// of guessing from the error string alone.
function lastNonEmptyLine(content: string): string {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i]!.trimEnd();
    if (l.trim().length > 0) return l;
  }
  return "";
}

// Map known send_then_wait failure reasons to a one-line, actionable
// next-step suggestion. Keeps the LLM caller from giving up when the
// failure is recoverable (busy session → wait_idle; wrong session →
// list_sessions). Returns undefined when the reason doesn't match a
// known pattern — callers should omit the field rather than emit a
// generic platitude.
function hintForChatFailure(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const r = reason.toLowerCase();
  if (r.includes("no session selected")) {
    return "call switch_session or select_session to pin a target first";
  }
  if (r.includes("agent not ready") || r.includes("prompt cursor")) {
    return "session's terminal isn't at a prompt — call get_output to see current state, wait_idle if the agent is still working, or list_sessions to pick a different target";
  }
  if (r.includes("did not appear in pane") || r.includes("no pane change")) {
    return "agent didn't process the input — call get_output to inspect, or restart_session if it's stuck";
  }
  if (r.includes("did not settle")) {
    return "agent is still working — call wait_idle to keep polling, or get_output to see partial progress";
  }
  if (r.includes("send failed")) {
    return "the underlying CLI rejected the send — call get_session to check status";
  }
  if (r.includes("another adapter") || r.includes("ownership")) {
    return "another adapter has this session live — drive the session through that adapter, or stop the conflicting attach first";
  }
  if (r.includes("does not support sendthenwait") || r.includes("read-only")) {
    return "this session's adapter is read-only — pick a session whose adapter implements send (aoe, claude-code, codex)";
  }
  if (r.includes("session not found") || r.includes("no longer exists")) {
    return "session was removed — call list_sessions and pick a new one";
  }
  return undefined;
}

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

    await selectionStore.set({ adapter: top.session.adapter, id: top.session.id });
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
      await selectionStore.set({ adapter, id });
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
      "the input.",
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
    return asJsonText(result);
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
      "in a loop from a host to drive an agent through multi-turn work.",
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
    // callers that want them.
    const enriched: Record<string, unknown> = {
      ...result,
      adapter: t.adapter,
      id: t.id,
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
      "On success returns {ok, adapter, id, response, elapsedMs, warnings?}. " +
      "On failure returns {ok:false, adapter?, id?, error, lastLine?, hint?, elapsedMs?, warnings?} — " +
      "lastLine is the last non-empty line of the session's pane (so the caller can see " +
      "WHAT is on screen), and hint is a one-line suggestion for the next tool to call. " +
      "For full before/after snapshots and ANSI use send_then_wait.",
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
      response,
      elapsedMs: result.elapsedMs,
      warnings: result.warnings,
    });
  },
);

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
    await selectionStore.set({ adapter, id: result.id });
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`agentyard MCP server up; adapters: ${registry.list().join(", ")}`);

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});
