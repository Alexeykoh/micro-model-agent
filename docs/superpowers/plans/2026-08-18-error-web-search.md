# Error Web Search (авто-поиск ошибки) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Когда одна и та же ошибка повторяется ≥ 5 раз, плагин `execution` сам ищет её в интернете (DuckDuckGo) и инжектит результаты в контекст — не блокируя цикл, с лимитами и мастер-выключателем.

**Architecture:** `StuckDetector` получает подсчёт сигнатур ошибок (`тул::нормализованный_текст`) и helpers для построения запроса; из `web-search.ts` выносится общая `performWebSearch()` + мастер-выключатель `webSearch.enabled`; `ExecutionModule.maybeSearchError()` запускает fire-and-forget поиск из `onAfterTool` и кладёт результат в `pendingMessages`.

**Tech Stack:** Bun + TypeScript, vitest (`bun test`), конфиг 3-слойный (defaults→global→project), i18n `t()` (en+ru).

**Spec:** `docs/specs/2026-08-18-error-web-search-design.md`

---

## File Structure

| Файл                                        | Действие | Ответственность                                                           |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `src/config/types.ts`                       | Modify   | `WebSearchConfig` + `ErrorWebSearchConfig` + поля в `AppConfig`           |
| `src/config/defaults.ts`                    | Modify   | значения по умолчанию                                                     |
| `src/modules/execution/stuck-detector.ts`   | Modify   | счётчик сигнатур, `isSearchableError`, `buildSearchQuery`, searched-флаги |
| `src/tools/web-search.ts`                   | Modify   | `performWebSearch()` + `SearchResult`, мастер-выключатель в туле          |
| `src/modules/execution/module.ts`           | Modify   | `maybeSearchError()`, DI `searchRunner`, поля сессии                      |
| `src/modules/execution/execution-plugin.ts` | Modify   | вызов `maybeSearchError` из `onAfterTool`                                 |
| `src/core/bootstrap.ts`                     | Modify   | проброс `errorWebSearch.threshold` в `ExecutionModule`                    |
| `src/i18n/en.json`, `src/i18n/ru.json`      | Modify   | 4 новых ключа                                                             |
| `tests/config.test.ts`                      | Modify   | дефолты новых конфигов                                                    |
| `tests/execution-stuck-detector.test.ts`    | Modify   | сигнатуры, `isSearchableError`, `buildSearchQuery`                        |
| `tests/tools/web-search.test.ts`            | Modify   | рефакторинг `performWebSearch` + выключатель                              |
| `tests/execution-web-search.test.ts`        | Create   | поведение `onAfterTool` → поиск                                           |
| `package.json`                              | Modify   | версия 0.42.0                                                             |
| `AGENTS.md`                                 | Modify   | запись в changelog                                                        |

Порядок задач: TDD — тест → реализация → проверка → коммит.

---

### Task 1: Config — типы и дефолты

**Files:**

