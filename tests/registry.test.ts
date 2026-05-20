import { describe, expect, test } from "bun:test";
import type { Adapter, OutputSnapshot } from "@/adapters/types.ts";
import type { Session } from "@/core/session.ts";
import { AdapterRegistry } from "@/core/registry.ts";

function makeSession(id: string, title = id): Session {
  return {
    adapter: "stub",
    id,
    title,
    tool: "stub",
    status: "idle",
    workdir: "/",
    branch: null,
    repoRoot: null,
    group: null,
    profile: null,
    createdAt: null,
    lastActivityAt: null,
    idleSinceAt: null,
    nativeSessionId: null,
    raw: null,
  };
}

class CountingAdapter implements Adapter {
  readonly name = "stub";
  calls = 0;

  constructor(private sessions: Session[]) {}

  async listSessions(): Promise<Session[]> {
    this.calls += 1;
    return this.sessions;
  }

  async getSession(id: string): Promise<Session | null> {
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  async getOutput(): Promise<OutputSnapshot> {
    return { content: "", lines: 0 };
  }
}

describe("AdapterRegistry caching", () => {
  test("second call within TTL is served from cache (one adapter call)", async () => {
    const stub = new CountingAdapter([makeSession("a")]);
    const reg = new AdapterRegistry({ ttlMs: 1000 });
    reg.register(stub);

    await reg.listAllSessions();
    await reg.listAllSessions();

    expect(stub.calls).toBe(1);
  });

  test("freshness: 'live' bypasses the cache", async () => {
    const stub = new CountingAdapter([makeSession("a")]);
    const reg = new AdapterRegistry({ ttlMs: 60_000 });
    reg.register(stub);

    await reg.listAllSessions();
    await reg.listAllSessions("live");

    expect(stub.calls).toBe(2);
  });

  test("invalidate() forces the next call to refetch", async () => {
    const stub = new CountingAdapter([makeSession("a")]);
    const reg = new AdapterRegistry({ ttlMs: 60_000 });
    reg.register(stub);

    await reg.listAllSessions();
    reg.invalidate();
    await reg.listAllSessions();

    expect(stub.calls).toBe(2);
  });

  test("expired cache entry triggers refetch", async () => {
    const stub = new CountingAdapter([makeSession("a")]);
    const reg = new AdapterRegistry({ ttlMs: 1 });
    reg.register(stub);

    await reg.listAllSessions();
    await new Promise((r) => setTimeout(r, 5));
    await reg.listAllSessions();

    expect(stub.calls).toBe(2);
  });

  test("concurrent calls share one inflight fetch", async () => {
    let resolveFetch: ((v: Session[]) => void) | null = null;
    const slow: Adapter = {
      name: "stub",
      async listSessions(): Promise<Session[]> {
        return new Promise((res) => {
          resolveFetch = res;
        });
      },
      async getSession(): Promise<Session | null> {
        return null;
      },
      async getOutput(): Promise<OutputSnapshot> {
        return { content: "", lines: 0 };
      },
    };
    let outerCalls = 0;
    const reg = new AdapterRegistry({ ttlMs: 60_000 });
    // wrap so we can count outer adapter invocations
    reg.register({
      ...slow,
      listSessions: async () => {
        outerCalls += 1;
        return slow.listSessions();
      },
    });

    const a = reg.listAllSessions();
    const b = reg.listAllSessions();
    expect(outerCalls).toBe(1);
    resolveFetch!([makeSession("x")]);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
  });
});
