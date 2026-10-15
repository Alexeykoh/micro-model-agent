import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionLogger } from "../../src/core/session-logger";

/**
 * Gate: provenance in `session.jsonl` (W11, INV-13).
 *
 * На боевой сессии `source` стоял у 14% записей — событие нельзя связать с
 * автором, а «источник не записали» неотличимо от «источника нет». Хуже: поле
 * `source` использовалось сразу для трёх разных смыслов (provenance, origin
 * измерения usage, origin reasoning-политики), поэтому типизировать его было
 * нельзя — `llm_usage` писал туда `"api"`, не входящее в `Source`.
 *
 * Гейт проверяет контракт, а не формулировку: поле обязательно и типизировано,
 * закрытый союз `type` не имеет открытых шаблонов, каждый писатель в `src/`
 * проставляет `source`, а runtime-прогон через logger даёт 100% атрибуцию.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SRC = join(REPO_ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "assets") continue; // фронтенд — отдельный tsconfig
      walk(p, out);
    } else if (name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Тела вызовов `appendLog({...})` / `appendSessionLog({...})`: от `{` до
 * парной `}`. Сканер игнорирует строки/шаблоны/комментарии, иначе `}` внутри
 * текста ломает подсчёт вложенности.
 */
function logCallBodies(src: string): string[] {
  const bodies: string[] = [];
  const re = /append(?:Session)?Log\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let i = start;
    let inStr: string | null = null;
    let line = false;
    let block = false;
    for (; i < src.length; i++) {
      const c = src[i];
      const n = src[i + 1];
      if (line) {
        if (c === "\n") line = false;
        continue;
      }
      if (block) {
        if (c === "*" && n === "/") {
          block = false;
          i++;
        }
        continue;
      }
      if (inStr) {
        if (c === "\\") {
          i++;
          continue;
        }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === "/" && n === "/") {
        line = true;
        i++;
        continue;
      }
      if (c === "/" && n === "*") {
        block = true;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    bodies.push(src.slice(start + 1, i));
  }
  return bodies;
}

const storeSrc = readFileSync(join(SRC, "modules", "session", "store.ts"), "utf-8");

describe("gate: session provenance (W11)", () => {
  it("the schema makes `source` mandatory and typed as Source", () => {
    // Обязательное поле — компилятор ловит забытый `source` на любом писателе.
    expect(storeSrc, "`source` снова стал опциональным").toMatch(/\bsource:\s*Source;/);
    expect(storeSrc, "`source?:` вернулся — атрибуция снова необязательна").not.toMatch(
      /\bsource\?:\s*string/,
    );
  });

  it("the closed `type` union has no open template literal", () => {
    // `onboarding_${string}`/`module_${string}` пропускали любую опечатку в
    // имени события мимо типов. Внутри союза `type` шаблонов быть не должно.
    const union =
      /export interface SessionLogEntry \{([\s\S]*?)module\?:/.exec(storeSrc)?.[1] ?? "";
    expect(union, "не нашли союз `type` в store.ts").not.toBe("");
    expect(union, "в союзе `type` вернулся открытый шаблон `${string}`").not.toContain("${string}");
    expect(storeSrc, "события онбординга снова не перечислены явно").toContain(
      "OnboardingEvent",
    );
  });

  it("usage origin is not smuggled into the provenance field", () => {
    // `llm_usage` писал origin измерения (`api`/`estimate`) в `source`, из-за
    // чего provenance нельзя было типизировать. Origin измерения/решения —
    // отдельное поле `origin`, а `source` остаётся provenance.
    expect(storeSrc, "origin измерения снова общий с provenance").toContain("origin?:");
  });

  it("every writer in src/ sets `source` on its log entry", () => {
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf-8");
      for (const body of logCallBodies(src)) {
        if (!/\bsource\s*:/.test(body)) {
          missing.push(`${relative(REPO_ROOT, file)}: ${body.trim().slice(0, 60)}…`);
        }
      }
    }
    expect(
      missing,
      `Записи лога без source (INV-13):\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("the fixture anonymiser preserves provenance instead of dropping it", () => {
    // `source`/`module` — не персональные данные: это `core`/`module:x`/`tool:x`.
    // Вырезая их, обезличенная фикстура теряет единственную нить к автору
    // события, и по ней нельзя проверить атрибуцию.
    const builder = readFileSync(join(REPO_ROOT, "scripts", "build-session-fixture.ts"), "utf-8");
    expect(builder, "фикстура снова теряет provenance при обезличивании").toMatch(
      /KEEP\s*=\s*new Set\(\[[\s\S]*?"source"[\s\S]*?"module"[\s\S]*?\]\)/,
    );
  });
});

describe("gate: session provenance — runtime (W11)", () => {
  /** Логгер над поддельной сессией: пишем и смотрим, что реально попало в лог. */
  function harness() {
    const logs: Array<Record<string, unknown>> = [];
    const session = {
      getActiveMeta: () => ({ id: "ses_1" }),
      getSessionDirectory: () => "/tmp/nonexistent-mma-ses",
      appendLog: (e: Record<string, unknown>) => logs.push(e),
      appendMessage: () => {},
    } as never;
    return { logger: new SessionLogger(session), logs };
  }

  it("every event type carries a provenance source", () => {
    const { logger, logs } = harness();
    logger.logSystem("t");
    logger.logUser("t");
    logger.logAssistant("a", "r", [{ id: "c", name: "bash", arguments: {} }], 1);
    logger.logToolDefs(1, ["bash"], 1);
    logger.logToolCall({ id: "c", name: "bash", arguments: {} }, 1);
    logger.logToolResult({ id: "c", name: "bash", arguments: {} }, { success: true, output: "x" }, 1, 1);
    logger.logCompaction({ reason: "overflow", iteration: 1 });
    logger.logContext({
      kind: "start",
      iteration: 1,
      tokens: 1,
      quality: 1,
      messageCount: 1,
      compactionCount: 0,
      iterationsSinceCompaction: 1,
    });
    logger.logLlmUsage(1, {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      source: "api",
      durationMs: 1,
    });
    logger.logAudit("ok", 1);
    logger.logPlan("create", "detail", 1);
    logger.logSessionStart({});
    logger.logReasoningControl({ iteration: 1, level: "low", source: "probe" });
    logger.logOnboarding("meet_done", { model: "m" });
    logger.logClaimRetry({ kind: "success", reason: "r", iteration: 1 });
    logger.logCritic("critic_verdict", { summary: "s" });

    expect(logs.length).toBeGreaterThan(10);
    const unattributed = logs.filter(
      (e) => typeof e.source !== "string" || e.source.length === 0,
    );
    expect(
      unattributed.map((e) => e.type),
      "записи без provenance в прогоне через logger",
    ).toEqual([]);
  });

  it("a module diagnostic carries its module name, not only the prefixed source", () => {
    const { logger, logs } = harness();
    logger.logDiagnosticEvent("verify_error", {
      source: "module:execution",
      operation: "verify.syntax",
      kind: "skipped",
      cause: "tsc not found",
    });
    expect(logs[0].source).toBe("module:execution");
    // `module` без префикса — чтобы запись группировалась по владельцу (INV-13).
    expect(logs[0].module).toBe("execution");
  });

  it("the usage origin lives in origin, not in provenance", () => {
    const { logger, logs } = harness();
    logger.logLlmUsage(1, {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      source: "estimate",
      durationMs: 1,
    });
    expect(logs[0].source).toBe("core");
    expect(logs[0].origin).toBe("estimate");
  });
});
