import type { AdapterRegistry } from "@/core/registry.ts";
import type { Session, SessionStatus } from "@/core/session.ts";

// Cross-adapter session ownership detection.
//
// When multiple adapters surface the same underlying agent session (the
// canonical case: an aoe-wrapped Claude Code or codex session AND its
// standalone claude-code / codex adapter view), simultaneous writes to the
// same on-disk transcript or running TUI race against each other.
//
// Concrete failure modes the check guards against:
//   1. aoe drives `codex` in a tmux pane; standalone codex adapter spawns
//      `codex exec resume <id>` — two codex processes append to the same
//      ~/.codex/sessions/.../rollout-*.jsonl with undefined semantics.
//   2. Same shape for claude-code: aoe-wrapped `claude` TUI + a
//      `claude --resume --print` subprocess both writing to the same
//      ~/.claude/projects/<slug>/<uuid>.jsonl, where the latter file also
//      carries overwrite-throughout state records (ai-title, last-prompt).
//
// The join key is `Session.nativeSessionId` — the underlying agent's UUID:
//   - claude-code adapter / codex adapter: native id IS the session id (UUID)
//   - aoe adapter: populated from agent_session_id in sessions.json (see
//     src/adapters/aoe/index.ts:readAgentSessionIdMap)
// Adapters that don't have a native correlate (or sessions without one set)
// can't be cross-checked and are skipped.

export type OwnershipConflict = {
  adapter: string;
  id: string;
  title: string;
  status: SessionStatus;
  tool: string;
};

// Status values that mean "another adapter is actively attached or could
// observe writes". Stopped sessions have no live writer; unknown is the
// default for transcript-only adapters (they're the *passive* surface and
// don't write to the underlying file outside of explicit sendThenWait).
//
// Idle counts as a conflict: in aoe semantics, idle means the agent is at
// the prompt cursor waiting for input — the TUI pane is live and a
// concurrent subprocess write would race the user's next keystroke.
const LIVE_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "running",
  "waiting",
  "idle",
  "error",
]);

export function isLiveStatus(status: SessionStatus): boolean {
  return LIVE_STATUSES.has(status);
}

// Find every other-adapter surface onto the same underlying agent session
// that is currently in a live (writer-attached) status. Returns an empty
// array when no native id is known (defensive — we can't correlate without
// the join key) or when no other adapter sees this session.
export async function findCrossAdapterOwners(
  registry: AdapterRegistry,
  callingAdapter: string,
  nativeSessionId: string | null,
): Promise<OwnershipConflict[]> {
  if (!nativeSessionId) return [];
  const all = await registry.listAllSessions("cached");
  const out: OwnershipConflict[] = [];
  for (const s of all) {
    if (s.adapter === callingAdapter) continue;
    if (s.nativeSessionId !== nativeSessionId) continue;
    if (!isLiveStatus(s.status)) continue;
    out.push({
      adapter: s.adapter,
      id: s.id,
      title: s.title,
      status: s.status,
      tool: s.tool,
    });
  }
  return out;
}

// Format a list of conflicts into a one-line, human-friendly reason string
// suitable for SendThenWaitResult.reason. Lists the colliding (adapter, id)
// pairs and explains the safe path.
export function formatOwnershipConflictReason(
  callingAdapter: string,
  nativeSessionId: string,
  conflicts: OwnershipConflict[],
): string {
  const list = conflicts
    .map((c) => `${c.adapter}/${c.id} ("${c.title}", status=${c.status})`)
    .join(", ");
  return (
    `refusing to write via ${callingAdapter}: another adapter is also attached to ` +
    `agent session ${nativeSessionId} — ${list}. ` +
    `Concurrent writes to the same transcript are unsafe. ` +
    `Either drive the session through ${conflicts[0]?.adapter ?? "the other adapter"} ` +
    `(send_then_wait with adapter=${conflicts[0]?.adapter ?? "other"} id=${conflicts[0]?.id ?? "other-id"}), ` +
    `or stop that surface first (stop_session) and retry.`
  );
}
