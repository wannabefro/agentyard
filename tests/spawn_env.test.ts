import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { _resetBinaryCache, findBinary, spawnEnv } from "@/core/spawn_env.ts";

describe("spawnEnv", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  test("inherits non-PATH env vars", () => {
    process.env.AGENTYARD_TEST_KEY = "marker-value";
    const env = spawnEnv();
    expect(env.AGENTYARD_TEST_KEY).toBe("marker-value");
    delete process.env.AGENTYARD_TEST_KEY;
  });

  test("appends Homebrew paths when missing", () => {
    process.env.PATH = "/usr/bin";
    const env = spawnEnv();
    const parts = (env.PATH ?? "").split(":");
    expect(parts).toContain("/usr/bin");
    expect(parts).toContain("/opt/homebrew/bin");
    expect(parts).toContain("/usr/local/bin");
  });

  test("does not duplicate paths already present", () => {
    process.env.PATH = "/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin";
    const env = spawnEnv();
    const parts = (env.PATH ?? "").split(":");
    // Original "/opt/homebrew/bin" duplicate is preserved (we don't dedup
    // existing entries — just don't ADD extras that are already present).
    // After processing, /opt/homebrew/sbin should be appended ONCE.
    const sbinCount = parts.filter((p) => p === "/opt/homebrew/sbin").length;
    expect(sbinCount).toBe(1);
  });

  test("works with empty PATH", () => {
    process.env.PATH = "";
    const env = spawnEnv();
    const parts = (env.PATH ?? "").split(":").filter(Boolean);
    expect(parts).toContain("/opt/homebrew/bin");
    expect(parts).toContain("/usr/local/bin");
  });

  test("extra arg overrides existing keys", () => {
    process.env.AGENTYARD_TEST_KEY = "original";
    const env = spawnEnv({ AGENTYARD_TEST_KEY: "override" });
    expect(env.AGENTYARD_TEST_KEY).toBe("override");
    delete process.env.AGENTYARD_TEST_KEY;
  });

  test("preserves PATH order when extras already present", () => {
    process.env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin";
    const env = spawnEnv();
    const parts = (env.PATH ?? "").split(":");
    expect(parts[0]).toBe("/opt/homebrew/bin");
    expect(parts[1]).toBe("/usr/local/bin");
    expect(parts[2]).toBe("/usr/bin");
  });
});

describe("findBinary", () => {
  beforeEach(() => {
    _resetBinaryCache();
  });

  test("falls back to bare name when binary is not installed", () => {
    // Use a clearly-non-existent name. Even with augmented PATH, this won't
    // resolve, so we expect the bare name back.
    expect(findBinary("agentyard-definitely-not-a-real-binary-x9z2")).toBe(
      "agentyard-definitely-not-a-real-binary-x9z2",
    );
  });

  test("resolves a binary that exists in the augmented PATH", () => {
    // /bin/ls is on every POSIX system. PATH may or may not include /bin
    // depending on the harness; the augmentedPath() helper doesn't add /bin
    // explicitly, so this test only verifies the resolution path when the
    // binary is in process.env.PATH.
    const originalPath = process.env.PATH;
    process.env.PATH = "/bin:/usr/bin";
    const resolved = findBinary("ls");
    process.env.PATH = originalPath;
    expect(resolved.endsWith("/ls")).toBe(true);
  });

  test("caches resolutions", () => {
    // Resolve once, then change PATH such that the binary wouldn't be
    // findable. The cache should still return the first resolution.
    const originalPath = process.env.PATH;
    process.env.PATH = "/bin:/usr/bin";
    const first = findBinary("ls");
    process.env.PATH = ""; // would normally make findBinary fall back
    const second = findBinary("ls");
    process.env.PATH = originalPath;
    expect(second).toBe(first);
  });
});
