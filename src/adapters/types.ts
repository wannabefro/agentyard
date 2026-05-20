import type { Session } from "@/core/session.ts";

// Optional structured output for adapters whose underlying source is
// conversation-shaped (transcripts, message logs) rather than raw terminal
// text. `content` remains the canonical flat-text rendering — every adapter
// populates it. Adapters that wrap unstructured panes (e.g. tmux via aoe)
// leave `structured` undefined.
export type SessionMessage = {
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  timestamp?: string;
  // Adapter-specific subtype, e.g. "tool_use", "tool_result", "thinking".
  // Hosts may use this to filter or render differently but should not depend
  // on a fixed enum — values vary by adapter.
  kind?: string;
};

export type OutputSnapshot = {
  content: string;
  lines: number;
  structured?: SessionMessage[];
};

export type SendResult = {
  ok: true;
} | {
  ok: false;
  reason: string;
};

export type IdleWaitOptions = {
  timeoutMs: number;
  idleWindowMs: number;
  pollIntervalMs?: number;
};

export type ReadyWaitOptions = {
  timeoutMs: number;
  pollIntervalMs?: number;
};

export type ReadyWaitResult = {
  ready: boolean;
  reason?: string;
  lastLine: string;
};

export type SendThenWaitOptions = {
  changeTimeoutMs: number;
  idleTimeoutMs: number;
  idleWindowMs: number;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
};

export type SendThenWaitResult = {
  ok: boolean;
  changed: boolean;
  settled: boolean;
  before: OutputSnapshot;
  after: OutputSnapshot;
  elapsedMs: number;
  reason?: string;
  // Non-fatal advisories the host should surface to the user — e.g. the
  // session's recorded workdir was missing so the spawn fell back to a
  // different cwd, or a normalisation step had to skip a malformed record.
  // Empty / undefined when there's nothing to say. Distinct from `reason`
  // (which is for failure explanations) so a successful call can still
  // carry warnings.
  warnings?: string[];
};

export type CreateSessionOpts = {
  path: string;
  title?: string;
  cmd?: string;
};

export type RemoveSessionOpts = {
  deleteWorktree?: boolean;
  deleteBranch?: boolean;
  force?: boolean;
};

// Options for listSessions. `withSummary` controls whether the per-session
// content summary is populated. The aoe adapter's summary requires a CLI
// capture per session — for a 149-session catalog that is ~149 extra
// subprocess invocations on every call, so it is opt-in. Default = false.
export type ListSessionsOptions = {
  withSummary?: boolean;
};

export type Adapter = {
  readonly name: string;

  listSessions(opts?: ListSessionsOptions): Promise<Session[]>;
  getSession(id: string): Promise<Session | null>;

  getOutput(id: string, lines?: number): Promise<OutputSnapshot>;

  // Write + loop primitives: optional. Read-only adapters (e.g. transcript readers)
  // omit these. Hosts must check before calling; MCP tool routes return a
  // descriptive not-implemented response when missing.
  sendInput?(id: string, text: string): Promise<SendResult>;

  waitIdle?(id: string, opts: IdleWaitOptions): Promise<{
    settled: boolean;
    lastSnapshot: OutputSnapshot;
  }>;

  // Lifecycle: optional. Adapters that wrap a read-only or non-lifecycle-aware
  // source (e.g. a remote transcript reader) may omit any subset of these.
  createSession?(opts: CreateSessionOpts): Promise<{ id: string; title: string }>;
  startSession?(id: string): Promise<void>;
  stopSession?(id: string): Promise<void>;
  restartSession?(id: string): Promise<void>;
  removeSession?(id: string, opts: RemoveSessionOpts): Promise<void>;

  sendThenWait?(id: string, text: string, opts: SendThenWaitOptions): Promise<SendThenWaitResult>;
  waitForReady?(id: string, opts: ReadyWaitOptions): Promise<ReadyWaitResult>;
};
