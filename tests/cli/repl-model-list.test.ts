/**
 * P1: `/model list` обязан спрашивать АКТИВНУЮ запись `provider.entries[]`,
 * а не плоские `provider.baseUrl/apiKey` — они протухают после `/provider use`,
 * и список моделей приходил от чужого эндпоинта.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Repl } from "../../src/cli/repl";
import type { LLMProvider } from "../../src/llm/provider";
import { makeCaptureChannel, type CaptureChannel } from "./capture-channel";
import { makeBareRepl, stubAgent, stubConfig } from "./repl-fixtures";

const ACTIVE_MODEL = "beta-model";

describe("/model list uses the active provider entry (P1)", () => {
  let dir: string;
  let capture: CaptureChannel;
  let repl: Repl | undefined;

  beforeEach(() => {
    process.env.MMA_DSR = "0";
    dir = mkdtempSync(join(tmpdir(), "mma-model-list-"));
    capture = makeCaptureChannel();
  });

  afterEach(() => {
    (repl as unknown as { rl?: { close?: () => void } } | undefined)?.rl?.close?.();
    repl = undefined;
    capture.channel.dispose();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MMA_DSR;
  });

  it("probes entries[active] and renders its models", async () => {
    const calls: string[] = [];
    const provider = {
      model: "m1",
      contextWindow: 8000,
      countTokens: () => 0,
      listModels: async () => [ACTIVE_MODEL],
      chat: async function* () {},
    } as unknown as LLMProvider;
    const agent = stubAgent({
      getProviderFor: (name: string) => {
        calls.push(name);
        return provider;
      },
    });
    const config = {
      ...(stubConfig() as unknown as Record<string, unknown>),
      model: "m1",
      provider: {
        // Плоские поля намеренно указывают в никуда: до фикса из них собирался
        // провайдер и `/model list` ходил не к активной записи.
        type: "openai-compat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        active: "beta",
        entries: [
          { type: "openai-compat", label: "alpha", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
          { type: "openai-compat", label: "beta", baseUrl: "http://beta/v1", apiKey: "k" },
        ],
      },
    };

    repl = makeBareRepl({
      channel: capture.channel,
      historyPath: join(dir, "repl-history"),
      agent,
      config,
    });

    // Сбрасываем вызовы конструктора (фоновый прогрев кеша моделей): проверяем
    // именно путь команды.
    calls.length = 0;
    await repl.executeCommand("/model list");

    expect(calls.length).toBeGreaterThan(0);
    expect([...new Set(calls)]).toEqual(["beta"]);
    expect(capture.out.data).toContain(ACTIVE_MODEL);
  });
});
