# Out-Of-Context Corpus — Wave W-a + W-b (Budget & Admission) Implementation Plan

> **Статус:** исполнено (2026-10-20) — Tasks 1–3 закрыты: `admitMaxTokens`, `src/tools/admission.ts`
> (спилл в `.mma/context/<session>/` с jail-проверкой), единственная точка применения
> в `src/tools/executor.ts`. Чекбоксы проставлены по факту. Долги
> `admission-spill-no-gc` / `descriptor-fields-deferred` / `admit-threshold-unmeasured`
> зарегистрированы в [`docs/agents/debt.md`](../agents/debt.md).

**Goal:** Крупные результаты тулов перестают попадать в корневой контекст дословно — вместо них дескриптор с превью и путём спилла (OO-1/OO-7 спеки `docs/specs/2026-10-14-out-of-context-corpus-design.md`).

**Architecture:** Один порог `contextBudget.admitMaxTokens`; одна точка применения — `ToolExecutor.execute()` (там есть `ctx.baseDir`/`ctx.sessionId`). Результат больше порога уходит в файл `.mma/context/<session>/` и заменяется дескриптором (handle + превью + размер). Это первая из волн; W-c (леджер/OO-8), W-d (`scan_corpus`/OO-9), W-e (инкрементальный вывод) — отдельные последующие планы.

**Tech Stack:** Bun + TypeScript (strict), vitest через `bun test`, Biome (`bun run lint`), i18n через `t()` (en/ru симметричны), `ArtifactStore`-паттерн (jail внутри root).

**Гейт каждой задачи:** `bun test <файл>` зелёный; в конце — `bun test` и `bun run quality` зелёные.

---

## File Structure

| Файл | Ответственность | Действие |
|---|---|---|
| `src/config/types.ts` | поле `admitMaxTokens` в `ContextBudget` | Modify |
| `src/config/defaults.ts` | дефолт `contextBudget.admitMaxTokens` | Modify |
| `src/config/registry-extra.ts` | ключ реестра `contextBudget.admitMaxTokens` | Modify |
| `src/tools/admission.ts` | `admitToolResult()` — спилл + дескриптор | Create |
| `src/tools/executor.ts` | вызов admission в `execute()` | Modify |
| `src/i18n/en.json`, `src/i18n/ru.json` | ключ `tool.output_admitted` | Modify |
| `tests/config-admit-tokens.test.ts` | W-a: дефолт + реестр | Create |
| `tests/tools/admission.test.ts` | W-b: `admitToolResult` | Create |
| `tests/tools/admission-executor.test.ts` | W-b: проводка в `ToolExecutor` | Create |

---

## Task 1: Config key `contextBudget.admitMaxTokens` (W-a)

**Files:**
- Modify: `src/config/types.ts` (интерфейс `ContextBudget`, рядом с `compactionThreshold`)
- Modify: `src/config/defaults.ts` (`contextBudget` блок)
- Modify: `src/config/registry-extra.ts` (рядом с `contextBudget.toolResultKeep`)
- Test: `tests/config-admit-tokens.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/config-admit-tokens.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import { getConfigValue, setConfigValue } from "../src/config/registry";
import type { AppConfig } from "../src/config/types";

describe("contextBudget.admitMaxTokens", () => {
  it("defaults to 3000 tokens", () => {
    expect(DEFAULT_CONFIG.contextBudget.admitMaxTokens).toBe(3000);
  });

  it("round-trips through the registry and rejects out-of-range", () => {
    const c = structuredClone(DEFAULT_CONFIG) as AppConfig;
    expect(getConfigValue(c, "contextBudget.admitMaxTokens").value).toBe(3000);
    expect(setConfigValue(c, "contextBudget.admitMaxTokens", "2000").ok).toBe(true);
    expect(getConfigValue(c, "contextBudget.admitMaxTokens").value).toBe(2000);
    expect(setConfigValue(c, "contextBudget.admitMaxTokens", "999999").ok).toBe(false);
    expect(setConfigValue(c, "contextBudget.admitMaxTokens", "0").ok).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/config-admit-tokens.test.ts`