- Modify: `src/config/types.ts`
- Modify: `src/config/defaults.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Написать failing-тест дефолтов**

В `tests/config.test.ts`, после блока `describe("subagent defaults", ...)` (в конце файла) добавить:

```typescript
describe("web search defaults", () => {
  it("enables web search and error web search by default", () => {
    expect(DEFAULTS.webSearch?.enabled).toBe(true);
    expect(DEFAULTS.errorWebSearch?.enabled).toBe(true);
    expect(DEFAULTS.errorWebSearch?.threshold).toBe(5);
    expect(DEFAULTS.errorWebSearch?.maxResults).toBe(5);
    expect(DEFAULTS.errorWebSearch?.maxQueryChars).toBe(200);
    expect(DEFAULTS.errorWebSearch?.maxSearchesPerSession).toBe(3);
    expect(DEFAULTS.errorWebSearch?.requestTimeoutMs).toBe(10000);
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `bun test tests/config.test.ts`
Expected: FAIL — `DEFAULTS.webSearch` is `undefined`.

- [ ] **Step 3: Реализовать типы**

В `src/config/types.ts`, сразу после `export interface NetworkSecurityConfig { ... }` (блок `NetworkSecurityConfig`, строки ~120–126), вставить:

```typescript
/**
 * Master switch for the web search capability. When enabled=false the
 * web_search tool replies "disabled" and the automatic error search
 * (errorWebSearch) never fires — the feature is tied to this switch.
 */
export interface WebSearchConfig {
  enabled: boolean;
}

export interface ErrorWebSearchConfig {
  /** Independent switch for the auto error-search feature itself. */
  enabled: boolean;
  /** Same error signature repetition count that triggers the search (5). */
  threshold: number;
  /** Number of results injected into the context (5). */
  maxResults: number;
  /** Maximum length of the generated search query (200). */
  maxQueryChars: number;
  /** Session cap on automatic error searches (3). */
  maxSearchesPerSession: number;
  /** Network request timeout for the search in ms (10000). */
  requestTimeoutMs: number;
}
```

В `AppConfig` (в `src/config/types.ts`), после поля `browser: BrowserToolConfig;` добавить:

```typescript
  webSearch?: WebSearchConfig;
  errorWebSearch?: ErrorWebSearchConfig;
```

- [ ] **Step 4: Реализовать дефолты**

В `src/config/defaults.ts`, после блока `browser: { ... },` (строки ~73–83) добавить:

```typescript
  webSearch: {
    enabled: true,
  },
  errorWebSearch: {
    enabled: true,
    threshold: 5,
    maxResults: 5,
    maxQueryChars: 200,
    maxSearchesPerSession: 3,
    requestTimeoutMs: 10000,
  },
```

- [ ] **Step 5: Прогнать тест — должен пройти**

Run: `bun test tests/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `tsc --noEmit`
Expected: чистый (новые поля опциональные — существующий код не трогаем).

- [ ] **Step 7: Коммит**

```bash
git add src/config/types.ts src/config/defaults.ts tests/config.test.ts
git commit -m "feat(config): webSearch + errorWebSearch config types and defaults"
```

---

### Task 2: StuckDetector — сигнатуры ошибок + helpers запроса

**Files:**

- Modify: `src/modules/execution/stuck-detector.ts`
- Test: `tests/execution-stuck-detector.test.ts`

- [ ] **Step 1: Написать failing-тесты**

В `tests/execution-stuck-detector.test.ts`, в конце файла добавить три describe-блока:

```typescript
describe("StuckDetector error signature counting", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector(5, 3, 5);
  });

  it("returns null before the threshold", () => {
    for (let i = 0; i < 4; i++) {
      detector.recordToolError("bash", "error TS2322: not assignable");
    }
    expect(detector.getRepeatedErrorSignature()).toBeNull();
  });

  it("returns the signature at the threshold with its count", () => {
    for (let i = 0; i < 5; i++) {
      detector.recordToolError("bash", "error TS2322: not assignable");
    }
    const sig = detector.getRepeatedErrorSignature();
    expect(sig).toContain("bash::");
    expect(sig).toContain("TS2322");
    expect(detector.getErrorSignatureCount(sig!)).toBe(5);
  });

  it("does not merge different errors of the same tool", () => {
    for (let i = 0; i < 5; i++) detector.recordToolError("bash", "error TS2322: A");
    for (let i = 0; i < 5; i++) detector.recordToolError("bash", "error TS1005: B");
    expect(detector.getRepeatedErrorSignature()).toContain("TS2322");
  });

  it("normalizes paths, line locations and ANSI codes", () => {
    const a = normalizeErrorSignature("bash", "\x1b[31merror TS2322: at C:\\proj\\src\\a.ts:12:34");
    const b = normalizeErrorSignature("bash", "error TS2322: at D:\\other\\src\\b.ts:99:1");
    expect(a).toBe(b);
    expect(a).toContain("TS2322");
  });

  it("returns null for empty output", () => {
    expect(normalizeErrorSignature("bash", "")).toBeNull();
    expect(normalizeErrorSignature("bash", undefined)).toBeNull();
  });

  it("marks a signature as searched and unmarks it for retry", () => {
    for (let i = 0; i < 5; i++) detector.recordToolError("bash", "error TS2322");
    const sig = detector.getRepeatedErrorSignature()!;
    detector.markErrorSearched(sig);
    expect(detector.hasErrorSearched(sig)).toBe(true);
    expect(detector.getRepeatedErrorSignature()).toBeNull();
    detector.unmarkErrorSearched(sig);
    expect(detector.getRepeatedErrorSignature()).toBe(sig);
  });

  it("clears signature counts and searched flags on step change", () => {
    for (let i = 0; i < 5; i++) detector.recordToolError("bash", "error TS2322");
    const sig = detector.getRepeatedErrorSignature()!;
    detector.markErrorSearched(sig);
    detector.setCurrentStep(2, "next step");
    expect(detector.getRepeatedErrorSignature()).toBeNull();
    expect(detector.hasErrorSearched(sig)).toBe(false);
  });
});

describe("StuckDetector isSearchableError", () => {
  it("accepts real error text", () => {
    expect(isSearchableError("error TS2322: Type 'string' not assignable")).toBe(true);
    expect(isSearchableError("ERR_MODULE_NOT_FOUND: Cannot find module")).toBe(true);
    expect(isSearchableError("ENOENT: no such file or directory")).toBe(true);
    expect(isSearchableError("TypeError: Cannot read properties of undefined")).toBe(true);
    expect(isSearchableError("panic: runtime error")).toBe(true);
  });

  it("rejects empty and trivial output", () => {
    expect(isSearchableError("")).toBe(false);
    expect(isSearchableError("   ")).toBe(false);
    expect(isSearchableError("Command failed with exit code 1")).toBe(false);
    expect(isSearchableError("Process finished with exit code 1")).toBe(false);
  });
});

describe("StuckDetector buildSearchQuery", () => {
  it("uses up to 3 error lines and strips paths", () => {
    const q = buildSearchQuery(
      "run tests",
      "bun run test",
      "src/a.ts:12:34 error TS2322: X\nC:\\proj\\src\\b.ts:1:2 error TS1005: Y",
      "bash",
      200,
    );
    expect(q).not.toContain("C:\\proj");
    expect(q).toContain("TS2322");
    expect(q).toContain("how to fix");
  });

  it("adds runtime and framework from the step/bash context", () => {
    const q = buildSearchQuery(
      "install react app",
      "npm run build",
      "error: not found",
      "bash",
      200,
    );
    expect(q.toLowerCase()).toContain("npm");
    expect(q.toLowerCase()).toContain("react");
    expect(q.toLowerCase()).toContain("how to fix");
  });

  it("falls back to tool + step when error text is empty", () => {
    const q = buildSearchQuery("fix the failing build", "", "", "bash", 200);
    expect(q).toContain("bash");
    expect(q).toContain("fix the failing build");
  });

  it("caps the query length", () => {
    const q = buildSearchQuery("x", "y", "error TS2322: " + "very long ".repeat(100), "bash", 50);
    expect(q.length).toBeLessThanOrEqual(50);
  });
});
```

Обновить импорт в `tests/execution-stuck-detector.test.ts` (строка 2):

```typescript
import {
  StuckDetector,
  classifyError,
  isSearchableError,
  buildSearchQuery,
  normalizeErrorSignature,
} from "../src/modules/execution/stuck-detector";
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `bun test tests/execution-stuck-detector.test.ts`
Expected: FAIL — `normalizeErrorSignature`/`isSearchableError`/`buildSearchQuery` не экспортируются, `getRepeatedErrorSignature` не существует.

- [ ] **Step 3: Реализовать helpers (модульный уровень)**

В `src/modules/execution/stuck-detector.ts`, после `const READ_ONLY_LOOP_THRESHOLD = 10;` (строка 77, сразу перед `export class StuckDetector`), добавить:

```typescript
const ANSI_RE = /\x1b\[[0-9;]*m/g;
/** Пути (абсолютные/относительные) + опционально :line:col. */
const ERROR_LOC_RE =
  /(?:[A-Za-z]:[\\/])?(?:[\w.@+-]+[\\/])+[\w.@+-]+\.[a-zA-Z0-9]{1,6}(?::\d+(?::\d+)?)?/g;
const SIGNATURE_MAX_CHARS = 120;

const SEARCHABLE_PATTERNS: RegExp[] = [
  /error TS\d+/i,
  /ERR_[A-Z_]+/,
  /ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EADDRINUSE/i,
  /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i,
  /TypeError|ReferenceError|SyntaxError|RangeError/i,
  /is not a function|is not defined|is not a constructor/i,
  /Cannot read properties of/i,
  /failed to (compile|build|resolve|parse)/i,
  /fatal error|panic/i,
];

const RUNTIME_WORDS = [
  "bun",
  "node",
  "deno",
  "npm",
  "yarn",
  "pnpm",
  "pip",
  "pip3",
  "python",
  "python3",
  "tsc",
  "tsx",
  "npx",
  "go",
  "cargo",
  "gradle",
  "maven",
  "make",
];
const FRAMEWORK_WORDS = [
  "react",
  "vue",
  "angular",
  "svelte",
  "vite",
  "next",
  "nest",
  "express",
  "fastify",
  "flask",
  "django",
  "spring",
  "webpack",
  "tailwind",
];

export function normalizeErrorSignature(toolName: string, output?: string): string | null {
  if (!output) return null;
  const cleaned = output
    .replace(ANSI_RE, "")
    .replace(ERROR_LOC_RE, " <path>")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return `${toolName}::${cleaned.slice(0, SIGNATURE_MAX_CHARS)}`;
}

export function isSearchableError(output: string): boolean {
  if (!output || !output.trim()) return false;
  const text = output.trim();
  return SEARCHABLE_PATTERNS.some((p) => p.test(text));
}

export function buildSearchQuery(
  stepDescription: string,
  lastBashCommand: string,
  lastErrorOutput: string,
  toolName: string,
  maxQueryChars: number,
): string {
  const errorText = (lastErrorOutput || "")
    .replace(ANSI_RE, "")
    .replace(ERROR_LOC_RE, " <path>")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const context = `${stepDescription} ${lastBashCommand}`.toLowerCase();
  const runtime = RUNTIME_WORDS.find((w) => context.includes(w)) || "";
  const framework = FRAMEWORK_WORDS.find((w) => context.includes(w)) || "";
  let query: string;
  if (errorText) {
    query =
      runtime && !errorText.toLowerCase().includes(runtime) ? `${runtime} ${errorText}` : errorText;
    if (framework && !query.toLowerCase().includes(framework)) query = `${query} ${framework}`;
    query = `${query} how to fix`;
  } else if (runtime || framework) {
    query = `${[runtime, framework, "error", "how to fix"].filter(Boolean).join(" ")}`;
  } else {
    query = `${toolName} ${stepDescription} how to fix`;
  }
  return query.slice(0, maxQueryChars);
}
```

- [ ] **Step 4: Реализовать поля и конструктор класса**

В `src/modules/execution/stuck-detector.ts` добавить поля (рядом с остальными `private`-полями, после `private readOnlyStreak = 0;`):

```typescript
  private errorSignatureCounts: Map<string, number> = new Map();
  private searchedErrorSignatures: Set<string> = new Set();
  private webSearchThreshold: number;
```

Заменить конструктор (строки 101–104):

```typescript
  constructor(threshold = 6, errorThreshold = 3, webSearchThreshold = 5) {
    this.threshold = threshold;
    this.errorThreshold = errorThreshold;
    this.webSearchThreshold = webSearchThreshold;
  }
```

- [ ] **Step 5: Реализовать подсчёт в recordToolError**

Заменить `recordToolError` (строки 138–143):

```typescript
  recordToolError(toolName: string, output?: string): void {
    this.toolErrors.set(toolName, (this.toolErrors.get(toolName) || 0) + 1);
    this.consecutiveFailures++;
    this.lastFailedTool = toolName;
    if (output) this.lastErrorOutput = output;
    const sig = normalizeErrorSignature(toolName, output);
    if (sig) {
      this.errorSignatureCounts.set(sig, (this.errorSignatureCounts.get(sig) || 0) + 1);
    }
  }
```

- [ ] **Step 6: Реализовать новые методы**

Вставить после метода `getLastFailedTool()` (строка ~175):

```typescript
  getRepeatedErrorSignature(): string | null {
    for (const [sig, count] of this.errorSignatureCounts) {
      if (count >= this.webSearchThreshold && !this.searchedErrorSignatures.has(sig)) {
        return sig;
      }
    }
    return null;
  }

  getErrorSignatureCount(sig: string): number {
    return this.errorSignatureCounts.get(sig) || 0;
  }

  markErrorSearched(sig: string): void {
    this.searchedErrorSignatures.add(sig);
  }

  unmarkErrorSearched(sig: string): void {
    this.searchedErrorSignatures.delete(sig);
  }

  hasErrorSearched(sig: string): boolean {
    return this.searchedErrorSignatures.has(sig);
  }
```

- [ ] **Step 7: Сброс новых структур**

Добавить очистку двух новых структур в конец каждого метода сброса (три места). Точные уникальные якоря для Edit:

- `reset()` (строки 549–563) — oldString `this.emptyBashRunCount = 0;\n    this.readOnlyStreak = 0;\n  }` → newString `this.emptyBashRunCount = 0;\n    this.readOnlyStreak = 0;\n    this.errorSignatureCounts.clear();\n    this.searchedErrorSignatures.clear();\n  }`.
- `resetStepProgress()` (строки 571–583) — oldString `this.lastBashCommand = "";\n    this.lastBashOutput = "";\n    this.emptyBashRunCount = 0;\n  }` → newString `this.lastBashCommand = "";\n    this.lastBashOutput = "";\n    this.emptyBashRunCount = 0;\n    this.errorSignatureCounts.clear();\n    this.searchedErrorSignatures.clear();\n  }`.
- `resetStepState()` (строки 590–605) — oldString `this.emptyBashRunCount = 0;\n    this.readOnlyStreak = 0;\n    // Preserve escalationCount` → newString `this.emptyBashRunCount = 0;\n    this.readOnlyStreak = 0;\n    this.errorSignatureCounts.clear();\n    this.searchedErrorSignatures.clear();\n    // Preserve escalationCount`.

- [ ] **Step 8: Прогнать тесты**

Run: `bun test tests/execution-stuck-detector.test.ts`
Expected: PASS (все блоки, включая новые).

- [ ] **Step 9: Typecheck + коммит**

Run: `tsc --noEmit`
Expected: чистый.

```bash
git add src/modules/execution/stuck-detector.ts tests/execution-stuck-detector.test.ts
git commit -m "feat(execution): error signature counting + search query helpers in StuckDetector"
```

---

### Task 3: web-search рефакторинг — performWebSearch + мастер-выключатель

**Files:**

- Modify: `src/tools/web-search.ts`
- Test: `tests/tools/web-search.test.ts`

- [ ] **Step 1: Написать failing-тесты**

В `tests/tools/web-search.test.ts` заменить всё содержимое файла на:

```typescript
import { describe, it, expect } from "vitest";
import { webSearchTool, performWebSearch } from "../../src/tools/web-search";

describe("webSearchTool", () => {
  it("has correct definition", () => {
    expect(webSearchTool.name).toBe("web_search");
    expect(webSearchTool.description).toBeTruthy();
    expect(webSearchTool.parameters.required).toContain("query");
  });

  it("rejects calls when the web search master switch is off", async () => {
    const ctx: any = { config: { webSearch: { enabled: false } }, sessionContext: undefined };
    const result = await webSearchTool.handler(ctx, { query: "test" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("disabled");
  });

  it("allows calls when the master switch is absent (default on)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ text: async () => "<html></html>" })) as any;
    try {
      const ctx: any = { config: {}, sessionContext: undefined };
      const result = await webSearchTool.handler(ctx, { query: "test" });
      expect(result.success).toBe(true); // empty HTML → no results, still a successful call
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("performWebSearch", () => {
  it("returns a blocked outcome when the domain is denied", async () => {
    const networkConfig = {
      enabled: true,
      deniedDomains: ["html.duckduckgo.com"],
      allowedDomains: [],
      requestTimeout: 1000,
      maxResponseSize: 100000,
    };
    const outcome = await performWebSearch("test", 5, networkConfig);
    expect(outcome.success).toBe(false);
    expect(outcome.blocked).toBe(true);
    expect(outcome.results).toEqual([]);
  });

  it("returns empty results for empty HTML", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ text: async () => "<html></html>" })) as any;
    try {
      const outcome = await performWebSearch("nothing", 5, undefined);
      expect(outcome.success).toBe(true);
      expect(outcome.results).toEqual([]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `bun test tests/tools/web-search.test.ts`
Expected: FAIL — `performWebSearch` не экспортируется; тест «master switch off» падает (handler не проверяет конфиг).

- [ ] **Step 3: Реализовать рефакторинг**

Полностью заменить `src/tools/web-search.ts` на:

```typescript
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import type { NetworkSecurityConfig } from "../config/types";
import { isUrlAllowed, sanitizeUrl } from "../modules/security/network-validator";
import { logNetworkRequest, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutcome {
  success: boolean;
  results: SearchResult[];
  error?: string;
  /** true when the URL was blocked by the security policy (not an I/O error). */
  blocked?: boolean;
}

export async function performWebSearch(
  query: string,
  numResults: number,
  networkConfig: NetworkSecurityConfig | undefined,
  requestTimeoutMs?: number,
): Promise<WebSearchOutcome> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const validation = isUrlAllowed(url, networkConfig);
  if (!validation.allowed) {
    return {
      success: false,
      blocked: true,
      results: [],
      error: validation.reason || "URL blocked by security policy",
    };
  }
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(requestTimeoutMs ?? networkConfig?.requestTimeout ?? 10000),
    });
    const html = await response.text();
    const results: SearchResult[] = [];
    const snippetRegex =
      /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = snippetRegex.exec(html)) !== null && results.length < numResults) {
      results.push({
        url: match[1].trim(),
        title: match[2].replace(/<[^>]+>/g, "").trim(),
        snippet: match[3].replace(/<[^>]+>/g, "").trim(),
      });
    }
    return { success: true, results };
  } catch (err: any) {
    return { success: false, results: [], error: err.message };
  }
}

