import type { Adapter, OutputSnapshot } from "@/adapters/types.ts";
import type { Session } from "@/core/session.ts";

// Deterministic adapter used only by the MCP smoke test on machines that have
// no aoe CLI or local Claude Code transcripts. Activated by setting
// AGENTYARD_MOCK=1 before launching the server. Production users never see it.
const SESSIONS: Session[] = [
  {
    adapter: "mock",
    id: "mock-fender-evals",
    title: "fender-evals",
    tool: "mock",
    status: "idle",
    workdir: "/tmp/mock/fender",
    branch: "main",
    repoRoot: "/tmp/mock/fender",
    group: "evals",
    profile: null,
    createdAt: new Date("2026-05-20T00:00:00Z"),
    lastActivityAt: new Date("2026-05-20T00:00:00Z"),
    idleSinceAt: new Date("2026-05-20T00:00:00Z"),
    nativeSessionId: null,
    summary: null,
    raw: { kind: "mock" },
  },
  {
    adapter: "mock",
    id: "mock-auth-fix",
    title: "auth-bug-fix",
    tool: "mock",
    status: "running",
    workdir: "/tmp/mock/auth",
    branch: "fix/auth",
    repoRoot: "/tmp/mock/auth",
    group: null,
    profile: null,
    createdAt: new Date("2026-05-20T00:00:00Z"),
    lastActivityAt: new Date("2026-05-20T00:00:00Z"),
    idleSinceAt: null,
    nativeSessionId: null,
    summary: null,
    raw: { kind: "mock" },
  },
];

export class MockAdapter implements Adapter {
  readonly name = "mock";

  async listSessions(): Promise<Session[]> {
    return SESSIONS;
  }

  async getSession(id: string): Promise<Session | null> {
    return SESSIONS.find((s) => s.id === id) ?? null;
  }

  async getOutput(id: string, lines?: number): Promise<OutputSnapshot> {
    const session = SESSIONS.find((s) => s.id === id);
    if (!session) {
      return { content: "", lines: 0 };
    }
    const all = [
      `mock pane for ${session.title}`,
      `status: ${session.status}`,
      `branch: ${session.branch ?? "(none)"}`,
    ];
    const out = lines === undefined ? all : all.slice(-lines);
    return { content: out.join("\n"), lines: out.length };
  }
}
