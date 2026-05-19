import type { ZodTypeAny, z } from "zod";

class AoeCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "AoeCliError";
  }
}

async function runJson<S extends ZodTypeAny>(
  schema: S,
  argv: string[],
): Promise<z.infer<S>> {
  const proc = Bun.spawn(["aoe", ...argv], {
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
  const proc = Bun.spawn(["aoe", ...argv], {
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

export { runJson, runVoid, AoeCliError };