function formatResults(results: SearchResult[]): string {
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
    .join("\n");
}

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web for information. Returns search results with titles and snippets. Use this for search queries instead of opening search engines (Google/Yandex/Bing) in the browser — they block headless browsers.",
  tags: ["research"],
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      numResults: {
        type: "number",
        description: "Number of results (default 5)",
      },
    },
    required: ["query"],
  },
  handler: async (ctx, args) => {
    if (ctx.config?.webSearch?.enabled === false) {
      return { success: false, output: t("tool.web_search_disabled") };
    }
    const query = String(args.query || "");
    const numResults = Number(args.numResults) || 5;

    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext).network
      : ctx.config.security?.network;

    const outcome = await performWebSearch(query, numResults, securityConfig);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    if (outcome.blocked) {
      logSecurityBlock(
        ctx.sessionId,
        "network_request",
        outcome.error || "URL blocked by security policy",
        sanitizeUrl(url),
      );
      return { success: false, output: t("error.search_failed", { message: outcome.error }) };
    }
    logNetworkRequest(
      ctx.sessionId,
      sanitizeUrl(url),
      outcome.success,
      `Results: ${outcome.results.length}`,
    );

    if (!outcome.success) {
      return { success: false, output: t("error.search_failed", { message: outcome.error }) };
    }
    if (outcome.results.length === 0) {
      return { success: true, output: t("tool.no_results", { query }) };
    }
    return {
      success: true,
      output: t("tool.search_results", {
        query,
        results: formatResults(outcome.results),
      }),
      display: t("tool.web_search_result", {
        query,
        count: String(outcome.results.length),
      }),
    };
  },
};
```

- [ ] **Step 4: Прогнать тесты**

Run: `bun test tests/tools/web-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + коммит**

