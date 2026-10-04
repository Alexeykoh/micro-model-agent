import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveSessionUsage, loadSessionUsage } from "../src/modules/webui/session/session-usage";
import { activeUsage, createWebUiState } from "../src/modules/webui/state";

describe("webui session usage persistence", () => {
  it("round-trips a usage snapshot through the session dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-usage-"));
    try {
      saveSessionUsage(dir, { contextUsed: 123, costUsd: 0.01 });
      expect(loadSessionUsage(dir)).toEqual({ contextUsed: 123, costUsd: 0.01 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("activeUsage lazily hydrates from disk after a reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-usage-"));
    try {
      saveSessionUsage(dir, { contextUsed: 42, contextLimit: 1000 });
      const s = createWebUiState();
      s.sessionManager = {
        list: () => [],
        get: () => null,
        getActive: () => "ses_p",
        setActive: () => {},
        delete: () => {},
        getSessionDirectory: () => dir,
      };
      // Factory mode: no global last-turn fallback, so disk is the only source.
      s.pool.setFactory(() => ({}) as never);

      expect(activeUsage(s, "ses_p")).toEqual({ contextUsed: 42, contextLimit: 1000 });
      expect(s.sessionUsage["ses_p"]).toEqual({ contextUsed: 42, contextLimit: 1000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the session has no persisted snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-usage-"));
    try {
      const s = createWebUiState();
      s.sessionManager = {
        list: () => [],
        get: () => null,
        getActive: () => "ses_empty",
        setActive: () => {},
        delete: () => {},
        getSessionDirectory: () => dir,
      };
      s.pool.setFactory(() => ({}) as never);
      expect(activeUsage(s, "ses_empty")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
