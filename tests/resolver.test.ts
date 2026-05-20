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
    summary: null,
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

  test("filter-only query enumerates filter matches; non-matching is excluded", () => {
    // The query is pure filter ("running" is a known status). No content
    // tokens, so the only signal is the filter itself plus any recency
    // bonus. Both running sessions appear; the idle one does not. Scores are
    // non-zero now because status=running grants a recency bonus, but no
    // content matchers contributed (no reason mentions "title", "summary",
    // "branch", "repo", or "fuzzy").
    const running = makeSession({ id: "r1", title: "abc", status: "running" });
    const running2 = makeSession({ id: "r2", title: "xyz", status: "running" });
    const idle = makeSession({ id: "i1", title: "abc", status: "idle" });
    const candidates = resolve("running", [running, running2, idle]);
    const ids = candidates.map((c) => c.session.id).sort();
    expect(ids).toEqual(["r1", "r2"]);
    const contentReasonKeywords = ["title", "summary", "branch", "repo", "fuzzy"];
    for (const c of candidates) {
      const hasContentReason = c.reasons.some((r) =>
        contentReasonKeywords.some((k) => r.includes(k)),
      );
      expect(hasContentReason).toBe(false);
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

  test("summary text outranks a partial title-token match when it covers more of the query", () => {
    // This is the 404-mt regression: aoe session with a codename title that
    // covers none of the query, but whose pane content covers all of it.
    // Without summary matching it would lose to any session whose title
    // happens to contain one token (e.g. 'go').
    const codenamed = makeSession({
      id: "404-mt",
      title: "404-mt",
      branch: "404-mt",
      summary:
        "ran pants test go/i18n_platform/l10n_service:: fixed failing test fakes for translate v2 committed and pushed",
    });
    const partialTitle = makeSession({
      id: "statsig",
      title: "Add Statsig feature flag for Go l10n writer",
      branch: "use_go_write",
    });
    const candidates = resolve("failing go tests", [partialTitle, codenamed]);
    expect(candidates[0]!.session.id).toBe("404-mt");
    expect(candidates[0]!.reasons.some((r) => r.includes("summary"))).toBe(true);
  });

  test("recency: running status outranks idle when both match the same title", () => {
    // Two sessions, identical metadata, different statuses. The running one
    // is what the user almost certainly means.
    const running = makeSession({ id: "r", title: "auth-fix", status: "running" });
    const idle = makeSession({ id: "i", title: "auth-fix", status: "idle" });
    const candidates = resolve("auth-fix", [idle, running]);
    expect(candidates[0]!.session.id).toBe("r");
    expect(candidates[0]!.reasons.some((r) => r.includes("running now"))).toBe(true);
  });

  test("recency: more recent lastActivityAt outranks older when scores are equal", () => {
    const recent = makeSession({
      id: "new",
      title: "thing",
      lastActivityAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
    });
    const stale = makeSession({
      id: "old",
      title: "thing",
      lastActivityAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days
    });
    const candidates = resolve("thing", [stale, recent]);
    expect(candidates[0]!.session.id).toBe("new");
    expect(candidates[0]!.reasons.some((r) => r.includes("active in last hour"))).toBe(
      true,
    );
  });

  test("recency bonus does not promote a zero-match session above a real match", () => {
    // Capped recency bonus (~0.9) is intentionally smaller than a single
    // strong matcher (substring title weight = 3, etc.) so it can break ties
    // but not invent matches.
    const recentNoMatch = makeSession({
      id: "fresh-but-irrelevant",
      title: "completely-unrelated",
      status: "running",
      lastActivityAt: new Date(),
    });
    const oldButMatching = makeSession({
      id: "stale-but-matching",
      title: "fender-evals",
      status: "stopped",
      lastActivityAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    });
    const candidates = resolve("fender", [recentNoMatch, oldButMatching]);
    expect(candidates[0]!.session.id).toBe("stale-but-matching");
  });

  test("summary matching is skipped when the field is null", () => {
    // Sanity: a session with no summary should not appear via the summary
    // matcher; only matchers that consult populated fields contribute.
    const noSummary = makeSession({
      id: "x",
      title: "thing",
      summary: null,
    });
    const candidates = resolve("go tests", [noSummary]);
    for (const c of candidates) {
      expect(c.reasons.find((r) => r.includes("summary"))).toBeUndefined();
    }
  });
});