Run: `tsc --noEmit`
Expected: чистый.

```bash
git add src/tools/web-search.ts tests/tools/web-search.test.ts
git commit -m "feat(tools): extract performWebSearch + webSearch.enabled master switch"
```

---

### Task 4: i18n — 4 ключа (en + ru)

**Files:**

- Modify: `src/i18n/en.json`
- Modify: `src/i18n/ru.json`

- [ ] **Step 1: Добавить ключи в en.json**

В `src/i18n/en.json`:

- после `"exec.forbidden_cmd": "...",` (строка 496) добавить:

```json
  "exec.error_search_results": "The error \"{sig}\" has occurred {count} times. Web search found:\n{results}\nApply a matching solution from these results. If none is relevant — do NOT repeat the same approach; change strategy or honestly report being stuck.",
  "exec.error_search_failed": "Web search returned nothing for \"{query}\".",
  "exec.error_search_no_query": "Error output is not meaningful — skipping the web search.",
```

- после `"tool.search_results": "...",` (строка 133) добавить:

```json
  "tool.web_search_disabled": "Web search is disabled (webSearch.enabled: false). Use file/system tools only.",
```

- [ ] **Step 2: Добавить ключи в ru.json**

В `src/i18n/ru.json`:

- после `"exec.forbidden_cmd": "...",` (строка 494) добавить:

