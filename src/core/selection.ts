import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Selection = {
  adapter: string;
  id: string;
};

// Persistent "current session pointer" for the MCP server. Backed by a
// single JSON file so the selection survives /mcp reconnects and host
// restarts. In-memory cache is the source of truth during a process
// lifetime; load() lazily warms the cache from disk on first read.
//
// Atomic writes via tmp + rename so a crashed write can't truncate the
// state file to garbage. Concurrency is not a concern — the MCP server is
// single-process and tool calls serialize on the JSON-RPC stream.
const DEFAULT_PATH = join(homedir(), ".agentyard", "state.json");

type StateFile = {
  version: 1;
  selected: Selection | null;
};

export class SelectionStore {
  readonly path: string;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
  }

  // Reads from disk on every call. The store is intentionally cache-free —
  // the file is the source of truth, and external edits (manual state.json
  // mutations, another MCP server writing the same file, an auto-expiry
  // clearing in a sibling process) must be observable. The file is tiny
  // (~100 bytes), fs cache makes this cheap, and selection lookups happen
  // on at most one tool call per interaction — not a hot path.
  async get(): Promise<Selection | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as StateFile;
      const sel = parsed?.selected;
      if (sel && typeof sel.adapter === "string" && typeof sel.id === "string") {
        return { adapter: sel.adapter, id: sel.id };
      }
      return null;
    } catch {
      // Corrupt state file is treated as "no selection". The next set()
      // will overwrite it.
      return null;
    }
  }

  async set(selection: Selection): Promise<void> {
    if (!selection.adapter || !selection.id) {
      throw new Error("Selection requires both adapter and id");
    }
    await this.persist({ adapter: selection.adapter, id: selection.id });
  }

  async clear(): Promise<void> {
    await this.persist(null);
  }

  private async persist(selection: Selection | null): Promise<void> {
    const data: StateFile = { version: 1, selected: selection };
    const json = JSON.stringify(data, null, 2) + "\n";
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, this.path);
  }
}
