// Shared MCP tool helpers and constants.
//
// Pure utilities only: JSON-shape conversion, response builders, content
// extraction, error-hint mapping. No I/O, no adapter access — that lives
// in resolve-target.ts and the per-tool modules.

import type { Session } from "@/core/session.ts";

export function asJsonText(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function notImplemented(adapterName: string, method: string) {
  return asJsonText({
    ok: false,
    reason: `adapter '${adapterName}' does not implement ${method}`,
  });
}

// Pull the most recent assistant message text out of an OutputSnapshot's
// structured field. Used by `chat` to return just the response rather than
// the whole before/after blob. Returns null when there's no structured
// data (e.g. aoe pane captures) — caller should fall back to raw content.
export function lastAssistantText(
  snap: { structured?: { role: string; text: string }[] },
): string | null {
  const items = snap.structured;
  if (!items || items.length === 0) return null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const m = items[i]!;
    if (m.role === "assistant" && m.text) return m.text;
  }
  return null;
}

const CHAT_FALLBACK_SNIPPET_LINES = 30;

export function trailingSnippet(content: string): string {
  const lines = content.split("\n").filter((l) => l.length > 0);
  return lines.slice(-CHAT_FALLBACK_SNIPPET_LINES).join("\n");
}

// Last non-empty line of the captured pane. Useful in error responses so
// the caller can see WHAT the session is showing (e.g. a selector menu,
// a half-rendered prompt, a "Bash command needs approval" gate) instead
// of guessing from the error string alone.
export function lastNonEmptyLine(content: string): string {
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
export function hintForChatFailure(reason: string | undefined): string | undefined {
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

export function slimSession(
  s: Session,
  opts: { withSummary: boolean; withRaw: boolean },
): Partial<Session> {
  const { summary: _summary, raw: _raw, ...rest } = s;
  const out: Partial<Session> = { ...rest };
  if (opts.withSummary) out.summary = s.summary;
  if (opts.withRaw) out.raw = s.raw;
  return out;
}

// Appended to every "send to a session" tool description.
//
// This is a BEHAVIORAL CONTRACT, not a wire-format guarantee — it relies
// on the host LLM honoring the directive in its user-visible prose. The
// adapter/id/title fields are returned on the wire either way; this
// clause only governs how the host renders them.
//
// Verify empirically per host before treating this as load-bearing.
// Known-checked hosts: (none yet — populate as verified). If a host
// ignores the directive, the deterministic fallback is the status-line
// integration that reads ~/.agentyard/state.json directly (see
// docs/integrations/status-line.md). The directive is purely additive —
// removing it does not change tool behavior, only renderer behavior.
export const ROUTING_HEADER_DIRECTIVE =
  " ROUTING HEADER (mandatory): when reporting this tool's result to the user, " +
  "lead your reply with the route header `→ <adapter>/<id> (<title>): ` taken " +
  "verbatim from the `adapter`, `id`, and `title` fields of this response. " +
  "If `title` is absent, render `→ <adapter>/<id>: ` without the parenthetical. " +
  "The header tells the user which session you addressed — do not paraphrase, " +
  "abbreviate, or omit it, including when summarizing across multiple sends.";
