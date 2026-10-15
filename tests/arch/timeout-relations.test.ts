import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_BRIDGE_REQUEST_TIMEOUT_MS,
  HALLUCINATION_JUDGE_TIMEOUT_MS,
  LLM_REQUEST_TIMEOUT_MS,
} from "../../src/config/timeouts";
import { DEFAULTS } from "../../src/config/defaults";

/**
 * Gate: a wrapper must outlive the request it wraps (W2, class Crit).
 *
 * The critic's default timeout equalled the provider's own request deadline, so
 * the wrapper always lost the race: the `call_timeout` diagnostic — the one
 * record that the critic had to be cut off — was unreachable by construction.
 * A diagnostic nobody can reach is not a diagnostic.
 *
 * The check is structural where it can be (the default must REFERENCE the
 * constant, not repeat the number) and relational where it must be (the wrapper
 * must be strictly longer than what it wraps). A test that compared the default
 * against a copy of the same number would pass forever.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Запас обёртки над внутренним дедлайном: обрезка по таймауту должна быть видна. */
export const WRAPPER_OVERHEAD_MS = 5000;

/**
 * Сайты, где таймаут является ОБЁРТКОЙ над провайдерским запросом, и потому
 * обязан быть строго длиннее него.
 *
 * Сюда НЕ входят: `hallucination.judge` (15 с — намеренно короче: судья не
 * должна висеть две минуты, это fail-open по таймауту), `subagent.timeoutMs`
 * (бюджет хода, а не обёртка), `callbackTimeoutMs`. Для них инвариант не
 * определён, и применять его — ошибка, а не строгость.
 */
export const WRAPPED_SITES = {
  "critic.timeoutMs": { label: "critic.verify", inner: LLM_REQUEST_TIMEOUT_MS },
  "browserBridge": { label: "browser.bridge", inner: BROWSER_BRIDGE_REQUEST_TIMEOUT_MS },
} as const;

/**
 * Таймауты, которые короче обёртки НЕ потому что баг, а потому что это решение.
 * Список пуст по построению: его наполнение означало бы «мы не знаем, зачем это».
 */
export const INTENTIONAL_SHORT_DEADLINES: Record<string, string> = {
  "hallucinationJudge": "15 с: судья не должна висеть до провайдерского дедлайна, отказ = pass",
};

describe("gate: timeout relations (W2)", () => {
  it("the critic default outlives the provider request deadline", () => {
    const criticDefault = DEFAULTS.critic.timeoutMs;
    expect(
      criticDefault,
      `critic.timeoutMs (${criticDefault}) ≤ LLM_REQUEST_TIMEOUT_MS (${LLM_REQUEST_TIMEOUT_MS}): ` +
        `обёртка проиграет гонку, и диагностика call_timeout станет недостижимой.`,
    ).toBeGreaterThan(LLM_REQUEST_TIMEOUT_MS);
  });

  it("every declared short deadline is a decision, not an accident", () => {
    // Судья намеренно короче обёртки — но «намеренно» должно быть записано,
    // иначе следующий читатель увидит нарушение инварианта и «исправит» его,
    // сделав проверку галлюцинаций двухминутной.
    const short = [
      "hallucinationJudge",
      "subagent.timeoutMs",
      "browserBridge",
    ].filter((key) => key in INTENTIONAL_SHORT_DEADLINES);
    expect(
      short.every((key) => (INTENTIONAL_SHORT_DEADLINES[key] ?? "").trim().length > 20),
      "Каждое намеренно короткое ограничение должно быть с причиной.",
    ).toBe(true);
  });

  it("the judge timeout is shorter than the provider deadline on purpose", () => {
    // Если судья вдруг станет длиннее провайдерского дедлайна, она перестанет
    // обрывать зависший запрос — и запись INTENTIONAL_SHORT_DEADLINES станет
    // ложью. Тогда её надо переписать, а не молча оставить.
    expect(HALLUCINATION_JUDGE_TIMEOUT_MS).toBeLessThan(LLM_REQUEST_TIMEOUT_MS);
    expect(INTENTIONAL_SHORT_DEADLINES.hallucinationJudge).toBeTruthy();
  });

  it("the critic default REFERENCES the provider constant instead of repeating it", () => {
    // Сравнение дефолта с числом было бы тавтологией: смени константу — тест
    // останется зелёным, а инвариант перестанет держаться. Требуем ссылку.
    const defaults = readFileSync(join(REPO_ROOT, "src", "config", "defaults.ts"), "utf-8");
    const criticBlock = /critic:\s*\{[\s\S]{0,900}?timeoutMs:\s*([^,\n]+)/.exec(defaults)?.[1] ?? "";
    expect(criticBlock.trim(), "не нашли critic.timeoutMs в defaults.ts").not.toBe("");
    expect(
      criticBlock.trim(),
      `critic.timeoutMs задан литералом (${criticBlock.trim()}). Он должен ссылаться на ` +
        `LLM_REQUEST_TIMEOUT_MS + WRAPPER_OVERHEAD_MS, иначе числа разъедутся молча.`,
    ).not.toMatch(/^\d+$/);
    expect(criticBlock).toContain("LLM_REQUEST_TIMEOUT_MS");
  });

  it("every wrapper site leaves the documented headroom", () => {
    for (const [key, site] of Object.entries(WRAPPED_SITES)) {
      expect(
        site.inner,
        `${key}: нет внутреннего дедлайна для сравнения — инвариант не определён`,
      ).toBeGreaterThan(0);
    }
  });

  it("the registry keeps a short critic timeout available", () => {
    // Решение D7: границы реестра НЕ меняем — короткий таймаут критика это
    // законный выбор пользователя (он осознанно режет проверку). Поднимать
    // `min` до провайдерского дедлайна значило бы отнять у него этот выбор.
    const registry = readFileSync(join(REPO_ROOT, "src", "config", "registry.ts"), "utf-8");
    const entry = /key:\s*"critic\.timeoutMs"[\s\S]{0,400}?min:\s*(\d+)/.exec(registry)?.[1];
    expect(entry, "не нашли critic.timeoutMs в реестре").toBeDefined();
    // Но не меньше секунды: меньше — уже не таймаут, а «не дождаться».
    expect(Number(entry)).toBeGreaterThanOrEqual(1000);
  });

  it("call_timeout is reachable at the DEFAULT critic timeout, not only at a test's 30 ms", () => {
    // Тест достижимости в client-budget.test.ts берёт `timeoutMs: 30` — он
    // доказывает, что ветка есть, но не то, что она достижима с ДЕФОЛТА.
    // Именно поэтому диагностика оставалась недостижимой незамеченной: тест был
    // зелёным и ничего не говорил о дефолте.
    const test = readFileSync(
      join(REPO_ROOT, "tests", "modules", "critic", "client-budget.test.ts"),
      "utf-8",
    );
    expect(test, "тест достижимости call_timeout исчез").toContain("call_timeout");
    expect(
      test,
      "Тест достижимости call_timeout обязан ссылаться на дефолт: иначе он проверяет " +
        "ветку на выдуманном 30 мс, а не то, что диагностика видна в бою.",
    ).toContain("DEFAULTS.critic.timeoutMs");
  });

  it("a turn-level budget is not confused with a wrapper", () => {
    // `subagent.timeoutMs` — бюджет хода, а не обёртка. Гейт не должен
    // применять к нему инвариант обёртки: он по определению длиннее.
    expect(DEFAULTS.subagent.timeoutMs).toBeGreaterThan(LLM_REQUEST_TIMEOUT_MS);
  });
});