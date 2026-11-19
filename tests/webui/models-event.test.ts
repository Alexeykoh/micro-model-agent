// INV-W5 (§4 B5/B7): рефреш списка моделей уходит в фон, а его результат
// клиент получает SSE-событием `models` (и повторным `config`, если проба
// подправила окно). До правки события `models` не существовало вовсе.
import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../../src/config/types";
import { createWebUiState } from "../../src/modules/webui/state";
import { makeReconfigure } from "../../src/modules/webui/settings/reconfigure";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Минимальный SSE-клиент: `broadcast` вызывает только `write`/`end`. */
function fakeClient(chunks: string[]): ServerResponse {
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {},
  } as unknown as ServerResponse;
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const agent = {
  reconfigure: () => {},
  contextManager: { getBudget: () => ({ history: 100 }) },
};

describe("models SSE event", () => {
  it("broadcasts `models` only after the background refresh completes", async () => {
    const s = createWebUiState();
    const chunks: string[] = [];
    s.clients.add(fakeClient(chunks));
    let finished = false;
    const fn = makeReconfigure(s, agent, async () => {
      await new Promise((r) => setTimeout(r, 30));
      finished = true;
    });

    await fn({} as AppConfig);
    // Ответ (reconfigure) уже ушёл, а рефреш ещё в пути: события ещё нет.
    expect(finished).toBe(false);
    expect(chunks.join("")).not.toContain("event: models");

    await waitFor(() => chunks.join("").includes("event: models"));
    expect(finished).toBe(true);
  });

  it("re-broadcasts `config` when the probe adjusted the context window", async () => {
    const s = createWebUiState();
    const chunks: string[] = [];
    s.clients.add(fakeClient(chunks));
    const probedConfig = { contextWindow: 1000 } as AppConfig;
    const probingAgent = {
      reconfigure: (config: AppConfig) => {
        config.contextWindow = 2000;
      },
      contextManager: { getBudget: () => ({ history: 100 }) },
    };
    const fn = makeReconfigure(s, probingAgent, () => {});

    await fn(probedConfig);

    await waitFor(() => chunks.join("").includes("event: models"));
    expect(chunks.join("")).toContain("event: config");
  });

  it("wires the browser `models` handler to a model reload (B7)", () => {
    const src = readFileSync(join(REPO_ROOT, "src/modules/webui/assets/js/sse.ts"), "utf-8");
    expect(src).toContain('es.addEventListener("models"');
    const handler = src.slice(src.indexOf('es.addEventListener("models"'));
    expect(handler.slice(0, 200)).toContain("loadModels()");
  });
});
