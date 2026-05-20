import type { Session } from "@/core/session.ts";

export type OutputSnapshot = {
  content: string;
  lines: number;
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

export type Adapter = {
  readonly name: string;

  listSessions(): Promise<Session[]>;
  getSession(id: string): Promise<Session | null>;

  getOutput(id: string, lines?: number): Promise<OutputSnapshot>;
  sendInput(id: string, text: string): Promise<SendResult>;

  waitIdle(id: string, opts: IdleWaitOptions): Promise<{
    settled: boolean;
    lastSnapshot: OutputSnapshot;
  }>;

  createSession(opts: CreateSessionOpts): Promise<{ id: string; title: string }>;
  startSession(id: string): Promise<void>;
  stopSession(id: string): Promise<void>;
  restartSession(id: string): Promise<void>;
  removeSession(id: string, opts: RemoveSessionOpts): Promise<void>;

  sendThenWait?(id: string, text: string, opts: SendThenWaitOptions): Promise<SendThenWaitResult>;
  waitForReady?(id: string, opts: ReadyWaitOptions): Promise<ReadyWaitResult>;
};
