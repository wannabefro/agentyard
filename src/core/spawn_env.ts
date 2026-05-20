// Returns an env suitable for spawning external CLIs (codex, claude, aoe, tmux).
//
// Problem: when the MCP server is launched by a host (Claude Code, Cursor,
// other), the inherited PATH is whatever the host had — frequently a stripped
// or minimal PATH that omits `/opt/homebrew/bin` (Apple Silicon Homebrew) and
// `/usr/local/bin` (Intel Homebrew / many tools). The user's interactive
// shell has these on PATH, but the MCP subprocess does not.
//
// Symptom: `Bun.spawn(["codex", ...])` fails with `ENOENT posix_spawn 'codex'`
// even though `which codex` from the user's shell resolves to /opt/homebrew/bin/codex.
//
// Fix: every adapter that spawns an external CLI calls spawnEnv() to get an
// env where PATH includes the common bin locations. Idempotent — if a path
// is already on PATH, it isn't duplicated.

const EXTRA_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
];

export function spawnEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  const current = (env.PATH ?? "").split(":").filter((p) => p.length > 0);
  for (const p of EXTRA_PATHS) {
    if (!current.includes(p)) current.push(p);
  }
  env.PATH = current.join(":");
  return { ...env, ...extra };
}