```json
  "exec.error_search_results": "Ошибка \"{sig}\" повторилась {count} раз. Поиск в интернете нашёл:\n{results}\nПримени подходящее решение из результатов. Если ни один результат не релевантен — НЕ повторяй тот же подход, смени стратегию или честно сообщи о застревании.",
  "exec.error_search_failed": "Поиск в интернете для \"{query}\" ничего не дал.",
  "exec.error_search_no_query": "Текст ошибки незначимый — поиск в интернете пропущен.",
```

- после `"tool.search_results": "...",` (строка 131) добавить:

```json
  "tool.web_search_disabled": "Веб-поиск отключён (webSearch.enabled: false). Используй только файловые и системные инструменты.",
```

- [ ] **Step 3: Проверка i18n + коммит**

Run: `bun test tests/config.test.ts` (i18n не имеет отдельного теста; прогон любой i18n-зависимой проверки) и `tsc --noEmit`.
Expected: чистые.

```bash
git add src/i18n/en.json src/i18n/ru.json
git commit -m "feat(i18n): error web search keys (en+ru)"
```

---

### Task 5: ExecutionModule — maybeSearchError + DI + plugin wiring

**Files:**

- Modify: `src/modules/execution/module.ts`
- Modify: `src/modules/execution/execution-plugin.ts`
- Modify: `src/core/bootstrap.ts`

- [ ] **Step 1: Добавить импорты в module.ts**

В `src/modules/execution/module.ts` обновить импорты (в верхней части файла):

- Строка 3 `import type { ToolDefinition } from "../../tools/types";` → `import type { ToolDefinition, ToolContext, ToolCall } from "../../tools/types";`
- Строка 8 `import { StuckDetector } from "./stuck-detector";` → `import { StuckDetector, isSearchableError, buildSearchQuery } from "./stuck-detector";`

Добавить новые импорты (например после строки 16 `import { resolve } from "path";`):

```typescript
import type { NetworkSecurityConfig } from "../../config/types";
import { performWebSearch, type SearchResult } from "../../tools/web-search";
import { getSessionSecurityConfig } from "../security/session-isolation";
```

- [ ] **Step 2: Добавить тип и константу**

После импортов в `module.ts` добавить:

```typescript
export type WebSearchRunner = (
  query: string,
  numResults: number,
  networkConfig: NetworkSecurityConfig | undefined,
  requestTimeoutMs?: number,
) => Promise<{ success: boolean; results: SearchResult[]; error?: string; blocked?: boolean }>;

const ERROR_SEARCH_MIN_INTERVAL_MS = 30000;
```

- [ ] **Step 3: Добавить поля**

В `ExecutionModule`, после `private forbiddenBashFailures = new Map<string, number>();` добавить:

```typescript
  private searchRunner: WebSearchRunner;
  private webSearchThreshold: number;
  private searchesThisSession = 0;
  private retryWebSearchSignatures = new Set<string>();
  private lastErrorSearchAt = 0;
  private readonly errorSearchCooldownMs: number;
```

- [ ] **Step 4: Обновить конструктор**

Заменить конструктор (строки 83–89):

