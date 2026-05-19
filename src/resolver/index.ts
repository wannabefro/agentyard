import Fuse from "fuse.js";
import type { Session, SessionStatus } from "@/core/session.ts";

export type Candidate = {
  session: Session;
  score: number;
  reasons: string[];
};

const KNOWN_TOOLS = new Set([
  "claude",
  "codex",
  "opencode",
  "gemini",
  "copilot",
  "mistral",
  "factory",
]);

const KNOWN_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "waiting",
  "running",
  "idle",
  "stopped",
  "error",
]);

function tokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,/_-]+/)
    .filter((t) => t.length > 0);
}

function extractFilters(qTokens: string[]): {
  tools: Set<string>;
  statuses: Set<SessionStatus>;
  rest: string[];
} {
  const tools = new Set<string>();
  const statuses = new Set<SessionStatus>();
  const rest: string[] = [];
  for (const t of qTokens) {
    if (KNOWN_TOOLS.has(t)) {
      tools.add(t);
    } else if (KNOWN_STATUSES.has(t as SessionStatus)) {
      statuses.add(t as SessionStatus);
    } else {
      rest.push(t);
    }
  }
  return { tools, statuses, rest };
}

function exactTitleMatch(query: string, s: Session): number {
  return s.title.toLowerCase() === query.toLowerCase() ? 1 : 0;
}

function substringTitleMatch(restTokens: string[], s: Session): number {
  if (restTokens.length === 0) return 0;
  const title = s.title.toLowerCase();
  const hits = restTokens.filter((t) => title.includes(t)).length;
  return hits / restTokens.length;
}

function substringBranchMatch(restTokens: string[], s: Session): number {
  if (restTokens.length === 0 || !s.branch) return 0;
  const branch = s.branch.toLowerCase();
  const hits = restTokens.filter((t) => branch.includes(t)).length;
  return hits / restTokens.length;
}

function repoMatch(restTokens: string[], s: Session): number {
  if (restTokens.length === 0 || !s.repoRoot) return 0;
  const repo = s.repoRoot.toLowerCase();
  const hits = restTokens.filter((t) => repo.includes(`/${t}`) || repo.endsWith(`/${t}`)).length;
  return hits / restTokens.length;
}

export function resolve(query: string, sessions: Session[]): Candidate[] {
  const qTokens = tokens(query);
  const { tools, statuses, rest } = extractFilters(qTokens);
  const restQuery = rest.join(" ");

  const filtered = sessions.filter((s) => {
    if (tools.size > 0 && !tools.has(s.tool)) return false;
    if (statuses.size > 0 && !statuses.has(s.status)) return false;
    return true;
  });

  const fuseTitle = new Fuse(filtered, {
    keys: ["title"],
    includeScore: true,
    threshold: 0.5,
    ignoreLocation: true,
  });
  const fuseBranch = new Fuse(filtered, {
    keys: ["branch"],
    includeScore: true,
    threshold: 0.5,
    ignoreLocation: true,
  });

  const fuseTitleScores = new Map<string, number>();
  for (const r of fuseTitle.search(restQuery || query)) {
    if (r.score !== undefined) fuseTitleScores.set(r.item.id, 1 - r.score);
  }
  const fuseBranchScores = new Map<string, number>();
  for (const r of fuseBranch.search(restQuery || query)) {
    if (r.score !== undefined) fuseBranchScores.set(r.item.id, 1 - r.score);
  }

  const candidates: Candidate[] = [];
  for (const s of filtered) {
    const reasons: string[] = [];
    let score = 0;

    const exact = exactTitleMatch(restQuery || query, s);
    if (exact > 0) {
      score += 5;
      reasons.push(`exact title match "${s.title}"`);
    }

    const subTitle = substringTitleMatch(rest, s);
    if (subTitle > 0) {
      score += 3 * subTitle;
      reasons.push(`title contains ${Math.round(subTitle * 100)}% of query tokens`);
    }

    const subBranch = substringBranchMatch(rest, s);
    if (subBranch > 0) {
      score += 2 * subBranch;
      reasons.push(`branch contains ${Math.round(subBranch * 100)}% of query tokens`);
    }

    const subRepo = repoMatch(rest, s);
    if (subRepo > 0) {
      score += 2 * subRepo;
      reasons.push(`repo path matches`);
    }

    const fuseT = fuseTitleScores.get(s.id) ?? 0;
    if (fuseT > 0 && exact === 0) {
      score += 1.5 * fuseT;
      reasons.push(`fuzzy title match (${fuseT.toFixed(2)})`);
    }
    const fuseB = fuseBranchScores.get(s.id) ?? 0;
    if (fuseB > 0) {
      score += 1 * fuseB;
      reasons.push(`fuzzy branch match (${fuseB.toFixed(2)})`);
    }

    if (tools.has(s.tool)) reasons.push(`tool filter matched (${s.tool})`);
    if (statuses.has(s.status)) reasons.push(`status filter matched (${s.status})`);

    if (score > 0 || tools.size > 0 || statuses.size > 0) {
      candidates.push({ session: s, score, reasons });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}
