import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { spawnEnv } from "@/core/spawn_env.ts";

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
    const parts = env.PATH.split(":");
    expect(parts).toContain("/usr/bin");
    expect(parts).toContain("/opt/homebrew/bin");
    expect(parts).toContain("/usr/local/bin");
  });

  test("does not duplicate paths already present", () => {
    process.env.PATH = "/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin";
    const env = spawnEnv();
    const parts = env.PATH.split(":");
    // Original "/opt/homebrew/bin" duplicate is preserved (we don't dedup
    // existing entries — just don't ADD extras that are already present).
    // After processing, /opt/homebrew/sbin should be appended ONCE.
    const sbinCount = parts.filter((p) => p === "/opt/homebrew/sbin").length;
    expect(sbinCount).toBe(1);
  });

  test("works with empty PATH", () => {
    process.env.PATH = "";
    const env = spawnEnv();
    const parts = env.PATH.split(":").filter(Boolean);
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
    const parts = env.PATH.split(":");
    expect(parts[0]).toBe("/opt/homebrew/bin");
    expect(parts[1]).toBe("/usr/local/bin");
    expect(parts[2]).toBe("/usr/bin");
  });
});
