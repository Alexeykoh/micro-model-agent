// Пустая модель — валидное состояние (пользователь ещё не выбрал её у нового
// провайдера). Пробы контекста/capabilities с пустым id бессмысленны: провайдер
// отвечает максимумом каталога, и это число выдавалось за окно несуществующей
// модели (живой баг: 1M/977K после очистки).
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupProviderPhase } from "../../src/core/bootstrap/provider-phase";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";

function config(): AppConfig {
  const c = structuredClone(DEFAULTS);
  c.model = "";
  c.contextWindow = 1_000_000;
  c.provider = {
    type: "opencode-go",
    baseUrl: "http://127.0.0.1:1/v1",
    active: "opencode-go",
    entries: [{ type: "opencode-go", label: "opencode-go", baseUrl: "http://127.0.0.1:1/v1" }],
  };
  c.reasoning = { ...(c.reasoning ?? {}), mode: "auto" } as AppConfig["reasoning"];
  return c;
}

const noop = () => {};
const logger = new Proxy({}, { get: () => noop }) as never;

describe("setupProviderPhase without a model", () => {
  it("does not probe context or capabilities with an empty model id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-empty-model-"));
    const cfg = config();
    const phase = await setupProviderPhase(cfg, logger, dir);
    expect(await phase.contextProbePromise).toBeNull();
    expect(cfg.contextWindow).toBe(1_000_000);
    expect(phase.capabilitiesRef.reachable).toBe(false);
    expect(phase.capabilitiesRef.probe).toBeUndefined();
  });
});
