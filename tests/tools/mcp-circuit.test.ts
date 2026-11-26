// Гвард к docs/specs/2026-11-23-research-loop-efficiency-design.md (§2):
// сессия ses_mwt1gw9o_eyxsehbrwjrhdzsn делала 6 переоткрытий страницы через
// MCP после того, как сервер начал отвечать пустыми страницами.
import { describe, it, expect, beforeEach } from "vitest";
import {
  MCP_FAILURE_THRESHOLD,
  mcpCircuitBlocked,
  recordMcpFailure,
  recordMcpSuccess,
  resetMcpCircuitForTests,
} from "../../src/tools/mcp-circuit";

beforeEach(() => resetMcpCircuitForTests());

describe("mcp circuit breaker", () => {
  it("opens only after two consecutive failures", () => {
    expect(MCP_FAILURE_THRESHOLD).toBe(2);
    expect(recordMcpFailure("playwright", 1_000)).toBe(false);
    expect(mcpCircuitBlocked("playwright", 1_001)).toBe(false);
    expect(recordMcpFailure("playwright", 1_002)).toBe(true);
    expect(mcpCircuitBlocked("playwright", 1_003)).toBe(true);
  });

  it("closes after the cooldown expires", () => {
    recordMcpFailure("playwright", 0);
    recordMcpFailure("playwright", 0);
    expect(mcpCircuitBlocked("playwright", 59_999)).toBe(true);
    expect(mcpCircuitBlocked("playwright", 60_000)).toBe(false);
  });

  it("a success resets the failure streak", () => {
    recordMcpFailure("playwright", 0);
    recordMcpSuccess("playwright");
    expect(recordMcpFailure("playwright", 1)).toBe(false);
    expect(mcpCircuitBlocked("playwright", 2)).toBe(false);
  });

  it("keeps servers independent", () => {
    recordMcpFailure("playwright", 0);
    recordMcpFailure("playwright", 0);
    expect(mcpCircuitBlocked("other", 1)).toBe(false);
  });
});
