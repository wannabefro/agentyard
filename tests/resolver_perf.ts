#!/usr/bin/env bun
// Profile: how does the resolver scale with catalog size?
// The resolver constructs 3 Fuse indexes (title, branch, summary) per call
// and iterates every session for substring + repo + filter matches. The
// summary-substring path is the heaviest because summaries can be ~1500
// chars on aoe sessions. This script feeds synthetic catalogs of varying
// sizes through resolve() and times representative queries.
//
// Run: bun run tests/resolver_perf.ts

import { resolve } from "@/resolver/index.ts";
import type { Session } from "@/core/session.ts";

const TITLE_WORDS = [
  "auth", "login", "logout", "evals", "fender", "k-repo", "fix", "refactor",
  "cleanup", "perf", "memory", "leak", "i18n", "l10n", "schema", "migration",
  "sentry", "errors", "logging", "tracing", "observability", "metrics",
  "guardrails", "links", "company", "404", "redirect", "search", "filter",
];
const BRANCHES = [
  "main", "master", "develop", "feature/x", "fix/y", "release/z",
];
const TOOLS = ["claude", "codex", "opencode"] as const;
const STATUSES = ["idle", "running", "stopped", "error", "waiting", "unknown"] as const;

function rand<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function makeTitle(seed: number): string {
  const a = TITLE_WORDS[seed % TITLE_WORDS.length]!;
  const b = TITLE_WORDS[(seed * 7) % TITLE_WORDS.length]!;
  return `${a}-${b}`;
}

function makeSummary(seed: number, lengthChars: number): string {
  const words: string[] = [];
  let total = 0;
  while (total < lengthChars) {
    const w = TITLE_WORDS[(seed + total) % TITLE_WORDS.length]!;
    words.push(w);
    total += w.length + 1;
  }
  return words.join(" ");
}

function makeCatalog(n: number, opts: { summaryLength: number }): Session[] {
  const out: Session[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      adapter: i % 2 === 0 ? "aoe" : "claude-code",
      id: `sess-${i.toString(36)}`,
      title: makeTitle(i),
      tool: rand(TOOLS),
      status: rand(STATUSES),
      workdir: `/tmp/work/${makeTitle(i)}`,
      branch: rand(BRANCHES),
      repoRoot: i % 3 === 0 ? "/repos/k-repo" : "/repos/fender",
      group: null,
      profile: "default",
      createdAt: new Date(Date.now() - i * 60_000),
      lastActivityAt: new Date(Date.now() - i * 30_000),
      idleSinceAt: null,
      nativeSessionId: null,
      summary: makeSummary(i, opts.summaryLength),
      raw: null,
    });
  }
  return out;
}

const QUERIES = [
  "auth login",            // multi-token, generic
  "fender evals",          // canonical natural-language ref
  "fix memory leak",       // matches summaries strongly
  "claude running",        // filter-only (tool + status)
  "k-repo",                // single token, likely many matches
  "nonexistent-codename",  // misses everything
];

function format(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

function measure(label: string, sessions: Session[]): void {
  console.log(`\n=== ${label} (n=${sessions.length}) ===`);
  // Warm: ensures JIT settles. Discard first call's timing.
  resolve(QUERIES[0]!, sessions);

  const timings: { query: string; ms: number; topScore: number }[] = [];
  for (const q of QUERIES) {
    const runs: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      const r = resolve(q, sessions);
      runs.push(performance.now() - t0);
      if (i === 4) {
        timings.push({ query: q, ms: median(runs), topScore: r[0]?.score ?? 0 });
      }
    }
  }
  for (const t of timings) {
    console.log(`  resolve("${t.query}"): ${format(t.ms).padStart(10)}  topScore=${t.topScore.toFixed(2)}`);
  }
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

// Three catalog shapes:
//   small  — current real catalog (~150 sessions, ~500-char summaries)
//   medium — projected 6mo growth
//   large  — 1000 sessions, full 1500-char summaries (aoe SUMMARY_MAX_CHARS)
measure("small (real catalog shape)", makeCatalog(150, { summaryLength: 500 }));
measure("medium (500 sessions)", makeCatalog(500, { summaryLength: 1000 }));
measure("large (1000 sessions, max summaries)", makeCatalog(1000, { summaryLength: 1500 }));
