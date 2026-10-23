import { describe, it, expect, vi } from "vitest";
import { CriticClient } from "../../../src/modules/critic/client";
import type { EvidencePack } from "../../../src/modules/critic/types";
import type { LLMProvider } from "../../../src/llm/provider";
import { DEFAULTS } from "../../../src/config/defaults";
import { LLM_REQUEST_TIMEOUT_MS } from "../../../src/config/timeouts";

/** Пауза, уважающая отмену: провайдер обязан реагировать на abort, иначе таймаут не проверить. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Провайдер, отдающий заскриптованные тексты по одному на вызов chat(). */
function scripted(
  texts: string[],
  opts: { delayMs?: number; seenMaxTokens?: number[] } = {},
): LLMProvider & { calls: { n: number } } {
  const calls = { n: 0 };
  return {
    calls,
    model: "m",
    contextWindow: 1000,
    countTokens: () => 0,
    listModels: async () => [],
    async *chat(_m, _t, signal, options) {
      const i = calls.n++;
      opts.seenMaxTokens?.push((options?.maxTokens as number) ?? 0);
      if (opts.delayMs) await sleep(opts.delayMs, signal);
      yield { type: "text" as const, content: texts[Math.min(i, texts.length - 1)] };
      yield { type: "done" as const };
    },
  };
}

/** Провайдер, падающий на каждом вызове. */
function throwing(): LLMProvider {
  return {
    model: "m",
    contextWindow: 1000,
    countTokens: () => 0,
    listModels: async () => [],
    // eslint-disable-next-line require-yield
    async *chat() {
      throw new Error("boom");
    },
  };
}

/** Пакет доказательств: 40 вызовов тулов по ~300 символов вывода (реалистичный длинный ход). */
function bigPack(): EvidencePack {
  const digest = Array.from(
    { length: 40 },
    (_, i) => `web_search[${i}] ${"x".repeat(280)}`,
  ).join("\n");
  return {
    task: "собрать лендинг",
    changedFiles: [],
    commands: [],
    toolDigest: digest,
  };
}

const concern =
  '{"status":"concern","summary":"gap","issues":[{"severity":"concern","claim":"c","problem":"p"}]}';
const wantCheck =
  '{"status":"concern","summary":"gap","issues":[],"checks":[{"tool":"read_file","args":{"path":"a.ts"}}]}';
const finalOk = '{"status":"ok","summary":"verified fine","issues":[]}';

describe("CriticClient degraded observability (§5.8, §1.10)", () => {
  it("logs critic_degraded instead of silently passing when the verdict is unparseable", async () => {
    const logs: string[] = [];
    const client = new CriticClient({
      provider: scripted(["Looks fine to me, nothing to add."]),
      onDiagnostic: (m) => logs.push(m),
    });
    expect(await client.verify(bigPack())).toBeNull();
    expect(logs.some((l) => l.includes("critic_degraded"))).toBe(true);
  });

  it("logs critic_degraded when jsonrepair rescues a truncated verdict into a false ok", async () => {
    // Обрезанный по maxTokens вердикт не разбирается, а чинится: verdict
    // получается валидным, но это НЕ то, что модель сказала. Раньше это
    // проходило как молчаливый pass.
    const logs: string[] = [];
    const client = new CriticClient({
      provider: scripted(['{"status":"ok","summary":"fine","iss']),
      onDiagnostic: (m) => logs.push(m),
    });
    const verdict = await client.verify(bigPack());
    expect(verdict?.status).toBe("ok");
    expect(logs.some((l) => l.includes("critic_degraded"))).toBe(true);
  });

  it("logs critic_degraded when the provider throws", async () => {
    const logs: string[] = [];
    const client = new CriticClient({ provider: throwing(), onDiagnostic: (m) => logs.push(m) });
    expect(await client.verify(bigPack())).toBeNull();
    expect(logs.some((l) => l.includes("critic_degraded"))).toBe(true);
  });

  it("logs critic_degraded when a later pass of the check loop breaks", async () => {
    const logs: string[] = [];
    const client = new CriticClient({
      provider: scripted([concern, wantCheck, "garbage!!!"]),
      onDiagnostic: (m) => logs.push(m),
    });
    const verdict = await client.verify(bigPack(), undefined, {
      runCheck: async () => ({ ok: true, output: "x" }),
    });
    // Fail-open к вердикту прохода 1 — но об обрыве обязаны знать.
    expect(verdict?.status).toBe("concern");
    expect(logs.some((l) => l.includes("critic_degraded"))).toBe(true);
  });

  it("does not log degradation when the verdict parses cleanly", async () => {
    const logs: string[] = [];
    const client = new CriticClient({
      provider: scripted(['{"status":"ok","summary":"fine","issues":[]}']),
      onDiagnostic: (m) => logs.push(m),
    });
    expect((await client.verify(bigPack()))?.status).toBe("ok");
    expect(logs.filter((l) => l.includes("critic_degraded"))).toHaveLength(0);
  });
});

