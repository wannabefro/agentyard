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
};
