import type { AdapterRegistry } from "@/core/registry.ts";
import type { SelectionStore } from "@/core/selection.ts";
import type { ResolveTargetFn } from "@/mcp/resolve-target.ts";

// The single dependency bundle threaded through every tool-registration
// module. Adding a new shared concern (e.g. a sessions catalog cache, a
// metrics sink) means extending this type — not re-plumbing each module.
export type Deps = {
  registry: AdapterRegistry;
  selectionStore: SelectionStore;
  resolveTarget: ResolveTargetFn;
};