Expected: FAIL — `DEFAULT_CONFIG.contextBudget.admitMaxTokens` is `undefined`; `getConfigValue(...).value` is `undefined` / key unresolved.

- [x] **Step 3: Add the field to `ContextBudget`**

In `src/config/types.ts`, inside `interface ContextBudget`, after `compactionThreshold: number;` add:

```ts
  /**
   * Порог admission (OO-1): результат тула в токенах, выше которого вывод НЕ
   * входит в контекст дословно, а заменяется дескриптором + спиллом. Дефолт 3000;
   * финальное значение — по замеру (спека §11). Не влияет на security-enforcement.
   */
  admitMaxTokens?: number;
```

- [x] **Step 4: Add the default**

In `src/config/defaults.ts`, inside the `contextBudget: { … }` object, after `toolResultKeep: 6,` add:

```ts
    admitMaxTokens: 3000,
```

- [x] **Step 5: Declare the registry key**

In `src/config/registry-extra.ts`, find the `int("contextBudget.toolResultKeep", …)` entry and add right after it:

```ts
  int("contextBudget.admitMaxTokens", "budget", 200, 8000, 100, true,
    (c) => c.contextBudget.admitMaxTokens ?? DEFAULTS.contextBudget.admitMaxTokens,
    (c, v) => { c.contextBudget.admitMaxTokens = v as number; }),
```

(`int` — существующая фабрика в этом файле; `reconfigure = true`, чтобы смена пересобирала контекст, как соседние `contextBudget.*` ключи.)

- [x] **Step 6: Run test to verify it passes**

Run: `bun test tests/config-admit-tokens.test.ts`
Expected: PASS (2 tests).

- [x] **Step 7: Typecheck and commit**

Run: `bun run typecheck`
Expected: no new errors.

```bash
git add src/config/types.ts src/config/defaults.ts src/config/registry-extra.ts tests/config-admit-tokens.test.ts
git commit -m "feat(config): contextBudget.admitMaxTokens (OO-1 threshold)"
```

---

## Task 2: `admitToolResult()` + i18n (W-b)

**Files:**
- Create: `src/tools/admission.ts`
- Modify: `src/i18n/en.json`, `src/i18n/ru.json` (ключ `tool.output_admitted`)
- Test: `tests/tools/admission.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/tools/admission.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitToolResult } from "../../src/tools/admission";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-admit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("admitToolResult", () => {
  it("passes small output through untouched", () => {
    const r = admitToolResult(
      { success: true, output: "hello" },
      { baseDir: dir, sessionId: "s1", maxTokens: 3000 },
    );
    expect(r.output).toBe("hello");
    expect(r.artifactPath).toBeUndefined();
  });

  it("spills large output and returns a descriptor with a preview", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const r = admitToolResult(
      { success: true, output: big },
      { baseDir: dir, sessionId: "s1", maxTokens: 3000, source: "big.txt" },
    );
    expect(r.output).not.toContain("line 4999");
    expect(r.output).toContain("big.txt");
    expect(r.output).toContain("line 0");
    expect(r.artifactPath).toBeTruthy();
    expect(readFileSync(r.artifactPath as string, "utf8")).toBe(big);
  });

  it("does not admit failed results", () => {
    const big = "x".repeat(100000);
    const r = admitToolResult(
      { success: false, output: big },
      { baseDir: dir, sessionId: "s1", maxTokens: 100 },
    );
    expect(r.output).toBe(big);
    expect(r.artifactPath).toBeUndefined();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/admission.test.ts`
Expected: FAIL — `Cannot find module "../../src/tools/admission"`.

- [x] **Step 3: Implement the module**

