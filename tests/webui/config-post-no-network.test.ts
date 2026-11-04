// INV-W5 (§4 B5): сеть списка моделей не входит в путь ответа `POST /api/config`.
// Рефреш уходит в фон после персиста и локального применения, а ответ уходит
// сразу. До правки `await after()` держал ответ, пока `listModels` не вернётся
// (у зависшего провайдера — минуты).
import { describe, it, expect } from "vitest";
import type { AppConfig } from "../../src/config/types";
import { DEFAULTS } from "../../src/config/defaults";
import { createWebUiState } from "../../src/modules/webui/state";
import { makeReconfigure } from "../../src/modules/webui/settings/reconfigure";
import { withServer, postJson } from "../helpers/webui-server";

/** Рефреш моделей, который никогда не завершается (висящий `listModels`). */
function hangingRefresh(): Promise<void> {
  return new Promise<void>(() => {
    /* never settles */
  });
}

describe("POST /api/config with a hanging model refresh", () => {
  it("answers as soon as the config is persisted and applied", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS) as AppConfig;
    s.saveConfig = () => {};
    let refreshStarted = false;
    s.reconfigure = makeReconfigure(
      s,
      {
        reconfigure: () => {},
        contextManager: { getBudget: () => ({ history: 100 }) },
      },
      () => {
        refreshStarted = true;
        return hangingRefresh();
      },
    );

    await withServer(s, async (base) => {
      const started = performance.now();
      const res = await postJson(base, "/api/config", { key: "model", value: "new-model" });
      const elapsed = performance.now() - started;
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.persisted).toBe(true);
      // Ответ не ждёт зависший рефреш: секунды (и тем более минуты) — провал.
      expect(elapsed).toBeLessThan(1500);
      // Рефреш при этом запущен — просто в фоне.
      expect(refreshStarted).toBe(true);
    });
  });
});