```typescript
  constructor(
    baseDir: string,
    stuckThreshold = 6,
    webSearchThreshold = 5,
    searchRunner: WebSearchRunner = performWebSearch,
    errorSearchCooldownMs = ERROR_SEARCH_MIN_INTERVAL_MS,
  ) {
    this.baseDir = baseDir;
    this.verifier = new StepVerifier(baseDir);
    this.stuckDetector = new StuckDetector(stuckThreshold, 3, webSearchThreshold);
    this.auditor = new Auditor(baseDir);
    this.store = new PlanStore(baseDir);
    this.webSearchThreshold = webSearchThreshold;
    this.searchRunner = searchRunner;
    this.errorSearchCooldownMs = errorSearchCooldownMs;
  }
```

- [ ] **Step 5: Реализовать maybeSearchError**

Вставить метод после `getStuckDetector()` (строка ~126):

```typescript
  /**
   * Automatic web search for a repeatedly failing error (>= errorWebSearch.threshold
   * identical signatures). Fires the search fire-and-forget (never blocks the tool
   * result) and queues the results as a <system-summary> in pendingMessages.
   */
  maybeSearchError(ctx: ToolContext, call: ToolCall): void {
    if (ctx.config?.webSearch?.enabled === false) return;
    const cfg = ctx.config?.errorWebSearch;
    if (!cfg?.enabled) return;
    const sig = this.stuckDetector.getRepeatedErrorSignature();
    if (!sig) return;
    if (this.stuckDetector.hasErrorSearched(sig) && !this.retryWebSearchSignatures.has(sig)) return;
    if (this.searchesThisSession >= (cfg.maxSearchesPerSession ?? 3)) return;
    const lastError = this.stuckDetector.getLastErrorOutput();
    if (!isSearchableError(lastError)) {
      ctx.logger?.debug(t("exec.error_search_no_query"));
      return;
    }
    const now = Date.now();
    if (now - this.lastErrorSearchAt < this.errorSearchCooldownMs) return;
    const stepDesc = this.tracker?.getCurrentStep()?.description ?? "";
    const query = buildSearchQuery(
      stepDesc,
      this.stuckDetector.getLastBashCommand(),
      lastError,
      call.name,
      cfg.maxQueryChars ?? 200,
    );
    const count = this.stuckDetector.getErrorSignatureCount(sig);
    this.stuckDetector.markErrorSearched(sig);
    this.searchesThisSession++;
    this.lastErrorSearchAt = now;
    const networkConfig = getSessionSecurityConfig(ctx.config, ctx.sessionContext).network;
    this.searchRunner(query, cfg.maxResults ?? 5, networkConfig, cfg.requestTimeoutMs ?? 10000)
      .then((res) => {
        if (!res.success || res.results.length === 0) {
          if (!this.retryWebSearchSignatures.has(sig)) {
            this.retryWebSearchSignatures.add(sig);
            this.stuckDetector.unmarkErrorSearched(sig);
          }
          ctx.logger?.warn(t("exec.error_search_failed", { query }));
          ctx.sessionLog?.plan("web-search", `empty/failed: ${query}`);
          return;
        }
        const resultsText = res.results
          .map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${r.snippet}`)
          .join("\n");
        this.pendingMessages.push({
          role: "user",
          content: `<system-summary>${t("exec.error_search_results", {
            sig,
            count: String(count),
            query,
            results: resultsText,
          })}</system-summary>`,
        });
      })
      .catch((e) => ctx.logger?.warn(`error web search: ${e.message}`));
  }
```

- [ ] **Step 6: Пробросить в плагин**

В `getPlugin()` (строки 209–219) добавить поле в `createExecutionPlugin({ ... })`:

```typescript
      maybeSearchError: (ctx: ToolContext, call: ToolCall) => this.maybeSearchError(ctx, call),
```

- [ ] **Step 7: Вызвать из onAfterTool в execution-plugin.ts**

В `src/modules/execution/execution-plugin.ts`:

В интерфейс `ExecutionPluginDeps` (после `advancePlanIfStepComplete(...): void;`) добавить:

```typescript
  maybeSearchError: (ctx: any, call: any) => void;
