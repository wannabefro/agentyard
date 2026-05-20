export type SessionStatus =
  | "waiting"
  | "running"
  | "idle"
  | "stopped"
  | "error"
  | "unknown";

export type Session = {
  adapter: string;
  id: string;
  title: string;
  tool: string;
  status: SessionStatus;
  workdir: string;
  branch: string | null;
  repoRoot: string | null;
  group: string | null;
  profile: string | null;
  createdAt: Date | null;
  lastActivityAt: Date | null;
  idleSinceAt: Date | null;
  nativeSessionId: string | null;
  // Optional short text snapshot of what the session is working on, sourced
  // from session output rather than metadata. Lets the resolver match queries
  // like "failing go tests" against aoe sessions whose titles are auto-generated
  // codenames detached from content. Adapters populate what they can:
  //   - claude-code: `lastPrompt` from the transcript summary.
  //   - aoe: tail of the captured pane (ANSI stripped, ~500 chars).
  // Truncated for context-hygiene — this is a matching aid, not a viewer.
  summary: string | null;
  raw: unknown;
};

export type AdapterRef = { adapter: string; id: string };
