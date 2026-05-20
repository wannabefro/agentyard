// Helpers for spawning external CLIs (codex, claude, aoe, tmux) from the MCP
// server in a host-launched environment.
//
// Problem: when the MCP server is launched by a host (Claude Code, Cursor,
// other), the inherited PATH is whatever the host had — frequently a
// stripped or minimal PATH that omits `/opt/homebrew/bin` (Apple Silicon
// Homebrew) and `/usr/local/bin` (Intel Homebrew). The user's interactive
// shell has these on PATH; the MCP subprocess does not.
//
// Symptom: `Bun.spawn(["codex", ...])` fails with `ENOENT posix_spawn 'codex'`
// even though `which codex` from the user's shell resolves to
// /opt/homebrew/bin/codex.
//
// The non-obvious gotcha: Bun.spawn looks up the binary against the PARENT
// process's `process.env.PATH`, NOT the env passed via `{ env: ... }` to
// spawn. The env arg only controls what the CHILD sees post-fork. So
// augmenting env.PATH does not fix binary lookup — we have to resolve the
// binary to an absolute path eagerly and spawn that.
//
// `findBinary(name)` resolves a CLI name to its absolute path using
// `Bun.which` with an augmented PATH. Falls back to the bare name if
// resolution fails (so the resulting spawn error is the familiar ENOENT
// rather than something more obscure).
//
// `spawnEnv()` returns an env with augmented PATH for the child process —
// in case the child wants to spawn FURTHER subprocesses (codex calls hooks,
// claude may invoke skills/MCP servers itself, aoe drives tmux).

const EXTRA_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
];

function augmentedPath(): string {
  const current = (process.env.PATH ?? "").split(":").filter((p) => p.length > 0);
  for (const p of EXTRA_PATHS) {
    if (!current.includes(p)) current.push(p);
  }
  return current.join(":");
}

// Cache: binary resolution is filesystem-bound but stable for the lifetime
// of the process. Cached negatives (null → bare name) too — if `codex` isn't
// installed at startup, no point re-stating every spawn.
const binaryCache = new Map<string, string>();

export function findBinary(name: string): string {
  const cached = binaryCache.get(name);
  if (cached !== undefined) return cached;
  const resolved = Bun.which(name, { PATH: augmentedPath() }) ?? name;
  binaryCache.set(name, resolved);
  return resolved;
}

// Exported only for tests that need to reset state.
export function _resetBinaryCache(): void {
  binaryCache.clear();
}

export function spawnEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.PATH = augmentedPath();
  return { ...env, ...extra };
}

// Resolves a child-process cwd that may not exist on disk.
//
// Surfaced by a real failure: Bun.spawn with cwd pointing at a nonexistent
// directory fails with `ENOENT posix_spawn '<binary>'` — the error message
// blames the binary, not the cwd, which is wildly misleading. Repro:
//
//   Bun.spawn(["/opt/homebrew/bin/codex", "--version"], { cwd: "/no/such/dir" })
//   → "ENOENT: no such file or directory, posix_spawn '/opt/homebrew/bin/codex'"
//
// This shows up in agentyard whenever a session's recorded cwd has been
// deleted since the session was created (worktree pruned, mkdtempSync
// scratch dir cleaned up, project moved). The session metadata in
// ~/.codex/sessions/.../rollout-*.jsonl or ~/.claude/projects/.../*.jsonl
// preserves the original cwd, but the path may no longer exist.
//
// Policies:
//   "fallback" — if cwd is missing, return process.cwd() with a warning.
//     Use when the agent doesn't strictly need the original workspace
//     (codex: `codex exec resume <id>` looks up by id alone, not by cwd).
//   "create"   — if cwd is missing, create it (recursive mkdir) and use it.
//     Use when the agent DOES need that exact path (claude-code: `claude
//     --resume` requires the cwd to exist — empty is fine).

export type EnsureCwdPolicy = "fallback" | "create";

export type EnsureCwdResult = {
  cwd: string;
  warning?: string;
};

export async function ensureSpawnCwd(
  preferredPath: string | undefined | null,
  policy: EnsureCwdPolicy,
): Promise<EnsureCwdResult> {
  const target = preferredPath?.trim();
  if (!target) return { cwd: process.cwd() };

  const exists = await directoryExists(target);
  if (exists) return { cwd: target };

  if (policy === "create") {
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(target, { recursive: true });
      return {
        cwd: target,
        warning: `session workdir "${target}" did not exist; created an empty directory so the agent can resume`,
      };
    } catch (e) {
      // mkdir can fail for legitimate reasons (read-only parent, perms).
      // Fall through to the fallback policy.
      const reason = e instanceof Error ? e.message : String(e);
      return {
        cwd: process.cwd(),
        warning: `session workdir "${target}" is missing and could not be created (${reason}); spawning in ${process.cwd()} — agent file ops will operate against the wrong workspace`,
      };
    }
  }

  return {
    cwd: process.cwd(),
    warning: `session workdir "${target}" no longer exists; spawning in ${process.cwd()} — agent file ops will operate against the wrong workspace`,
  };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
