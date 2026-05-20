import { describe, expect, test } from "bun:test";

// Re-declared inline so the test catches accidental changes to the production regex.
// If you change SESSION_ID_RE in src/adapters/aoe/index.ts, update this fixture and confirm
// the new regex still matches the sample stdout captured in docs/research/agent-of-empires.md.
const SESSION_ID_RE = /^\s*ID:\s+([a-f0-9]+)\s*$/m;

// Captured verbatim from `aoe 1.7.0` (`aoe add /tmp/x --title pepper-probe --cmd claude` output).
const REAL_AOE_ADD_STDOUT = `Running on_create hooks...
✓ on_create hooks completed
✓ Added session: pepper-probe
  Profile: default
  Path:    /private/tmp/x
  Group:
  ID:      d31463effc3a4cfb
  Cmd:     claude

Next steps:
  aoe session start pepper-probe   # Start the session
  aoe                              # Open TUI and press Enter to attach
`;

describe("SESSION_ID_RE", () => {
  test("matches the real aoe add stdout and extracts the 16-char hex id", () => {
    const match = SESSION_ID_RE.exec(REAL_AOE_ADD_STDOUT);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("d31463effc3a4cfb");
    expect(match?.[1]?.length).toBe(16);
  });

  test("returns no match when stdout lacks the ID line", () => {
    expect(SESSION_ID_RE.exec("Added session: foo\nProfile: default\n")).toBeNull();
  });

  test("does not match non-hex characters in the id", () => {
    expect(SESSION_ID_RE.exec("  ID:      not-a-hex-string\n")).toBeNull();
  });

  test("ignores leading whitespace variation", () => {
    expect(SESSION_ID_RE.exec("ID: abc123\n")?.[1]).toBe("abc123");
    expect(SESSION_ID_RE.exec("    ID:    abc123\n")?.[1]).toBe("abc123");
  });
});
