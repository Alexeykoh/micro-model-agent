import { describe, expect, it } from "vitest";
import { mcpToolSecurity } from "../../../src/modules/mcp/tool-shape";
import {
  isExternalServiceUrl,
  projectOutboundDeep,
} from "../../../src/modules/security/data-policy/outbound";
import { DEFAULT_DATA_POLICY } from "../../../src/modules/security/data-policy/defaults";
import type { PolicyContext } from "../../../src/modules/security/data-policy/context";

const ctx: PolicyContext = {
  baseDir: "C:\\work\\proj",
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  workspaceRoots: [],
};

describe("MCP: внешний сервер", () => {
  it("http/sse на не-loopback — внешний, stdio/loopback — нет", () => {
    expect(isExternalServiceUrl("https://mcp.example.com/sse")).toBe(true);
    expect(isExternalServiceUrl("http://127.0.0.1:3000/mcp")).toBe(false);
    expect(isExternalServiceUrl("http://localhost:3000/mcp")).toBe(false);
    expect(isExternalServiceUrl("http://192.168.1.5:3000/mcp")).toBe(false);
    expect(isExternalServiceUrl(undefined)).toBe(false);
  });

  it("аргументы проецируются для внешнего сервера", () => {
    const args = {
      query: "find C:\\work\\proj\\secret\\a.txt",
      note: "api_key=sk-abcdefghij0123456789",
      nested: [{ path: "C:\\work\\proj\\secret\\b.txt" }],
    };
    const out = projectOutboundDeep(args, { ...DEFAULT_DATA_POLICY, pseudonymize: true }, {
      kind: "api",
      trusted: false,
    }, ctx);
    const text = JSON.stringify(out.value);
    expect(text).not.toContain("C:\\work\\proj");
    expect(text).not.toContain("sk-abcdefghij0123456789");
    expect(out.changed).toBe(true);
  });
});

describe("MCP: pathArgs выводятся из input-схемы", () => {
  it("поля-пути становятся pathArgs", () => {
    const decl = mcpToolSecurity({
      type: "object",
      properties: { file_path: { type: "string" }, query: { type: "string" } },
    });
    expect(decl.pathArgs).toEqual(["file_path"]);
    expect(decl.manual?.reason).toContain("mcp");
  });

  it("массивы путей и синонимы", () => {
    const decl = mcpToolSecurity({
      type: "object",
      properties: { paths: { type: "array" }, directory: {}, cwd: {} },
    });
    expect(decl.pathArgs).toEqual(["paths", "directory"]);
  });

  it("без path-полей декларация остаётся manual-only", () => {
    const decl = mcpToolSecurity({ type: "object", properties: { query: {} } });
    expect(decl.pathArgs).toBeUndefined();
    expect(decl.manual).toBeDefined();
  });

  it("битая схема не роняет регистрацию", () => {
    expect(mcpToolSecurity({} as never).pathArgs).toBeUndefined();
    expect(mcpToolSecurity({ properties: [] } as never).pathArgs).toBeUndefined();
  });
});
