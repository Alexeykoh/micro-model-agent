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
