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
  private cache: Selection | null = null;
  private loaded = false;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
  }

  async get(): Promise<Selection | null> {
    if (!this.loaded) await this.load();
    return this.cache;
  }

  async set(selection: Selection): Promise<void> {
    if (!selection.adapter || !selection.id) {
      throw new Error("Selection requires both adapter and id");
    }
    this.cache = { adapter: selection.adapter, id: selection.id };
    this.loaded = true;
    await this.persist();
  }

  async clear(): Promise<void> {
    this.cache = null;
    this.loaded = true;
    await this.persist();
  }

  private async load(): Promise<void> {
    this.loaded = true;
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      this.cache = null;
      return;
    }
    try {
      const parsed = JSON.parse(text) as StateFile;
      const sel = parsed?.selected;
      if (sel && typeof sel.adapter === "string" && typeof sel.id === "string") {
        this.cache = { adapter: sel.adapter, id: sel.id };
      } else {
        this.cache = null;
      }
    } catch {
      // Corrupt state file is treated as "no selection". The next set() will
      // overwrite it.
      this.cache = null;
    }
  }

  private async persist(): Promise<void> {
    const data: StateFile = { version: 1, selected: this.cache };
    const json = JSON.stringify(data, null, 2) + "\n";
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, this.path);
  }
}