```

В `onAfterTool`, в самом конце (после блока `if (result.success && (call.name === "write_file" || call.name === "edit_file")) { ... }`) добавить:

```typescript
// Automatic web search for a repeatedly failing error (fire-and-forget,
// results land in pendingMessages on the next onBeforeThink flush).
deps.maybeSearchError(ctx, call);
```

- [ ] **Step 8: Пробросить threshold из bootstrap.ts**

В `src/core/bootstrap.ts`, заменить (строка 298):

```typescript
const execModule = new ExecutionModule(baseDir, config.stuckThreshold);
```

на:

```typescript
const execModule = new ExecutionModule(
  baseDir,
  config.stuckThreshold,
  config.errorWebSearch?.threshold ?? 5,
);
```

- [ ] **Step 9: Typecheck + существующие тесты**

Run: `tsc --noEmit` и `bun test tests/execution-scenario-tests.test.ts tests/execution-forbidden-cmd.test.ts`
Expected: чистые/зелёные.

- [ ] **Step 10: Коммит**

```bash
git add src/modules/execution/module.ts src/modules/execution/execution-plugin.ts src/core/bootstrap.ts
git commit -m "feat(execution): automatic error web search from onAfterTool"
```

---

### Task 6: onAfterTool-тесты (новый файл)

**Files:**

- Create: `tests/execution-web-search.test.ts`

- [ ] **Step 1: Написать тесты**

Создать `tests/execution-web-search.test.ts` (замечание: `module.getPlugin()` кастится в `any` — хуки `AgentPlugin` опциональные, без каста LSP выдаёт «Cannot invoke an object which is possibly 'undefined'»; тесты `bun test` тип не проверяют, но редакторский LSP на `tests/**` реагирует):

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ExecutionModule } from "../src/modules/execution/module";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeCfg(overrides: Record<string, unknown> = {}): any {
  return {
    webSearch: { enabled: true },
    errorWebSearch: {
      enabled: true,
      threshold: 5,
      maxResults: 5,
      maxQueryChars: 200,
      maxSearchesPerSession: 3,
      requestTimeoutMs: 10000,
      ...overrides,
    },
  };
}

const TS_ERROR = "error TS2322: Type 'string' is not assignable to type 'number'";

describe("error web search on repeated failures", () => {
  let tmpDir: string;
  let module: ExecutionModule;
  let runner: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-ws-"));
    runner = vi.fn(async () => ({
      success: true,
      results: [{ title: "Fix", url: "https://example.com/fix", snippet: "do this" }],
    }));
    module = new ExecutionModule(tmpDir, 8, 5, runner as any, 0);
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  async function failTimes(n: number, output: string, name = "bash") {
    const plugin: any = module.getPlugin();
    const ctx: any = {
      config: makeCfg(),
      logger: { warn: vi.fn(), debug: vi.fn() },
      sessionLog: { plan: vi.fn() },
    };
    const call: any = { id: "c", name, arguments: { command: "bun run test" } };
    const result: any = { success: false, output };
    for (let i = 0; i < n; i++) {
      await plugin.onAfterTool(ctx, call, result);
    }
    await new Promise((r) => setTimeout(r, 5));
    return { plugin, ctx };
  }

  it("fires one search after 5 repeats and injects results", async () => {
    const { plugin, ctx } = await failTimes(5, TS_ERROR);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0]).toContain("TS2322");
    expect(runner.mock.calls[0][0]).toContain("how to fix");

    const messages: string[] = [];
    ctx.contextManager = { addMessage: (m: any) => messages.push(String(m?.content ?? "")) };
    plugin.onBeforeThink(ctx);
    expect(messages.some((m) => m.includes("Web search found"))).toBe(true);
  });

  it("does not search before 5 repeats", async () => {
    await failTimes(4, TS_ERROR);
    expect(runner).not.toHaveBeenCalled();
  });

  it("skips non-searchable error output", async () => {
    await failTimes(5, "Command failed with exit code 1");
    expect(runner).not.toHaveBeenCalled();
  });

  it("respects the webSearch master switch", async () => {
    const plugin: any = module.getPlugin();
    const ctx: any = {
      config: { webSearch: { enabled: false }, errorWebSearch: makeCfg().errorWebSearch },
      logger: { warn: vi.fn(), debug: vi.fn() },
      sessionLog: { plan: vi.fn() },
    };
    const call: any = { id: "c", name: "bash", arguments: { command: "bun run test" } };
    const result: any = { success: false, output: TS_ERROR };
    for (let i = 0; i < 5; i++) await plugin.onAfterTool(ctx, call, result);
    await new Promise((r) => setTimeout(r, 5));
    expect(runner).not.toHaveBeenCalled();
  });

  it("respects the errorWebSearch switch", async () => {
    const plugin: any = module.getPlugin();
    const ctx: any = {
      config: {
        webSearch: { enabled: true },
        errorWebSearch: { ...makeCfg().errorWebSearch, enabled: false },
      },
      logger: { warn: vi.fn(), debug: vi.fn() },
      sessionLog: { plan: vi.fn() },
    };
    const call: any = { id: "c", name: "bash", arguments: { command: "bun run test" } };
    const result: any = { success: false, output: TS_ERROR };
    for (let i = 0; i < 5; i++) await plugin.onAfterTool(ctx, call, result);
    await new Promise((r) => setTimeout(r, 5));
    expect(runner).not.toHaveBeenCalled();
  });

  it("does not re-search the same signature", async () => {
    await failTimes(5, TS_ERROR);
    await failTimes(5, TS_ERROR);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("caps searches per session", async () => {
    const plugin: any = module.getPlugin();
    const ctx: any = {
      config: makeCfg({ maxSearchesPerSession: 1 }),
      logger: { warn: vi.fn(), debug: vi.fn() },
      sessionLog: { plan: vi.fn() },
    };
    const errors = ["error TS2322: A", "error TS1005: B", "ERR_MODULE_NOT_FOUND: C"];
    for (const e of errors) {
      const call: any = { id: "c", name: "bash", arguments: { command: "bun run test" } };
      const result: any = { success: false, output: e };
      for (let i = 0; i < 5; i++) await plugin.onAfterTool(ctx, call, result);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("retries once after empty results, then stops", async () => {
    runner.mockImplementation(async () => ({ success: true, results: [] }));
    const { plugin, ctx } = await failTimes(5, TS_ERROR);
    expect(runner).toHaveBeenCalledTimes(1);

    const call: any = { id: "c", name: "bash", arguments: { command: "bun run test" } };
    const result: any = { success: false, output: TS_ERROR };
    await plugin.onAfterTool(ctx, call, result);
    await new Promise((r) => setTimeout(r, 5));
    expect(runner).toHaveBeenCalledTimes(2);

    await plugin.onAfterTool(ctx, call, result);
    await new Promise((r) => setTimeout(r, 5));
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("triggers search from the write-file typecheck branch too", async () => {
    const plugin: any = module.getPlugin();
    const ctx: any = {
      config: makeCfg(),
      logger: { warn: vi.fn(), debug: vi.fn() },
      sessionLog: { plan: vi.fn() },
    };
    const call: any = { id: "c", name: "write_file", arguments: { path: "src/a.ts" } };
    const result: any = {
      success: true,
      output: "[Project typecheck failed]: src/a.ts(14,19): error TS2322",
    };
    for (let i = 0; i < 5; i++) await plugin.onAfterTool(ctx, call, result);
    await new Promise((r) => setTimeout(r, 5));
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Запустить**

Run: `bun test tests/execution-web-search.test.ts`
Expected: PASS.

- [ ] **Step 3: Typecheck + коммит**

Run: `tsc --noEmit`
Expected: чистый.

```bash
git add tests/execution-web-search.test.ts
git commit -m "test(execution): onAfterTool error web search scenarios"
```

---

### Task 7: Полный прогон + версия + changelog

**Files:**

- Modify: `package.json`
- Modify: `AGENTS.md`

- [ ] **Step 1: Полный прогон тестов**

Run: `bun test`
Expected: все тесты зелёные. (Если полный прогон на машине не доходит до сводки из-за pre-existing агент-теста, как отмечено в AGENTS.md «Note: full bun test tests on this machine doesn't reach a summary», достаточно прогона затронутых файлов: `bun test tests/config.test.ts tests/execution-stuck-detector.test.ts tests/tools/web-search.test.ts tests/execution-web-search.test.ts tests/execution-scenario-tests.test.ts tests/execution-forbidden-cmd.test.ts`.)

- [ ] **Step 2: Typecheck**

Run: `tsc --noEmit`
Expected: чистый.

- [ ] **Step 3: Build**

Run: `bun run build:prod`
Expected: сборка успешна.

- [ ] **Step 4: Бамп версии**

В `package.json` заменить `"version": "0.41.2"` на `"version": "0.42.0"`.

- [ ] **Step 5: Запись в AGENTS.md**

Обновить строку заголовка раздела версий `### Current Version: 0.41.0` → `### Current Version: 0.42.0`.

Добавить запись `51 =` в начало нумерованного списка версий (перед записью про 0.41.1):

```markdown
- **51** = error web search (по обсуждению; спек `docs/specs/2026-08-18-error-web-search-design.md`): при ≥ 5 повторениях одной сигнатуры ошибки (`тул::нормализованный текст`) плагин `execution` автоматически ищет её в интернете. `performWebSearch()` вынесена из тула `web_search` (`src/tools/web-search.ts`) и используется и тулом, и плагином; мастер-выключатель `webSearch.enabled` отключает и тул, и авто-поиск; независимый `errorWebSearch.enabled` отключает только авто-поиск. Запуск fire-and-forget из `onAfterTool` (не блокирует цикл), результат инжектится как `<system-summary>` через `pendingMessages`. Гейты: `isSearchableError` (не ищем «exit code 1» без деталей), 1 поиск на сигнатуру, кап `maxSearchesPerSession` (3), 1 уточнённый повтор при пустых результатах, cooldown 30s. Запрос строится из до 3 строк ошибки + рантайм/фреймворк из шага/bash (`buildSearchQuery`), пути/позиции вырезаются. Конфиг `errorWebSearch.{enabled,threshold(5),maxResults(5),maxQueryChars(200),maxSearchesPerSession(3),requestTimeoutMs(10000)}`. Новые i18n: `exec.error_search_results/failed/no_query`, `tool.web_search_disabled` (en+ru). Новый файл `tests/execution-web-search.test.ts` (9 кейсов). Version: **0.42.0** (MINOR — новый конфиг + поведение + i18n ключи).
```

- [ ] **Step 6: Коммит**

```bash
git add package.json AGENTS.md
git commit -m "0.42.0: automatic error web search on repeated failures"
```

---

## Self-Review

**Spec coverage:**

- Триггер ≥5 одной ошибки → Task 2 (подсчёт сигнатур, `getRepeatedErrorSignature`).
- Плагин ищет сам → Task 5 (`maybeSearchError` + `searchRunner` DI).
- Запрос из ошибки + рантайм → Task 2 (`buildSearchQuery`).
- Неблокирующий запуск → Task 5 (fire-and-forget в `onAfterTool`).
- Гейт `isSearchableError` → Task 2.
- Анти-зацикливание (searched-флаг, кап, ретрай, cooldown) → Task 2 + Task 5.
- Мастер-выключатель `webSearch.enabled` + `errorWebSearch.enabled` → Task 1, Task 3, Task 5.
- Конфиг → Task 1.
- i18n → Task 4.
- Тесты → Task 1/2/3/6.
- Версия MINOR → Task 7.

**Cooldown note:** спек требует «не чаще чем через `STUCK_RECOVERY_COOLDOWN` итераций»; в `onAfterTool` нет счётчика итераций (executor-контекст), поэтому cooldown реализован как временной (`ERROR_SEARCH_MIN_INTERVAL_MS = 30000`, инъектируемый для тестов) — та же защита от мгновенного двойного запроса.

**Timeout wiring:** `errorWebSearch.requestTimeoutMs` (10000) передаётся в `searchRunner` 4-м аргументом (`maybeSearchError`), `performWebSearch` использует `requestTimeoutMs ?? networkConfig?.requestTimeout ?? 10000` — конфиг фичи реально применяется; тул `web_search` по-прежнему использует таймаут из `NetworkSecurityConfig` (security-конфиг), т.е. 4-й аргумент необязателен и backward-compatible.

**LSP в тестах:** `tsconfig` покрывает только `src/**` (полный `tsc --noEmit` чист), но редакторский LSP проверяет `tests/**`; поэтому в `tests/execution-web-search.test.ts` `plugin` кастуется в `any` (хуки `AgentPlugin` опциональные). Это же — причина pre-existing LSP-ошибок в `tests/execution-forbidden-cmd.test.ts` (не трогаем).

**Type consistency:** `WebSearchRunner`, `SearchResult`, `normalizeErrorSignature(tool, output)`, `isSearchableError(output)`, `buildSearchQuery(step, bash, error, tool, maxChars)`, `getRepeatedErrorSignature()`, `getErrorSignatureCount(sig)`, `markErrorSearched/unmarkErrorSearched/hasErrorSearched(sig)` — имена едины во всех задачах.
