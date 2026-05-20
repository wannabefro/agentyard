import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Adapter, OutputSnapshot } from "@/adapters/types.ts";
import { sendThenWait } from "@/core/loop.ts";
import {
  findCrossAdapterOwners,
  formatOwnershipConflictReason,
  isLiveStatus,
} from "@/core/ownership.ts";
import { AdapterRegistry } from "@/core/registry.ts";
import type { Session } from "@/core/session.ts";
import { readAgentSessionIdMap } from "@/adapters/aoe/index.ts";

function makeSession(opts: Partial<Session> & { adapter: string; id: string }): Session {
  return {
    title: `session ${opts.id}`,
    tool: "claude",
    status: "unknown",
    workdir: "/tmp",
    branch: null,
    repoRoot: null,
    group: null,
    profile: null,
    createdAt: null,
    lastActivityAt: null,
    idleSinceAt: null,
    nativeSessionId: null,
    summary: null,
    raw: null,
    ...opts,
  };
}

function listOnlyAdapter(name: string, sessions: Session[]): Adapter {
  return {
    name,
    listSessions: async () => sessions,
    getSession: async (id) => sessions.find((s) => s.id === id) ?? null,
    getOutput: async (): Promise<OutputSnapshot> => ({ content: "", lines: 0 }),
  };
}

describe("isLiveStatus", () => {
  test("treats running/waiting/idle/error as live", () => {
    expect(isLiveStatus("running")).toBe(true);
    expect(isLiveStatus("waiting")).toBe(true);
    expect(isLiveStatus("idle")).toBe(true);
    expect(isLiveStatus("error")).toBe(true);
  });

  test("treats stopped/unknown as not live", () => {
    expect(isLiveStatus("stopped")).toBe(false);
    expect(isLiveStatus("unknown")).toBe(false);
  });
});

describe("findCrossAdapterOwners", () => {
  test("empty array when nativeSessionId is null", async () => {
    const reg = new AdapterRegistry({ ttlMs: 0 });
    reg.register(listOnlyAdapter("aoe", []));
    const result = await findCrossAdapterOwners(reg, "codex", null);
    expect(result).toEqual([]);
  });

  test("empty array when no other adapter knows the id", async () => {
    const reg = new AdapterRegistry({ ttlMs: 0 });
    reg.register(listOnlyAdapter("aoe", [
      makeSession({ adapter: "aoe", id: "aoe-1", nativeSessionId: "uuid-other", status: "running" }),
    ]));
    const result = await findCrossAdapterOwners(reg, "codex", "uuid-target");
    expect(result).toEqual([]);
  });

  test("returns conflict when another adapter has a live session with matching native id", async () => {
    const reg = new AdapterRegistry({ ttlMs: 0 });
    reg.register(listOnlyAdapter("aoe", [
      makeSession({
        adapter: "aoe",
        id: "aoe-1",
        title: "fender-evals",
        tool: "codex",
        nativeSessionId: "uuid-shared",
        status: "running",
      }),
    ]));
    const result = await findCrossAdapterOwners(reg, "codex", "uuid-shared");
    expect(result).toHaveLength(1);
    expect(result[0]!.adapter).toBe("aoe");
    expect(result[0]!.id).toBe("aoe-1");
    expect(result[0]!.status).toBe("running");
  });

  test("excludes the calling adapter's own sessions", async () => {
    const reg = new AdapterRegistry({ ttlMs: 0 });
    reg.register(listOnlyAdapter("codex", [
      makeSession({
        adapter: "codex",
        id: "codex-1",
        nativeSessionId: "uuid-shared",
        status: "running",
      }),
    ]));
    const result = await findCrossAdapterOwners(reg, "codex", "uuid-shared");
    expect(result).toEqual([]);
  });

  test("excludes stopped sessions", async () => {
    const reg = new AdapterRegistry({ ttlMs: 0 });
    reg.register(listOnlyAdapter("aoe", [
      makeSession({
        adapter: "aoe",
        id: "aoe-stopped",
        nativeSessionId: "uuid-shared",
        status: "stopped",
      }),
    ]));
    const result = await findCrossAdapterOwners(reg, "codex", "uuid-shared");
    expect(result).toEqual([]);
  });

  test("surfaces multiple conflicting adapters", async () => {
    const reg = new AdapterRegistry({ ttlMs: 0 });
    reg.register(listOnlyAdapter("aoe", [
      makeSession({ adapter: "aoe", id: "aoe-1", nativeSessionId: "uuid-shared", status: "running" }),
    ]));
    reg.register(listOnlyAdapter("other", [
      makeSession({ adapter: "other", id: "other-1", nativeSessionId: "uuid-shared", status: "idle" }),
    ]));
    const result = await findCrossAdapterOwners(reg, "codex", "uuid-shared");
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.adapter).sort()).toEqual(["aoe", "other"]);
  });
});

