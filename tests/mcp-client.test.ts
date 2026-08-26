import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/modules/mcp/client";
import { MCPRegistry } from "../src/modules/mcp/registry";

describe("MCPRegistry", () => {
  it("should register servers", () => {
    const reg = new MCPRegistry();
    reg.register({ name: "server-a", command: "node", args: ["server.js"] });
    expect(reg.get("server-a")).toBeDefined();
  });

  it("should list registered servers", () => {
    const reg = new MCPRegistry();
    reg.register({ name: "a", command: "", args: [] });
    reg.register({ name: "b", command: "", args: [] });
    expect(reg.list()).toEqual(["a", "b"]);
  });
});

describe("MCPClient", () => {
  it("should create with server config", () => {
    const client = new MCPClient({ name: "test", command: "node", args: ["test.js"] });
    expect(client.serverName).toBe("test");
  });

  it("should report connection status", () => {
    const client = new MCPClient({ name: "test", command: "node", args: ["test.js"] });
    expect(client.isConnected()).toBe(false);
  });
});

describe("MCPClient stdio", () => {
  // Fake MCP server: answers initialize + tools/list over JSON-RPC/NDJSON.
  const SERVER_SCRIPT = `
    let buf = "";
    process.stdin.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } }) + "\\n");
        } else if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo" }] } }) + "\\n");
        }
      }
    });
  `;

  it("performs initialize handshake and lists tools over stdio", async () => {
    const { MCPClient } = await import("../src/modules/mcp/client");
    const client = new MCPClient({
      name: "fake",
      command: process.execPath,
      args: ["-e", SERVER_SCRIPT],
      transport: "stdio",
    });
    try {
      await client.connect();
      expect(client.isConnected()).toBe(true);
      const tools = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("echo");
    } finally {
      await client.disconnect();
    }
  });

  it("rejects a stdio request when the server dies mid-flight (no 30s hang)", async () => {
    const { MCPClient } = await import("../src/modules/mcp/client");
    const DyingScript = `
      let buf = "";
      process.stdin.on("data", (d) => {
        buf += d.toString();
        const i = buf.indexOf("\\n");
        if (i !== -1) {
          const msg = JSON.parse(buf.slice(0, i));
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
            setTimeout(() => process.exit(1), 50);
          }
        }
      });
    `;
    const client = new MCPClient({
      name: "dying",
      command: process.execPath,
      args: ["-e", DyingScript],
      transport: "stdio",
    });
    await client.connect();
    await expect(client.callTool("x", {})).rejects.toThrow(/exited before responding/);
    await client.disconnect();
  }, 15000);
});