describe("CriticClient budget (§5.8)", () => {
  it("gives each LLM call its own timeout, not one budget for the whole chain", async () => {
    // Три прохода по 40мс при timeoutMs=60: общий бюджет истёк бы на втором
    // проходе, per-call — нет.
    const provider = scripted([concern, wantCheck, finalOk], { delayMs: 40 });
    const client = new CriticClient({
      provider,
      timeoutMs: 60,
      onDiagnostic: () => {},
    });
    const verdict = await client.verify(bigPack(), undefined, {
      runCheck: async () => ({ ok: true, output: "x" }),
    });
    expect(provider.calls.n).toBe(3);
    expect(verdict?.summary).toBe("verified fine");
  });

  it("still aborts a single hanging call at timeoutMs", async () => {
    const provider = scripted([finalOk], { delayMs: 500 });
    const logs: string[] = [];
    const client = new CriticClient({
      provider,
      timeoutMs: 30,
      onDiagnostic: (m) => logs.push(m),
    });
    expect(await client.verify(bigPack())).toBeNull();
    expect(logs.some((l) => l.includes("critic_degraded"))).toBe(true);
    // Таймер виден как call_timeout, а не только как невнятный llm_error/abort.
    expect(logs.some((l) => l.includes("call_timeout"))).toBe(true);
  });

  it("bounds a call even when the provider ignores the abort signal", async () => {
    // Живой случай аудита: поток LM Studio не реагирует на signal и отдаёт
    // «terminated» только через 83–120 с при timeoutMs=15000. Дедлайн обязан
    // выигрывать гонку сам, не надеясь на провайдера.
    const logs: string[] = [];
    const provider: LLMProvider = {
      model: "m",
      contextWindow: 1000,
      countTokens: () => 0,
      listModels: async () => [],
      // eslint-disable-next-line require-yield
      async *chat() {
        await new Promise(() => {}); // не слушает signal и не завершается
        yield { type: "done" as const };
      },
    };
    const client = new CriticClient({ provider, timeoutMs: 40, onDiagnostic: (m) => logs.push(m) });
    const started = Date.now();
    expect(await client.verify(bigPack())).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
    // Причина — таймаут, и она не затёрта вторичным llm_error.
    expect(logs.filter((l) => l.includes("call_timeout")).length).toBe(1);
    expect(logs.some((l) => l.includes("llm_error"))).toBe(false);
  });

  it("the default timeout reaches call_timeout, not the provider deadline (W2)", async () => {
    // Предыдущий тест берёт выдуманные 30 мс: он доказывает, что ветка есть,
    // но не то, что она достижима с ДЕФОЛТА. Пока `critic.timeoutMs` равнялся
    // `LLM_REQUEST_TIMEOUT_MS`, обёртка всегда проигрывала гонку провайдеру, и
    // `call_timeout` не мог появиться в бою ни разу — при зелёном тесте.
    const defaultTimeout = DEFAULTS.critic.timeoutMs;
    expect(defaultTimeout).toBeGreaterThan(LLM_REQUEST_TIMEOUT_MS);
    // Фейковые часы: дефолт — это 125 секунд реального ожидания, а лимит
    // теста — 5. `advanceTimersByTimeAsync` в раннере Bun-vitest отсутствует,
    // поэтому прокручиваем синхронно и даём промису разобраться через microtask.
    vi.useFakeTimers();
    try {
      const provider = scripted([finalOk], { delayMs: defaultTimeout + 1000 });
      const logs: string[] = [];
      const client = new CriticClient({ provider, onDiagnostic: (m) => logs.push(m) });
      const pending = client.verify(bigPack());
      await Promise.resolve();
      vi.advanceTimersByTime(defaultTimeout + 10);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(await pending).toBeNull();
      expect(logs.some((l) => l.includes("call_timeout"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults maxTokens high enough to hold a verdict with issues", async () => {
    const seen: number[] = [];
    const client = new CriticClient({ provider: scripted([finalOk], { seenMaxTokens: seen }) });
    await client.verify(bigPack());
    expect(seen[0]).toBeGreaterThanOrEqual(2048);
  });

  it("honours an explicit maxTokens override", async () => {
    const seen: number[] = [];
    const client = new CriticClient({
      provider: scripted([finalOk], { seenMaxTokens: seen }),
      maxTokens: 4096,
    });
    await client.verify(bigPack());
    expect(seen[0]).toBe(4096);
  });
});
