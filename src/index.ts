#!/usr/bin/env bun
//
// agentyard MCP server entry point — orchestrates AI coding agent
// sessions across adapter implementations. This file is the thin
// bootstrap: wire up adapters, build the selection store, build the
// resolveTarget helper, register every tool group, and connect the
// stdio transport. The actual tool implementations live under
// src/mcp/tools/.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AoeAdapter } from "@/adapters/aoe/index.ts";
import { ClaudeCodeAdapter } from "@/adapters/claude-code/index.ts";
import { CodexAdapter } from "@/adapters/codex/index.ts";
import { MockAdapter } from "@/adapters/mock/index.ts";
import { AdapterRegistry } from "@/core/registry.ts";
import { SelectionStore } from "@/core/selection.ts";

import type { Deps } from "@/mcp/deps.ts";
import { makeResolveTarget } from "@/mcp/resolve-target.ts";
import * as inventoryTools from "@/mcp/tools/inventory.ts";
import * as lifecycleTools from "@/mcp/tools/lifecycle.ts";
import * as selectionTools from "@/mcp/tools/selection.ts";
import * as sendTools from "@/mcp/tools/send.ts";
import * as waitTools from "@/mcp/tools/wait.ts";

import pkg from "../package.json" with { type: "json" };

const registry = new AdapterRegistry();
registry.register(new AoeAdapter());
registry.register(new ClaudeCodeAdapter());
registry.register(new CodexAdapter());
if (process.env.AGENTYARD_MOCK === "1") {
  registry.register(new MockAdapter());
}

const selectionStore = new SelectionStore(
  process.env.AGENTYARD_STATE_PATH || undefined,
);

const deps: Deps = {
  registry,
  selectionStore,
  resolveTarget: makeResolveTarget({ registry, selectionStore }),
};

const server = new McpServer(
  { name: "agentyard", version: pkg.version },
  {
    instructions:
      "agentyard orchestrates AI coding agent sessions across adapters. " +
      "Use resolve_session to map a natural-language reference to a concrete session, " +
      "then call get_output, send_input, or wait_idle against the chosen (adapter, id) pair.",
  },
);

// Each module registers a coherent group of tools. Adding a new tool
// means editing one file (or adding a new module here).
inventoryTools.register(server, deps);
selectionTools.register(server, deps);
sendTools.register(server, deps);
waitTools.register(server, deps);
lifecycleTools.register(server, deps);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`agentyard MCP server up; adapters: ${registry.list().join(", ")}`);

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});
