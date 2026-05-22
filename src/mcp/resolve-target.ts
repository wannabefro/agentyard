import type { AdapterRegistry } from "@/core/registry.ts";
import type { SelectionStore } from "@/core/selection.ts";

export type ResolveTargetArgs = {
  adapter?: string | undefined;
  id?: string | undefined;
};

export type ResolveTargetResult =
  | { ok: true; adapter: string; id: string; title?: string }
  | { ok: false; reason: string };

export type ResolveTargetFn = (args: ResolveTargetArgs) => Promise<ResolveTargetResult>;

// Build the resolveTarget closure used by every session-targeting tool.
// Resolves an (adapter, id) tuple from optional args + the persistent
// selection. Explicit args always win and do NOT update the selection.
//
// Centralizes three responsibilities so the per-tool modules don't each
// reinvent them:
//   1. Falling back from missing args to the pinned selection.
//   2. Auto-expiring a stale selection that no longer resolves.
//   3. Surfacing a freshly-fetched title (from the validation getSession
//      call) so chat / send_then_wait responses carry a current label.
export function makeResolveTarget(deps: {
  registry: AdapterRegistry;
  selectionStore: SelectionStore;
}): ResolveTargetFn {
  const { registry, selectionStore } = deps;

  return async function resolveTarget(args) {
    // Explicit args always win and are not validated — callers passing
    // (adapter, id) directly know what they want; downstream "session
    // not found" failures bubble up from the adapter as normal. Title
    // is not resolved on this path; callers that want a routing label
    // should pin via switch_session/select_session first.
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

    // Auto-expiry: validate the selection still resolves to a real
    // session before falling back. Without this, every subsequent
    // fallback call would fail with the same "session not found" error
    // against a stale pointer (the canonical case: user selected a
    // session, it got removed by aoe or its transcript file was deleted,
    // and now the selection is stuck). Validation cost is one
    // getSession per fallback — acceptable for the interactive flow
    // this tool surface is designed for.
    let liveTitle: string | undefined;
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
      // Prefer the freshly-fetched title over the persisted one (the
      // persisted title can go stale if the adapter renames the session
      // out-of-band).
      if (session.title) liveTitle = session.title;
    } catch (e) {
      // Validation itself failed (adapter threw, e.g., the underlying
      // CLI is missing). Prefer to attempt the call rather than
      // incorrectly clearing the selection over a transient error — the
      // downstream tool will produce its own actionable failure.
    }

    return {
      ok: true,
      adapter: args.adapter ?? sel.adapter,
      id: args.id ?? sel.id,
      title: liveTitle ?? sel.title,
    };
  };
}
