import type { Adapter, ListSessionsOptions } from "@/adapters/types.ts";
import type { Session } from "@/core/session.ts";

const DEFAULT_TTL_MS = 5000;

function readEnvTtl(): number {
  const raw = process.env.AGENTYARD_LIST_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

export type ListFreshness = "cached" | "live";

// Slim listings (no summary) and full listings (with summary) cost very
// different things to produce — the aoe adapter fires one extra CLI capture
// per session for the summary. Cache them separately so a slim list_sessions
// call doesn't invalidate the resolver's summary-bearing list, and vice
// versa.
type CacheEntry = { at: number; sessions: Session[] };

export class AdapterRegistry {
  private readonly adapters = new Map<string, Adapter>();
  private readonly ttlMs: number;
  private readonly caches = new Map<boolean, CacheEntry>();
  private readonly inflights = new Map<boolean, Promise<Session[]>>();

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? readEnvTtl();
  }

  register(adapter: Adapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Adapter "${adapter.name}" already registered`);
    }
    this.adapters.set(adapter.name, adapter);
    this.invalidate();
  }

  get(name: string): Adapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Unknown adapter "${name}". Registered: ${this.list().join(", ")}`);
    }
    return adapter;
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }

  invalidate(): void {
    this.caches.clear();
  }

  async listAllSessions(
    freshness: ListFreshness = "cached",
    opts: ListSessionsOptions = {},
  ): Promise<Session[]> {
    const wantSummary = opts.withSummary === true;
    const cached = this.caches.get(wantSummary);
    if (freshness === "cached" && cached && Date.now() - cached.at < this.ttlMs) {
      return cached.sessions;
    }
    const inflight = this.inflights.get(wantSummary);
    if (inflight) return inflight;

    const next = (async () => {
      try {
        const settled = await Promise.allSettled(
          [...this.adapters.values()].map((a) => a.listSessions(opts)),
        );
        const out: Session[] = [];
        for (const r of settled) {
          if (r.status === "fulfilled") out.push(...r.value);
          else console.error(`adapter listSessions failed:`, r.reason);
        }
        this.caches.set(wantSummary, { at: Date.now(), sessions: out });
        return out;
      } finally {
        this.inflights.delete(wantSummary);
      }
    })();
    this.inflights.set(wantSummary, next);
    return next;
  }
}