```ts
// src/tools/admission.ts
// Admission результата тула (OO-1): крупный вывод не входит в контекст
// дословно — спилл в .mma/context/<session>/ + дескриптор с превью и путём.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { estimateTokens } from "../llm/token-counter";
import { t } from "../i18n/index";
import type { ToolResult } from "./types";

/** Сколько первых строк вывода оставить в превью дескриптора. */
const PREVIEW_LINES = 12;
/** Каталог спилла относительно baseDir. */
const DEFAULT_SPILL_DIR = ".mma/context";

export interface AdmitOptions {
  /** Корень проекта (jail для спилла). */
  baseDir: string;
  /** id сессии — подкаталог спилла. */
  sessionId: string;
  /** Порог в токенах; результат выше него допускается только дескриптором. */
  maxTokens: number;
  /** Исходный путь, если результат пришёл из файлового тула (для проверяемости). */
  source?: string;
  /** Каталог спилла относительно baseDir. Дефолт: .mma/context. */
  spillDir?: string;
}

/**
 * Если результат тула превышает `maxTokens`, спиллить полный вывод в файл и
 * вернуть дескриптор (превью + размер + путь). Иначе — вернуть как есть.
 * Идемпотентно для уже admitted результатов (дескриптор мал → no-op).
 */
export function admitToolResult(result: ToolResult, opts: AdmitOptions): ToolResult {
  const output = result.output ?? "";
  if (!result.success || !output) return result;
  const tokens = estimateTokens(output);
  if (tokens <= opts.maxTokens) return result;

  const dir = resolve(opts.baseDir, opts.spillDir ?? DEFAULT_SPILL_DIR, opts.sessionId);
  mkdirSync(dir, { recursive: true });
  const artifact = join(dir, `${Date.now().toString(36)}.txt`);
  writeFileSync(artifact, output, "utf8");

  const lines = output.split("\n").length;
  const preview = output.split("\n").slice(0, PREVIEW_LINES).join("\n");
  const descriptor = t("tool.output_admitted", {
    tokens: String(tokens),
    lines: String(lines),
    artifact,
    source: opts.source ?? "-",
    preview,
  });
  return { ...result, output: descriptor, artifactPath: artifact };
}
```

- [x] **Step 4: Add i18n keys (both locales, symmetric)**

In `src/i18n/en.json`, under the `tool` object (next to `"tool.truncated"`):

```jsonc
"tool.output_admitted": "[output omitted: {tokens} tokens, {lines} lines — too large for context]\nSaved to: {artifact}\nSource: {source}\nPreview:\n{preview}\nInspect it with read_file (offset/limit) or chunk_query on the saved path.",
```

In `src/i18n/ru.json`, under `tool`:

```jsonc
"tool.output_admitted": "[вывод скрыт: {tokens} токенов, {lines} строк — слишком большой для контекста]\nСохранено: {artifact}\nИсточник: {source}\nПревью:\n{preview}\nСмотри через read_file (offset/limit) или chunk_query по сохранённому пути.",
```

- [x] **Step 5: Run test + i18n parity**

Run: `bun test tests/tools/admission.test.ts tests/i18n.test.ts`
Expected: PASS (3 admission tests + parity green).

- [x] **Step 6: Typecheck and commit**

Run: `bun run typecheck`
Expected: no new errors.

```bash
git add src/tools/admission.ts src/i18n/en.json src/i18n/ru.json tests/tools/admission.test.ts
git commit -m "feat(tools): admitToolResult — spill oversized output, return descriptor (OO-1)"
```

---

## Task 3: Wire admission into `ToolExecutor.execute()` (W-b)

**Files:**
- Modify: `src/tools/executor.ts` (импорт + один блок в `execute()`)
- Test: `tests/tools/admission-executor.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/tools/admission-executor.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-exec-admit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeExecutor(output: string) {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: "big_tool",
      description: "returns a big output",
      parameters: { type: "object", properties: {} },
      security: { caps: [] },
      handler: async () => ({ success: true, output }),
    },
    "test",
  );
  const ctx = {
    config: { contextBudget: { admitMaxTokens: 100 } },
    baseDir: dir,
    sessionId: "s1",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      logToolCall: () => {},
      logToolOutput: () => {},
    },
  };
  const pluginManager = { getAllPlugins: () => [] };
  return { executor: new ToolExecutor(registry, ctx as any, pluginManager as any), registry };
}

describe("ToolExecutor admission", () => {
  it("spills oversized tool output and returns a descriptor", async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `row ${i}`).join("\n");
    const { executor } = makeExecutor(big);
    const res = await executor.execute({ id: "1", name: "big_tool", arguments: {} });
    expect(res.artifactPath).toBeTruthy();
    expect(res.output).not.toContain("row 3999");
    expect(readFileSync(res.artifactPath as string, "utf8")).toBe(big);
  });

  it("leaves small tool output unchanged", async () => {
    const { executor } = makeExecutor("tiny");
    const res = await executor.execute({ id: "2", name: "big_tool", arguments: {} });
    expect(res.output).toBe("tiny");
    expect(res.artifactPath).toBeUndefined();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/admission-executor.test.ts`
