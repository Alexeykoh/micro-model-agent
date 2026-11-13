// INV-W6 (§4 B4): проба выполняется один раз на операцию — только основным
// агентом. Все кешированные раннеры пула применяют конфиг с `{ probe: false }`.
// До правки у раннеров opts не было вообще (undefined ≠ false): 8 сетевых
// проб повторялись по одной.
import { describe, it, expect } from "vitest";
import type { AppConfig } from "../../src/config/types";
import { createWebUiState } from "../../src/modules/webui/state";
import { makeReconfigure } from "../../src/modules/webui/settings/reconfigure";
import { RUNNER_LRU_MAX } from "../../src/runtime/run-pool/run-pool";

describe("webui reconfigure single probe", () => {
  it("probes once (main agent); every pooled runner reconfigures with probe:false", async () => {
    const state = createWebUiState();
    const calls: Array<{ id: string; probe: boolean | undefined }> = [];
    state.pool.setFactory(
      (id: string) =>
        ({
          sessionId: id,
          agent: {
            reconfigure: (_config: AppConfig, opts?: { probe?: boolean }) => {
              calls.push({ id, probe: opts?.probe });
            },
          },
          shutdown: () => {},
        }) as never,
    );
    for (let i = 0; i < RUNNER_LRU_MAX; i++) state.pool.getOrCreateRunner(`s${i}`);

    const main = {
      reconfigure: (_config: AppConfig, opts?: { probe?: boolean }) => {
        calls.push({ id: "main", probe: opts?.probe });
      },
      contextManager: { getBudget: () => ({ history: 100 }) },
    };
    try {
      const fn = makeReconfigure(state, main);
      await fn({} as AppConfig);

      // Ровно один вызов с пробой — основной агент; остальные явно без неё.
      const probed = calls.filter((c) => c.probe !== false).map((c) => c.id);
      expect(probed).toEqual(["main"]);
      expect(calls.filter((c) => c.probe === false)).toHaveLength(RUNNER_LRU_MAX);
      expect(calls).toHaveLength(RUNNER_LRU_MAX + 1);
    } finally {
      state.pool.clear();
    }
  });
});
