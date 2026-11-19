import { describe, it, expect } from "vitest";
import { buildProviderEntry } from "../../src/cli/provider-entry";

/**
 * `provider add` не выдумывает лимиты: пользователь задаёт только то, что
 * указал (аудит §7.13, план `2026-10-12-harness-module-audit-fixes`,
 * W8/Task 8.1b).
 */

describe("provider add: лимиты не выдумываются", () => {
  it("a provider without limits gets none", () => {
    const r = buildProviderEntry({ name: "x", baseUrl: "https://x/v1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.rateLimits).toBeUndefined();
  });

  it("adding a provider with only --parallel does not impose an rpm cap", () => {
    const r = buildProviderEntry({ name: "x", baseUrl: "https://x/v1", parallel: "4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.rateLimits?.maxRequestsPerMinute).toBeUndefined();
    expect(r.entry.rateLimits?.maxParallelTasks).toBe(4);
  });

  it("explicit limits are kept as given", () => {
    const r = buildProviderEntry({
      name: "x",
      baseUrl: "https://x/v1",
      rpm: "120",
      parallel: "8",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.rateLimits?.maxRequestsPerMinute).toBe(120);
    expect(r.entry.rateLimits?.maxParallelTasks).toBe(8);
  });

  it("a non-numeric limit is an error, not a silent NaN", () => {
    const r = buildProviderEntry({ name: "x", baseUrl: "https://x/v1", rpm: "abc" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("bad_number");
  });
});
