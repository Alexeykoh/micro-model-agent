import { describe, it, expect } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import { withServer, postJson } from "./helpers/webui-server";
import { DEFAULTS } from "../src/config/defaults";
import type { AppConfig } from "../src/config/types";

/**
 * Запись настроек и провайдеров отклоняется, пока идёт ход (аудит §7.9,
 * план `2026-10-12-harness-module-audit-fixes`, W7/Task 7.5).
 */

describe("веб-настройки: гейт занятости", () => {
  it("refuses provider writes while a turn is running", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS) as AppConfig;
    s.busy = true;
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/providers", {
        name: "x",
        type: "openai-compat",
        baseUrl: "https://api.example.com/v1",
      });
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("busy");
    });
  });

  it("refuses config writes while a turn is running", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS) as AppConfig;
    s.busy = true;
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/config", { key: "contextWindow", value: 65536 });
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("busy");
    });
  });

  // INV-T3: тема — UI-настройка без effects, её меняют и во время ответа.
  it("allows theme writes while a turn is running", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS) as AppConfig;
    s.busy = true;
    await withServer(s, async (base) => {
      const skin = await postJson(base, "/api/config", { key: "ui.theme", value: "paper" });
      expect(skin.status).toBe(200);
      expect(skin.json.ok).toBe(true);
      expect(s.config?.ui.theme).toBe("paper");

      const mode = await postJson(base, "/api/config", { key: "ui.themeMode", value: "light" });
      expect(mode.status).toBe(200);
      expect(s.config?.ui.themeMode).toBe("light");
    });
  });

  it("allows provider writes when idle", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS) as AppConfig;
    s.busy = false;
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/providers", {
        name: "x",
        type: "openai-compat",
        baseUrl: "https://api.example.com/v1",
      });
      expect(res.status).toBe(200);
    });
  });
});
