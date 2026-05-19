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
  raw: unknown;
};

export type AdapterRef = { adapter: string; id: string };
