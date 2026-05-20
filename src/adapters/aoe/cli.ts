import type { ZodTypeAny, z } from "zod";

import { findBinary, spawnEnv } from "@/core/spawn_env.ts";

class AoeCliError extends Error {
  constructor(
    baseMessage: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    // Include a short stderr excerpt in the message so the failure is
    // diagnosable from just the propagated Error — important for MCP
    // clients that only see the message text. Trim to keep the message
    // bounded; the full stderr is still on .stderr for callers who need it.
    const excerpt = stderr.trim().split("\n").slice(0, 3).join(" | ").slice(0, 240);
    const message = excerpt ? `${baseMessage}: ${excerpt}` : baseMessage;
    super(message);
    this.name = "AoeCliError";
  }
}

async function runJson<S extends ZodTypeAny>(
  schema: S,
  argv: string[],
): Promise<z.infer<S>> {
  const proc = Bun.spawn([findBinary("aoe"), ...argv], {
    env: spawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new AoeCliError(
      `aoe ${argv.join(" ")} failed with exit ${exitCode}`,
      exitCode,
      stderr,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new AoeCliError(
      `aoe ${argv.join(" ")} returned non-JSON output`,
      exitCode,
      String(cause),
    );
  }
  return schema.parse(parsed);
}

async function runVoid(argv: string[]): Promise<void> {
  const proc = Bun.spawn([findBinary("aoe"), ...argv], {
    env: spawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new AoeCliError(
      `aoe ${argv.join(" ")} failed with exit ${exitCode}`,
      exitCode,
      stderr,
    );
  }
}

async function runRaw(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([findBinary("aoe"), ...argv], {
    env: spawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new AoeCliError(
      `aoe ${argv.join(" ")} failed with exit ${exitCode}`,
      exitCode,
      stderr,
    );
  }
  return { stdout, stderr };
}

export { runJson, runVoid, runRaw, AoeCliError };