Expected: FAIL — `res.artifactPath` is `undefined` (admission ещё не подключён).

- [x] **Step 3: Import the helper**

In `src/tools/executor.ts`, next to the other local imports at the top (после `import { filterToolsByTags } from "./filter-tools";`) add:

```ts
import { admitToolResult } from "./admission";
```

- [x] **Step 4: Apply admission in `execute()`**

In `src/tools/executor.ts`, inside `async execute(...)`, immediately after the `try/catch` that produces `result` (the block ending with `result.toolCallId = call.id;` and the `catch` that sets `result = { success: false, … }`), BEFORE the `if (!memoHit) { … }` block, insert:

```ts
    // Admission (OO-1/OO-7): результат больше admitMaxTokens не входит в
    // контекст дословно — спилл + дескриптор. Одна точка для всех тулов;
    // хендлер политику не реализует. Мемо ниже сохраняет уже admitted результат.
    result = admitToolResult(result, {
      baseDir: this.ctx.baseDir,
      sessionId: this.ctx.sessionId ?? "default",
      maxTokens: this.ctx.config.contextBudget.admitMaxTokens ?? 3000,
      source:
        typeof call.arguments?.path === "string" ? String(call.arguments.path) : undefined,
    });
```

- [x] **Step 5: Run test to verify it passes**

Run: `bun test tests/tools/admission-executor.test.ts`
Expected: PASS (2 tests).

- [x] **Step 6: Full suite + quality gate**

Run: `bun test`
Expected: green (нет падений существующих тестов; если падает `read_file`-тест из-за порога 3000 — поднять дефолт `admitMaxTokens` в Task 1 и повторить; это тот самый замер из спеки §11).

Run: `bun run quality`
Expected: exit 0.

- [x] **Step 7: Commit**

```bash
git add src/tools/executor.ts tests/tools/admission-executor.test.ts
git commit -m "feat(executor): apply admission at ToolExecutor.execute (OO-1/OO-7)"
```

---

## Self-Review

**Спека → план:**
- OO-1 (недопуск) — Task 2 + Task 3. ✅
- OO-7 (один вход сырья) — Task 3 (единственная точка в `execute()`), тест «small unchanged». ✅
- §5 бюджет (`admitMaxTokens`; резерв тулов уже измеряется) — Task 1. ✅
- §5 `budgetBreakdown` — отмечен в спеке как опциональная отдельная задача, здесь намеренно нет. ✅
- OO-2/3/4/5/6/8/9 — волны W-c…W-e, отдельные планы (заявлено в шапке). ✅

**Placeholder scan:** нет TBD/TODO; каждый шаг несёт код/команду/ожидаемый вывод.

**Type consistency:** `admitMaxTokens` (поле `ContextBudget`) и ключ реестра `contextBudget.admitMaxTokens` — совпадают; `AdmitOptions` (`baseDir/sessionId/maxTokens/source/spillDir`) одинаков в Task 2 и Task 3; `admitToolResult(result, opts)` → `ToolResult` (использован переприсваиванием `result = …` — тип сохраняется).

**Известное допущение:** `ToolRegistry.register(def, owner)` и конструктор `ToolExecutor(registry, ctx, pluginManager)` — по `tests/registry.test.ts` и `src/tools/executor.ts:65`. Если сигнатура иная — Task 3 тест правится, поведение не меняется.

---

## Execution Handoff

После прохождения всех задач — два варианта исполнения:

1. **Subagent-Driven (рекомендуется)** — свежий субагент на задачу, ревью между задачами.
2. **Inline** — выполнять в этой сессии с чекпоинтами.

Следующие планы: **W-c** (леджер + OO-8, трогает `manager.ts:buildCompactionBlock`), **W-d** (`scan_corpus` + OO-9), **W-e** (инкрементальный вывод).
