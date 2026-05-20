import type { Adapter } from "@/adapters/types.ts";
import type { Session } from "@/core/session.ts";

const DEFAULT_TTL_MS = 5000;

function readEnvTtl(): number {
  const raw = process.env.AGENTYARD_LIST_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

export type ListFreshness = "cached" | "live";

export class AdapterRegistry {
  private readonly adapters = new Map<string, Adapter>();
  private readonly ttlMs: number;
  private cache: { at: number; sessions: Session[] } | null = null;
  private inflight: Promise<Session[]> | null = null;

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
    this.cache = null;
  }

  async listAllSessions(freshness: ListFreshness = "cached"): Promise<Session[]> {
    if (freshness === "cached" && this.cache && Date.now() - this.cache.at < this.ttlMs) {
      return this.cache.sessions;
    }
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      const settled = await Promise.allSettled(
        [...this.adapters.values()].map((a) => a.listSessions()),
      );
      const out: Session[] = [];
      for (const r of settled) {
        if (r.status === "fulfilled") out.push(...r.value);
        else console.error(`adapter listSessions failed:`, r.reason);
      }
      this.cache = { at: Date.now(), sessions: out };
      this.inflight = null;
      return out;
    })();
    return this.inflight;
  }
}
