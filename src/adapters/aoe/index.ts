import type { Adapter, IdleWaitOptions, OutputSnapshot, SendResult } from "@/adapters/types.ts";
import type { Session, SessionStatus } from "@/core/session.ts";
import { runJson, runVoid } from "@/adapters/aoe/cli.ts";
import {
  aoeCaptureSchema,
  aoeListSchema,
  aoeSessionShowSchema,
  type AoeListEntry,
  type AoeSessionShow,
} from "@/adapters/aoe/schemas.ts";

const ADAPTER_NAME = "aoe";

function parseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function entryToSession(
  entry: AoeListEntry,
  status: SessionStatus = "unknown",
): Session {
  return {
    adapter: ADAPTER_NAME,
    id: entry.id,
    title: entry.title,
    tool: entry.tool,
    status,
    workdir: entry.path,
    branch: entry.worktree?.branch ?? null,
    repoRoot: entry.worktree?.main_repo_path ?? null,
    group: entry.group || null,
    profile: entry.profile,
    createdAt: parseDate(entry.created_at),
    lastActivityAt: null,
    idleSinceAt: null,
    nativeSessionId: null,
    raw: entry,
  };
}

function showToSession(show: AoeSessionShow, base: Session | null): Session {
  return {
    adapter: ADAPTER_NAME,
    id: show.id,
    title: show.title,
    tool: show.tool,
    status: show.status,
    workdir: show.path,
    branch: base?.branch ?? null,
    repoRoot: base?.repoRoot ?? null,
    group: show.group || null,
    profile: show.profile,
    createdAt: base?.createdAt ?? null,
    lastActivityAt: null,
    idleSinceAt: null,
    nativeSessionId: null,
    raw: { show, list: base?.raw ?? null },
  };
}

export class AoeAdapter implements Adapter {
  readonly name = ADAPTER_NAME;

  async listSessions(): Promise<Session[]> {
    const entries = await runJson(aoeListSchema, ["list", "--json"]);
    const enriched = await Promise.all(
      entries.map(async (e) => {
        const show = await runJson(aoeSessionShowSchema, [
          "session",
          "show",
          e.id,
          "--json",
        ]).catch(() => null);
        return entryToSession(e, show?.status ?? "unknown");
      }),
    );
    return enriched;
  }

  async getSession(id: string): Promise<Session | null> {
    const [show, list] = await Promise.all([
      runJson(aoeSessionShowSchema, ["session", "show", id, "--json"]).catch(
        () => null,
      ),
      runJson(aoeListSchema, ["list", "--json"]),
    ]);
    if (!show) return null;
    const base = list.find((e) => e.id === show.id);
    return showToSession(show, base ? entryToSession(base) : null);
  }

  async getOutput(id: string, lines = 200): Promise<OutputSnapshot> {
    const capture = await runJson(aoeCaptureSchema, [
      "session",
      "capture",
      id,
      "--json",
      "--strip-ansi",
      "-n",
      String(lines),
    ]);
    return { content: capture.content, lines: capture.lines };
  }

  async sendInput(id: string, text: string): Promise<SendResult> {
    try {
      await runVoid(["send", id, text]);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async waitIdle(
    id: string,
    opts: IdleWaitOptions,
  ): Promise<{ settled: boolean; lastSnapshot: OutputSnapshot }> {
    const pollMs = opts.pollIntervalMs ?? 1000;
    const deadline = Date.now() + opts.timeoutMs;
    let lastSnapshot = await this.getOutput(id);
    let lastChangedAt = Date.now();
    let lastContent = lastSnapshot.content;

    while (Date.now() < deadline) {
      await Bun.sleep(pollMs);
      const snap = await this.getOutput(id);
      if (snap.content !== lastContent) {
        lastContent = snap.content;
        lastChangedAt = Date.now();
      }
      lastSnapshot = snap;
      if (Date.now() - lastChangedAt >= opts.idleWindowMs) {
        return { settled: true, lastSnapshot };
      }
    }
    return { settled: false, lastSnapshot };
  }
}
