import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Gate: механизм reasoning — свойство ПРОВАЙДЕРА, не опция вызова (W3.1, INV-R1).
 *
 * Раньше `ChatOptions.reasoningStrategy` проезжала через каждый call-site, а при
 * отсутствии `buildRequestBody` молча брал `"openai-effort"`. Забыл call-site —
 * получил чужой механизм (модель без API-поддержки «думала» и жгла cap).
 * Теперь стратегия резолвится при СБОРКЕ провайдера; вызов несёт только уровень.
 *
 * Гейт статический: контракт (`ChatOptions`) и отсутствие per-call чтения.
 * Поведение (стратегия из конструктора доходит до тела запроса) закрывает
 * `tests/openai-compat-reasoning.test.ts`.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PROVIDER_TS = join(REPO_ROOT, "src", "llm", "provider.ts");
const OPENAI_COMPAT = join(REPO_ROOT, "src", "llm", "openai-compat.ts");
const SRC = join(REPO_ROOT, "src");

/** Тело интерфейса `ChatOptions` из исходника (экспорт — для позитивного контроля). */
export function chatOptionsBody(source: string): string {
  return /export interface ChatOptions\s*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
}

/** Читает поле `reasoningStrategy` из опций вызова (запрещённый шаблон). */
export const PER_CALL_READ_RE = /\boptions\??\.reasoningStrategy\b/g;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walk(join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(join(dir, entry.name));
  }
}

describe("gate: reasoning strategy lives on the provider, not the call (W3.1)", () => {
  const srcFiles: string[] = [];
  walk(SRC, srcFiles);

  it("parses ChatOptions in a fixture (positive control)", () => {
    expect(chatOptionsBody("export interface ChatOptions {\n  maxTokens?: number;\n}")).toContain(
      "maxTokens",
    );
    expect(chatOptionsBody("export interface Other {\n  reasoningStrategy?: string;\n}")).not.toContain(
      "maxTokens",
    );
  });

  it("ChatOptions carries the level, not the mechanism", () => {
    const body = chatOptionsBody(readFileSync(PROVIDER_TS, "utf-8"));
    expect(body, "не нашли ChatOptions в provider.ts").toContain("reasoningEffort");
    expect(
      body,
      "`reasoningStrategy` вернулась в ChatOptions: call-site снова может её " +
        "передать или забыть. Механизм обязан резолвиться при сборке провайдера (INV-R1).",
    ).not.toContain("reasoningStrategy");
  });

  it("no call-site reads a per-call strategy", () => {
    const offenders: string[] = [];
    for (const file of srcFiles) {
      const text = readFileSync(file, "utf-8");
      PER_CALL_READ_RE.lastIndex = 0;
      const n = (text.match(PER_CALL_READ_RE) ?? []).length;
      if (n > 0) offenders.push(`${relative(REPO_ROOT, file).replace(/\\/g, "/")} (${n})`);
    }
    expect(
      offenders,
      `Per-call чтение стратегии вернулось — механизм снова зависит от вызывающего:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the provider fixes the strategy at construction", () => {
    const source = readFileSync(OPENAI_COMPAT, "utf-8");
    expect(
      source,
      "Провайдер не фиксирует стратегию при сборке — тело запроса снова возьмёт дефолт.",
    ).toContain('reasoningStrategy ?? "openai-effort"');
    expect(
      source,
      "Тело запроса не берёт стратегию из экземпляра.",
    ).toContain("reasoningStrategy: this.reasoningStrategy");
  });
});
