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
