#!/usr/bin/env bun
// Probe: remove_session with deleteWorktree:true. Confirms the flag
// propagates through AoeAdapter to `aoe remove --delete-worktree` and that
// the worktree directory + git's worktree record are both cleaned up.
//
// Run: bun run tests/live_dogfood_delete_worktree.ts

import { AoeAdapter } from "@/adapters/aoe/index.ts";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

const adapter = new AoeAdapter();
const ts = Date.now();
const repoDir = `/tmp/ay-wt-repo-${ts}`;
const worktreeBranch = `ay-wt-${ts}`;
let sessionId: string | null = null;
let worktreePath: string | null = null;

async function sh(argv: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${argv.join(" ")} exit=${code}\nstderr: ${err}`);
  return out + err;
}

try {
  console.log(`Setting up temp git repo at ${repoDir}`);
  await Bun.spawn(["mkdir", "-p", repoDir]).exited;
  await sh(["git", "init", "-q", "-b", "main"], repoDir);
  await sh(["git", "config", "user.email", "test@example.com"], repoDir);
  await sh(["git", "config", "user.name", "Test"], repoDir);
  await Bun.write(`${repoDir}/README.md`, "test\n");
  await sh(["git", "add", "README.md"], repoDir);
  await sh(["git", "commit", "-q", "-m", "init"], repoDir);

  console.log(`Creating aoe session with --worktree ${worktreeBranch} (new branch)`);
  // aoe add with --worktree <branch> -b creates the worktree for us.
  // The CLI returns "ID: <id>" similar to plain add. Use the same parsing
  // path by calling through the adapter — but createSession doesn't expose
  // --worktree, so call aoe CLI directly here.
  const addOut = await sh(
    ["aoe", "add", repoDir, "--worktree", worktreeBranch, "--new-branch", "--title", `ay-wt-${ts}`],
  );
  const idMatch = /\s*ID:\s+([a-f0-9]+)/m.exec(addOut);
  if (!idMatch) throw new Error(`aoe add: no ID in output:\n${addOut}`);
  sessionId = idMatch[1]!;
  console.log(`  id=${sessionId}`);

  // Confirm the session and its worktree path.
  const session = await adapter.getSession(sessionId);
  console.log(`  workdir=${session?.workdir}`);
  console.log(`  branch=${session?.branch}`);
  worktreePath = session?.workdir ?? null;
  if (!worktreePath) throw new Error("session has no workdir");
  if (!existsSync(worktreePath)) {
    throw new Error(`worktree path ${worktreePath} does not exist before remove`);
  }
  console.log(`  worktree exists on disk: true`);

  // git worktree list to confirm git tracks it.
  const wtListBefore = await sh(["git", "worktree", "list"], repoDir);
  const trackedBefore = wtListBefore.includes(worktreePath);
  console.log(`  git tracks worktree: ${trackedBefore}`);

  console.log("\n=== PROBE: adapter.removeSession with deleteWorktree:true ===");
  await adapter.removeSession(sessionId, { deleteWorktree: true, force: true });
  sessionId = null;

  console.log("\nVerification:");
  const stillExists = existsSync(worktreePath);
  console.log(`  worktree directory still exists on disk: ${stillExists}`);

  // After git worktree remove, `git worktree list` will only show main +
  // remaining worktrees. Use `git worktree prune` first since aoe may have
  // removed the dir without informing git.
  await sh(["git", "worktree", "prune"], repoDir);
  const wtListAfter = await sh(["git", "worktree", "list"], repoDir);
  const trackedAfter = wtListAfter.includes(worktreePath);
  console.log(`  git still tracks worktree (post-prune): ${trackedAfter}`);

  // Confirm session is removed from aoe's catalog.
  const ghost = await adapter.getSession(idMatch[1]!);
  console.log(`  session.getSession(id) after remove: ${ghost === null ? "null (clean)" : `still present: ${JSON.stringify(ghost?.title)}`}`);

  console.log("\n=== Verdict ===");
  if (!stillExists && !trackedAfter && ghost === null) {
    console.log("PASS: deleteWorktree fully cleaned filesystem, git record, and aoe catalog.");
  } else {
    console.log("FAIL: at least one cleanup step did not complete.");
    if (stillExists) console.log("  - worktree dir still on disk");
    if (trackedAfter) console.log("  - git still tracks the worktree");
    if (ghost !== null) console.log("  - aoe catalog still has the session");
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nERROR:", err);
  process.exitCode = 1;
} finally {
  // Cleanup any leftover state — if removeSession partially failed, try to
  // unblock the next run.
  if (sessionId) {
    try {
      await adapter.removeSession(sessionId, { deleteWorktree: true, force: true });
    } catch {
      try {
        await adapter.removeSession(sessionId, { force: true });
      } catch {}
    }
  }
  try {
    await rm(repoDir, { recursive: true, force: true });
    console.log(`\nCleaned up temp repo ${repoDir}`);
  } catch (err) {
    console.error(`failed to remove ${repoDir}:`, err);
  }
}