describe("formatOwnershipConflictReason", () => {
  test("names the adapter, the colliding session, and the safe path", () => {
    const reason = formatOwnershipConflictReason("codex", "uuid-shared", [
      { adapter: "aoe", id: "aoe-1", title: "fender-evals", status: "running", tool: "codex" },
    ]);
    expect(reason).toContain("refusing to write via codex");
    expect(reason).toContain("uuid-shared");
    expect(reason).toContain("aoe/aoe-1");
    expect(reason).toContain("fender-evals");
    expect(reason).toContain("send_then_wait with adapter=aoe");
  });
});

describe("sendThenWait preflight ownership refusal", () => {
  // The loop primitive needs a write-capable adapter to make it past the
  // ownership check. We give it one whose sendThenWait would otherwise
  // succeed instantly, so any "ok: false" must come from the preflight.
  function writeCapableAdapter(opts: {
    name: string;
    sessionFn: (id: string) => Session | null;
  }): Adapter {
    return {
      name: opts.name,
      listSessions: async () => [],
      getSession: async (id) => opts.sessionFn(id),
      getOutput: async () => ({ content: "after", lines: 1 }),
      sendThenWait: async () => ({
        ok: true,
        changed: true,
        settled: true,
        before: { content: "", lines: 0 },
        after: { content: "after", lines: 1 },
        elapsedMs: 1,
      }),
    };
  }

  test("refuses when registry shows a live cross-adapter owner", async () => {
    const reg = new AdapterRegistry({ ttlMs: 0 });
    reg.register(listOnlyAdapter("aoe", [
      makeSession({
        adapter: "aoe",
        id: "aoe-1",
        title: "wrapped",
        nativeSessionId: "uuid-shared",
        status: "running",
      }),
    ]));
    const codex = writeCapableAdapter({
      name: "codex",
      sessionFn: (id) =>
        makeSession({ adapter: "codex", id, nativeSessionId: "uuid-shared", status: "unknown" }),
    });
    reg.register(codex);

    const result = await sendThenWait(
      codex,
      "uuid-shared",
      "hello",
      { changeTimeoutMs: 1000, idleTimeoutMs: 1000, idleWindowMs: 100 },
      reg,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("refusing to write via codex");
    expect(result.reason).toContain("aoe/aoe-1");
  });

  test("proceeds when no cross-adapter owner exists", async () => {
    const reg = new AdapterRegistry({ ttlMs: 0 });
    const codex = writeCapableAdapter({
      name: "codex",
      sessionFn: (id) =>
        makeSession({ adapter: "codex", id, nativeSessionId: "uuid-solo", status: "unknown" }),
    });
    reg.register(codex);

    const result = await sendThenWait(
      codex,
      "uuid-solo",
      "hello",
      { changeTimeoutMs: 1000, idleTimeoutMs: 1000, idleWindowMs: 100 },
      reg,
    );
    expect(result.ok).toBe(true);
  });

  test("proceeds when other-adapter session is stopped (not a live conflict)", async () => {
    const reg = new AdapterRegistry({ ttlMs: 0 });
    reg.register(listOnlyAdapter("aoe", [
      makeSession({
        adapter: "aoe",
        id: "aoe-stopped",
        nativeSessionId: "uuid-shared",
        status: "stopped",
      }),
    ]));
    const codex = writeCapableAdapter({
      name: "codex",
      sessionFn: (id) =>
        makeSession({ adapter: "codex", id, nativeSessionId: "uuid-shared", status: "unknown" }),
    });
    reg.register(codex);

    const result = await sendThenWait(
      codex,
      "uuid-shared",
      "hello",
      { changeTimeoutMs: 1000, idleTimeoutMs: 1000, idleWindowMs: 100 },
      reg,
    );
    expect(result.ok).toBe(true);
  });

  test("bypasses the check when registry is not provided (direct adapter use)", async () => {
    // A live aoe attach would have refused via registry-mode. Without
    // registry, the loop can't enforce. This is by design — live dogfood
    // scripts that call sendThenWait directly opt out of the check.
    const codex = writeCapableAdapter({
      name: "codex",
      sessionFn: (id) =>
        makeSession({ adapter: "codex", id, nativeSessionId: "uuid-shared", status: "unknown" }),
    });
    const result = await sendThenWait(codex, "uuid-shared", "hello", {
      changeTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      idleWindowMs: 100,
    });
    expect(result.ok).toBe(true);
  });

  test("bypasses the check when getSession returns null nativeSessionId", async () => {
    const reg = new AdapterRegistry({ ttlMs: 0 });
    reg.register(listOnlyAdapter("aoe", [
      makeSession({
        adapter: "aoe",
        id: "aoe-1",
        nativeSessionId: "uuid-shared",
        status: "running",
      }),
    ]));
    const codex = writeCapableAdapter({
      name: "codex",
      // getSession returns a session but without a nativeSessionId — so we
      // can't correlate, and the preflight has no choice but to let it
      // through. The downstream adapter will surface any real failure.
      sessionFn: (id) => makeSession({ adapter: "codex", id, nativeSessionId: null }),
    });
    reg.register(codex);

    const result = await sendThenWait(
      codex,
      "no-correlation",
      "hello",
      { changeTimeoutMs: 1000, idleTimeoutMs: 1000, idleWindowMs: 100 },
      reg,
    );
    expect(result.ok).toBe(true);
  });
});

describe("readAgentSessionIdMap (aoe sessions.json)", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentyard-aoe-test-"));
    mkdirSync(root, { recursive: true });
    path = join(root, "sessions.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("returns an empty map when the file is missing", async () => {
    const map = await readAgentSessionIdMap("/nonexistent/sessions.json");
    expect(map.size).toBe(0);
  });

  test("returns an empty map when the file is malformed JSON", async () => {
    writeFileSync(path, "not json{{{");
    const map = await readAgentSessionIdMap(path);
    expect(map.size).toBe(0);
  });

  test("returns an empty map when the file is not a top-level array", async () => {
    writeFileSync(path, JSON.stringify({ sessions: [] }));
    const map = await readAgentSessionIdMap(path);
    expect(map.size).toBe(0);
  });

  test("extracts id → agent_session_id pairs", async () => {
    writeFileSync(
      path,
      JSON.stringify([
        { id: "aoe-1", agent_session_id: "uuid-a", tool: "claude" },
        { id: "aoe-2", agent_session_id: "uuid-b", tool: "codex" },
      ]),
    );
    const map = await readAgentSessionIdMap(path);
    expect(map.size).toBe(2);
    expect(map.get("aoe-1")).toBe("uuid-a");
    expect(map.get("aoe-2")).toBe("uuid-b");
  });

  test("skips entries with missing or empty agent_session_id", async () => {
    writeFileSync(
      path,
      JSON.stringify([
        { id: "aoe-1", agent_session_id: "uuid-a" },
        { id: "aoe-2" },
        { id: "aoe-3", agent_session_id: "" },
        { id: "aoe-4", agent_session_id: null },
      ]),
    );
    const map = await readAgentSessionIdMap(path);
    expect(map.size).toBe(1);
    expect(map.get("aoe-1")).toBe("uuid-a");
  });
});
