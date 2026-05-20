import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SelectionStore } from "@/core/selection.ts";

describe("SelectionStore", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentyard-selection-test-"));
    path = join(root, "nested", "state.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("get() returns null when no state file exists", async () => {
    const store = new SelectionStore(path);
    expect(await store.get()).toBeNull();
  });

  test("set() persists and creates the directory tree", async () => {
    const store = new SelectionStore(path);
    await store.set({ adapter: "codex", id: "019e4516-ec73-73f2-a8a4-ac9a3ba002ea" });
    expect(existsSync(path)).toBe(true);
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(data.selected).toEqual({
      adapter: "codex",
      id: "019e4516-ec73-73f2-a8a4-ac9a3ba002ea",
    });
    expect(data.version).toBe(1);
  });

  test("get() returns the in-memory cache after set()", async () => {
    const store = new SelectionStore(path);
    await store.set({ adapter: "aoe", id: "abc123" });
    const got = await store.get();
    expect(got).toEqual({ adapter: "aoe", id: "abc123" });
  });

  test("a fresh store loads the persisted selection from disk", async () => {
    const store1 = new SelectionStore(path);
    await store1.set({ adapter: "claude-code", id: "11111111-1111" });
    const store2 = new SelectionStore(path);
    expect(await store2.get()).toEqual({ adapter: "claude-code", id: "11111111-1111" });
  });

  test("clear() drops the selection and persists null", async () => {
    const store = new SelectionStore(path);
    await store.set({ adapter: "codex", id: "abc" });
    await store.clear();
    expect(await store.get()).toBeNull();
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(data.selected).toBeNull();
  });

  test("set() throws when either field is empty", async () => {
    const store = new SelectionStore(path);
    await expect(store.set({ adapter: "", id: "x" })).rejects.toThrow();
    await expect(store.set({ adapter: "x", id: "" })).rejects.toThrow();
  });

  test("corrupt state file is treated as no selection (not a hard error)", async () => {
    // Pre-create a malformed file at the path. Subsequent get() must return
    // null — the user shouldn't see a hard error just because state got
    // mangled.
    const dir = require("node:path").dirname(path);
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(path, "not json {{{");
    const store = new SelectionStore(path);
    expect(await store.get()).toBeNull();
  });

  test("state file missing 'selected' key resolves to null", async () => {
    const dir = require("node:path").dirname(path);
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1 }));
    const store = new SelectionStore(path);
    expect(await store.get()).toBeNull();
  });

  test("subsequent set() overwrites prior selection", async () => {
    const store = new SelectionStore(path);
    await store.set({ adapter: "codex", id: "first" });
    await store.set({ adapter: "aoe", id: "second" });
    expect(await store.get()).toEqual({ adapter: "aoe", id: "second" });
    // And the on-disk view is consistent.
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(data.selected).toEqual({ adapter: "aoe", id: "second" });
  });

  test("path is exposed for inspection", () => {
    const store = new SelectionStore(path);
    expect(store.path).toBe(path);
  });
});
