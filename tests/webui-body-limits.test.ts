import { describe, it, expect, beforeEach } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import { withServer, doFetch, postJson } from "./helpers/webui-server";
import { resetSetupProbeRateLimit } from "../src/modules/webui/settings/setup-policy";
import { DEFAULTS } from "../src/config/defaults";
import type { AppConfig } from "../src/config/types";

/**
 * Капы тела по маршруту, кап записи памяти и SSRF-защита проб провайдера
 * (аудит §6.3/§6.4/§6.5/§6.9, план `2026-10-12-harness-module-audit-fixes`,
 * W6/Task 6.2).
 */

beforeEach(() => resetSetupProbeRateLimit());

describe("webui: капы тела и пробы", () => {
  it("config endpoint rejects a body over its route cap", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS) as AppConfig;
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "x".repeat(5 * 1024 * 1024) }),
      });
      expect(res.status).toBe(413);
    });
  });

  it("memory writes are length-capped", async () => {
    const s = createWebUiState();
    const appended: string[] = [];
    s.memory = {
      append: (_category: string, text: string) => appended.push(text),
      list: () => [],
      clear: () => {},
      remove: () => {},
    } as never;
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/memory", {
        category: "facts",
        text: "x".repeat(2 * 1024 * 1024),
      });
      expect(res.status).toBe(413);
      expect(appended).toEqual([]);
    });
  });

  it("memory entries are truncated to the entry cap", async () => {
    const s = createWebUiState();
    const appended: string[] = [];
    s.memory = {
      append: (_category: string, text: string) => appended.push(text),
      list: () => [],
      clear: () => {},
      remove: () => {},
    } as never;
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/memory", {
        category: "facts",
        text: "y".repeat(50_000),
      });
      expect(res.status).toBe(200);
      expect(appended[0]?.length).toBe(20_000);
    });
  });

  it("setup provider probing refuses metadata addresses", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/setup/models", {
        baseUrl: "http://169.254.169.254",
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("blocked-host");
    });
  });

  it("setup probing allows a local provider", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/setup/models", {
        baseUrl: "http://127.0.0.1:11434",
      });
      // Проба не доходит до сети: ответ либо 200 с пустым списком, либо ошибка
      // соединения — важно, что НЕ 400 blocked-host.
      expect(res.status).not.toBe(400);
    });
  });

  it("setup probing is rate-limited per client", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      let limited = 0;
      for (let i = 0; i < 12; i++) {
        const res = await postJson(base, "/api/setup/models", {
          baseUrl: "http://127.0.0.1:11434",
        });
        if (res.status === 429) limited++;
      }
      expect(limited).toBeGreaterThan(0);
    });
  });
});
