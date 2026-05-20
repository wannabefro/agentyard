import { describe, expect, test } from "bun:test";
import { resolve } from "@/resolver/index.ts";
import type { Session, SessionStatus } from "@/core/session.ts";

function makeSession(overrides: Partial<Session> & { id: string; title: string }): Session {
  return {
    adapter: "mock",
    tool: "claude",
    status: "idle" as SessionStatus,
    workdir: "/tmp/work",
    branch: null,
    repoRoot: null,
    group: null,
    profile: null,
    createdAt: null,
    lastActivityAt: null,
    idleSinceAt: null,
    nativeSessionId: null,
    raw: null,
    ...overrides,
  };
}

describe("resolve", () => {
  test("empty sessions returns empty candidates", () => {
    expect(resolve("anything at all", [])).toEqual([]);
  });

  test("exact title match outranks substring match", () => {
    const foo = makeSession({ id: "1", title: "foo" });
    const foobar = makeSession({ id: "2", title: "foobar" });
    const candidates = resolve("foo", [foobar, foo]);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0]!.session.id).toBe("1");
    expect(candidates[0]!.reasons.some((r) => r.includes("exact title"))).toBe(true);
  });

  test("tool filter excludes sessions with non-matching tool", () => {
    const codexSess = makeSession({ id: "a", title: "alpha", tool: "codex" });
    const claudeSess = makeSession({ id: "b", title: "alpha-claude", tool: "claude" });
    const candidates = resolve("codex alpha", [codexSess, claudeSess]);
    const ids = candidates.map((c) => c.session.id);
    expect(ids).toContain("a");
    expect(ids).not.toContain("b");
  });

  test("status filter excludes non-matching statuses; idle survives only without status filter", () => {
    const errored = makeSession({ id: "x", title: "thing", status: "error" });
    const idle = makeSession({ id: "y", title: "thing", status: "idle" });
    const withFilter = resolve("error thing", [errored, idle]);
    expect(withFilter.map((c) => c.session.id)).toEqual(["x"]);

    const noStatusQuery = resolve("thing", [errored, idle]);
    const idsNoFilter = noStatusQuery.map((c) => c.session.id);
    expect(idsNoFilter).toContain("x");
    expect(idsNoFilter).toContain("y");
  });

  test("combined tool + content ranks codex+fender above pure codex", () => {
    const codexFender = makeSession({
      id: "cf",
      title: "fender-evals",
      tool: "codex",
    });
    const codexOther = makeSession({
      id: "co",
      title: "auth-bugfix",
      tool: "codex",
    });
    const candidates = resolve("the codex fender evals one", [codexOther, codexFender]);
    expect(candidates[0]!.session.id).toBe("cf");
  });

  test("filter-only query returns sessions with score 0 but excludes non-matching", () => {
    const running = makeSession({ id: "r1", title: "abc", status: "running" });
    const running2 = makeSession({ id: "r2", title: "xyz", status: "running" });
    const idle = makeSession({ id: "i1", title: "abc", status: "idle" });
    const candidates = resolve("running", [running, running2, idle]);
    const ids = candidates.map((c) => c.session.id).sort();
    expect(ids).toEqual(["r1", "r2"]);
    for (const c of candidates) {
      expect(c.score).toBe(0);
    }
  });

  test("ranking is deterministic across repeated calls", () => {
    const sessions = [
      makeSession({ id: "1", title: "fender-evals", tool: "claude" }),
      makeSession({ id: "2", title: "fender-other", tool: "claude" }),
      makeSession({ id: "3", title: "evals-skill", tool: "codex" }),
      makeSession({ id: "4", title: "auth-fix", branch: "feat/fender" }),
    ];
    const first = resolve("fender evals", sessions);
    const second = resolve("fender evals", sessions);
    expect(second.map((c) => c.session.id)).toEqual(first.map((c) => c.session.id));
    expect(second.map((c) => c.score)).toEqual(first.map((c) => c.score));
  });

  test("repo path token matches /<token> segment", () => {
    // Use 'fender' as the discriminating token — distinct repo basenames so the
    // tokenizer's split on '/' and '-' doesn't accidentally cross-match.
    const fenderRepo = makeSession({
      id: "k",
      title: "thing-a",
      repoRoot: "/Users/x/Code/fender",
    });
    const appRepo = makeSession({
      id: "app",
      title: "thing-b",
      repoRoot: "/Users/x/Code/app",
    });
    const candidates = resolve("fender", [fenderRepo, appRepo]);
    const ids = candidates.map((c) => c.session.id);
    expect(ids).toContain("k");
    expect(ids).not.toContain("app");
    expect(candidates[0]!.reasons.some((r) => r.includes("repo path"))).toBe(true);
  });

  test("branch substring contributes to score", () => {
    const withBranch = makeSession({
      id: "wb",
      title: "noname",
      branch: "feature/auth-bugfix",
    });
    const other = makeSession({ id: "o", title: "noname", branch: null });
    const candidates = resolve("auth bugfix", [other, withBranch]);
    expect(candidates[0]!.session.id).toBe("wb");
    expect(candidates[0]!.reasons.some((r) => r.includes("branch"))).toBe(true);
  });
});
