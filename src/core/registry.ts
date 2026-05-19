import type { Adapter } from "@/adapters/types.ts";
import type { Session } from "@/core/session.ts";

export class AdapterRegistry {
  private readonly adapters = new Map<string, Adapter>();

  register(adapter: Adapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Adapter "${adapter.name}" already registered`);
    }
    this.adapters.set(adapter.name, adapter);
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

  async listAllSessions(): Promise<Session[]> {
    const settled = await Promise.allSettled(
      [...this.adapters.values()].map((a) => a.listSessions()),
    );
    const out: Session[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") out.push(...r.value);
      else console.error(`adapter listSessions failed:`, r.reason);
    }
    return out;
  }
}
