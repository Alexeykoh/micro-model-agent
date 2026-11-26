# Стартовый контекст: лог, конфиг, карта, тулы — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** убрать три причины раздутого стартового контекста (17.6K) из задачи 8VJYKE: урезанный лог системного промпта, молча перезаписанный явный `indexer.mapTokenBudget`, автоматическую карту на 6000 токенов и все 54 схемы тулов.

**Architecture:** три волны в ветке `fix/stale-session-prompt`: (1) полный system-promt один раз в `session.jsonl` + hash/длина в `llm_request`; (2) `explicitKeys` в `LoadConfigResult`, проброс в `effectiveMapTokenBudget`; (3) ленивая карта через `project_map action=map` с `focus` и узкие тулы при `promptProfile: auto`/`full`, широкий режим только при явном `large`. Системный промпт внутри хода остаётся имутабельным (`frozenMapBlock`).

**Tech Stack:** Bun, TypeScript strict/NodeNext, vitest API через `bun test`, Biome lint, gating через `bun run quality`.

**Spec:** `docs/specs/2026-11-26-startup-context-prompt-design.md`

---

### File Structure

| File | Responsibility |
|---|---|
| `src/llm/request-snapshot.ts` | снимок запроса; добавить `systemChars/systemSha256/systemClipped` |
| `src/modules/session/log-types.ts` | тип `SessionLogEntry`; добавить поля `chars`, `sha256` для `system` |
| `src/core/session-log-messages.ts` | builder `systemEntry`: полный redacted-текст + hash |
| `src/core/session-logger.ts` | `logSystem(content, full = true)` |
| `src/core/agent/session-start.ts` | писать полный system один раз; excluded-note короткой записью |
| `src/config/config.ts` | `LoadConfigResult.explicitKeys` из сырых слоёв и env |
| `src/core/bootstrap/config-phase.ts`, `src/core/bootstrap.ts`, `src/core/bootstrap/workspace-phase.ts` | проброс `explicitKeys` и `promptMapMode` |
| `src/modules/indexer/module.ts` | `effectiveMapTokenBudget(..., explicit?)`, `promptMapMode`, `getPromptMap(focus?)` |
| `src/core/system-prompt-render.ts` | чистая функция `isExplicitLargeProfile(config)` |
| `src/core/bootstrap/session-phase.ts` | видимость тулов: `wideByDefault = isExplicitLargeProfile(config)` |
| `src/modules/indexer/map-tool.ts`, `map-tool-host.ts`, `rank.ts`, `map-info.ts`, `map-report.ts` | новый action `map`, `focus`-ранжировка |
| `src/i18n/en.json`, `src/i18n/ru.json` | описание `map`/`focus` |
| Tests | `tests/llm/request-snapshot.test.ts`, `tests/core/session-log-system.test.ts`, `tests/config/explicit-keys.test.ts`, `tests/core/prompt-scale-limits.test.ts`, `tests/core/prompt-tool-visibility.test.ts`, `tests/modules/indexer/map-focus.test.ts` |

---

### Task 1: Wave 1 — честный снимок системного промпта

**Files:**
- Modify: `src/llm/request-snapshot.ts:52-69,156-241`
- Modify: `src/modules/session/log-types.ts:83`
- Modify: `src/core/session-log-messages.ts:1-21`
- Modify: `src/core/session-logger.ts:87-90`
- Modify: `src/core/agent/session-start.ts:113-118`
- Test: `tests/llm/request-snapshot.test.ts`, `tests/core/session-log-system.test.ts` (create)

- [ ] **Step 1: failing test — снимок несёт честные метаданные system**

Add to `tests/llm/request-snapshot.test.ts`:

```ts
it("сохраняет длину и hash полного system даже при обрезке", () => {
  const full = "S".repeat(SNAPSHOT_LIMITS.system + 10);
  const snap = buildRequestSnapshot(
    { messages: [{ role: "system", content: full }], tools: [] },
    { model: "m", stream: false },
  );
  expect(snap.system.length).toBeLessThanOrEqual(SNAPSHOT_LIMITS.system + 40);
  expect(snap.systemClipped).toBe(true);
  expect(snap.systemChars).toBe(full.length);
  expect(snap.systemSha256).toMatch(/^[0-9a-f]{16}$/);
});
```

- [ ] **Step 2: run test to verify it fails**

Run: `bun test tests/llm/request-snapshot.test.ts -t "сохраняет длину"`
Expected: FAIL — `systemClipped` absent on snapshot.

- [ ] **Step 3: implement snapshot metadata**

In `src/llm/request-snapshot.ts` add import `createHash` from `node:crypto`, extend `LlmRequestSnapshot`:

```ts
  /** Системный промпт был обрезан по капу снимка. */
  systemClipped?: boolean;
  /** Длина полного system до обрезки. */
  systemChars?: number;
  /** SHA-256 полного (после DLP) system, первые 16 hex. */
  systemSha256?: string;
```

Replace the system assembly (lines 185-186 and return fields):

```ts
  const systemFull = maskTokenIds(systemParts.join("\n\n"));
  const systemClip = clip(systemFull, SNAPSHOT_LIMITS.system);
  if (systemClip.clipped) truncated = true;
  // ... seq += 1 ...
  return {
    // ...unchanged fields...
    system: systemClip.text,
    systemClipped: systemClip.clipped || undefined,
    systemChars: systemFull.length,
    systemSha256: createHash("sha256").update(systemFull).digest("hex").slice(0, 16),
    messages,
    tools,
    truncated,
  };
```

- [ ] **Step 4: run test to verify it passes**

Run: `bun test tests/llm/request-snapshot.test.ts`
Expected: PASS (all existing + new test).

- [ ] **Step 5: failing test — полный system в session.jsonl**

Create `tests/core/session-log-system.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { systemEntry } from "../../src/core/session-log-messages";

describe("system event", () => {
  it("пишет полный промпт, hash и длину; short-note не несёт hash", () => {
    const full = "You are MMA. token: <PATH:deadbeef>".repeat(4);
    const event = systemEntry(full);
    expect(event.content).toContain("You are MMA");
    expect(event.content).not.toContain("deadbeef");
    expect(event.chars).toBe(event.content.length);
    expect(event.sha256).toMatch(/^[0-9a-f]{16}$/);
    const note = systemEntry("[Excluded prompt blocks: 1]", false);
    expect(note.sha256).toBeUndefined();
    expect(note.chars).toBeUndefined();
    expect(note.content).toContain("Excluded");
  });
});
```

- [ ] **Step 6: run test to verify it fails**

Run: `bun test tests/core/session-log-system.test.ts`
Expected: FAIL — `chars`/`sha256` absent.

- [ ] **Step 7: implement full system event**

In `src/modules/session/log-types.ts` after `content?: string;` add:

```ts
  /** `system`: длина полного промпта после redaction. */
  chars?: number;
  /** `system`: SHA-256 полного промпта после redaction (16 hex). */
  sha256?: string;
```

In `src/core/session-log-messages.ts` add `import { createHash } from "node:crypto";` and replace `systemEntry`:

```ts
export function systemEntry(content: string, full = true): LogEntry {
  const redacted = redactContextSecrets(content);
  if (!full) return { type: "system", content: redacted };
  return {
    type: "system",
    content: redacted,
    chars: redacted.length,
    sha256: createHash("sha256").update(redacted).digest("hex").slice(0, 16),
  };
}
```

In `src/core/session-logger.ts` replace:

```ts
  logSystem(content: string, full = true): void {
    this.log(systemEntry(content, full));
  }
```

In `src/core/agent/session-start.ts` replace lines 115/117:

```ts
    slog.logSystem(systemPrompt);
    if (excluded.length > 0) {
      slog.logSystem(`[Excluded prompt blocks: ${excluded.length}]`, false);
    }
```

- [ ] **Step 8: run tests and commit wave 1**

Run: `bun test tests/llm/request-snapshot.test.ts tests/core/session-log-system.test.ts && bun run quality`
Expected: PASS.
Commit: `git add src/llm/request-snapshot.ts src/modules/session/log-types.ts src/core/session-log-messages.ts src/core/session-logger.ts src/core/agent/session-start.ts tests/llm/request-snapshot.test.ts tests/core/session-log-system.test.ts && git commit -m "fix(log): full system prompt once, hash in llm_request snapshot"`

---

### Task 2: Wave 2 — явное значение конфига не перезаписывается

**Files:**
- Modify: `src/config/config.ts:84-88,105-195`
- Modify: `src/core/bootstrap/config-phase.ts:40-51,67,120`
- Modify: `src/core/bootstrap.ts:100-113`
- Modify: `src/core/bootstrap/workspace-phase.ts:87-115`
- Modify: `src/modules/indexer/module.ts:39-53`
- Test: `tests/config/explicit-keys.test.ts` (create), `tests/core/prompt-scale-limits.test.ts`

- [ ] **Step 1: failing test — explicit флаг**

Add to `tests/core/prompt-scale-limits.test.ts`:

```ts
it("L2: явное значение, равное дефолту, не scale-ится", () => {
  expect(effectiveMapTokenBudget(1500, 1500, 200000, 128000, true)).toBe(1500);
  expect(effectiveMapTokenBudget(1500, 1500, 200000, 128000, false)).toBe(6000);
  expect(effectiveMapTokenBudget(500, 1500, 200000, 128000, true)).toBe(500);
});
```

- [ ] **Step 2: run test to verify it fails**

Run: `bun test tests/core/prompt-scale-limits.test.ts -t "явное значение"`
Expected: FAIL — 5th argument not accepted/ignored.

- [ ] **Step 3: implement explicit flag in pure function**

In `src/modules/indexer/module.ts` replace `effectiveMapTokenBudget`:

```ts
export function effectiveMapTokenBudget(
  configured: number | undefined,
  defaultBudget: number,
  contextWindow: number,
  largeWindowThreshold: number,
  explicit = false,
): number {
  if (explicit) return configured ?? defaultBudget;
  if (configured !== undefined && configured !== defaultBudget) return configured;
  return contextWindow >= largeWindowThreshold ? LARGE_MAP_TOKEN_BUDGET : defaultBudget;
}
```

Keep the doc comment, add: «`explicit` — ключ реально присутствовал в конфиге/env; значение, равное дефолту, остаётся пользовательским».

- [ ] **Step 4: run test to verify it passes**

Run: `bun test tests/core/prompt-scale-limits.test.ts`
Expected: PASS.

- [ ] **Step 5: failing test — explicitKeys собираются из сырых слоёв**

Create `tests/config/explicit-keys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/config";

function dirWithConfig(raw: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "mma-explicit-"));
  const path = join(dir, "core.json");
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(path, raw);
  return { dir, path };
}

describe("explicitKeys", () => {
  it("отмечает ключ из доменного файла, даже если он равен дефолту", () => {
    const { dir } = dirWithConfig('{"indexer":{"mapTokenBudget":1500}}');
    const result = loadConfig({ configDir: dir, projectConfigPath: join(dir, ".mmrc") });
    expect(result.config.indexer?.mapTokenBudget).toBe(1500);
    expect(result.explicitKeys.has("indexer.mapTokenBudget")).toBe(true);
    expect(result.explicitKeys.has("contextWindow")).toBe(false);
  });
});
```

- [ ] **Step 6: run test to verify it fails**

Run: `bun test tests/config/explicit-keys.test.ts`
Expected: FAIL — `explicitKeys` undefined.

- [ ] **Step 7: implement explicitKeys collection**

In `src/config/config.ts` add before `LoadConfigOptions`:

```ts
/** Dotted-ключи, реально заданные пользователем (до слияния с DEFAULTS). */
export function collectExplicitKeys(raw: unknown, prefix = "", out = new Set<string>()): Set<string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      collectExplicitKeys(value, dotted, out);
    } else {
      out.add(dotted);
    }
  }
  return out;
}
```

Extend `LoadConfigResult`:

```ts
  /** Явно заданные ключи из всех слоёв и env. */
  explicitKeys: ReadonlySet<string>;
```

Inside `loadConfig`, after `let legacyDetected = false;` add `const explicitKeys = new Set<string>();`. After each raw layer is read, add `for (const k of collectExplicitKeys(globalData)) explicitKeys.add(k);` (similarly `domainConfig`, `projectData`). After `const { config: envConfig, overrides } = applyEnvVars(config);` add `for (const o of overrides) explicitKeys.add(o.key);`. Replace final return with `return { config, legacyDetected, explicitKeys };`.

- [ ] **Step 8: thread explicitKeys to workspace phase**

In `src/core/bootstrap/config-phase.ts`: add `explicitKeys: ReadonlySet<string>;` to `ConfigPhase`; destructure `const { config, legacyDetected, explicitKeys } = loadConfig(...)`; return it.

In `src/core/bootstrap.ts`: destructure from `initConfigPhase`:

```ts
  const { dir, config, legacyDetected, explicitKeys, logger } = await initConfigPhase(...);
```

and pass as last arg:

```ts
  const workspace = await setupWorkspacePhase(
    config, logger, dir, projectDir, provider.profile, explicitKeys,
  );
```

In `src/core/bootstrap/workspace-phase.ts`: add sixth parameter `explicitKeys: ReadonlySet<string>` and replace budget call (lines 111-116):

```ts
  const mapTokenBudget = effectiveMapTokenBudget(
    config.indexer?.mapTokenBudget,
    DEFAULTS.indexer.mapTokenBudget,
    config.contextWindow,
    LARGE_WINDOW_THRESHOLD,
    explicitKeys.has("indexer.mapTokenBudget"),
  );
```

- [ ] **Step 9: run tests and commit wave 2**

Run: `bun test tests/config/explicit-keys.test.ts tests/core/prompt-scale-limits.test.ts && bun run quality`
Expected: PASS.
Commit: `git add src/config/config.ts src/core/bootstrap/config-phase.ts src/core/bootstrap.ts src/core/bootstrap/workspace-phase.ts src/modules/indexer/module.ts tests/config/explicit-keys.test.ts tests/core/prompt-scale-limits.test.ts && git commit -m "fix(config): respect explicitly set mapTokenBudget"`

---

### Task 3: Wave 3a — узкие тулы при auto, широкий режим по explicit large

**Files:**
- Modify: `src/core/system-prompt-render.ts:21-33`
- Modify: `src/core/bootstrap/session-phase.ts:196-202`
- Test: `tests/core/prompt-tool-visibility.test.ts` (create)

- [ ] **Step 1: failing test**

Create `tests/core/prompt-tool-visibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isExplicitLargeProfile } from "../../src/core/system-prompt-render";
import { resolvePromptProfile } from "../../src/core/system-prompt";
import { DEFAULTS } from "../../src/config/defaults";

describe("tool visibility profile", () => {
  it("auto на 131K остаётся узким, явный large — широкий", () => {
    const auto = { ...structuredClone(DEFAULTS), promptProfile: "auto", contextWindow: 131072 } as never;
    const large = { ...structuredClone(DEFAULTS), promptProfile: "large", contextWindow: 131072 } as never;
    expect(resolvePromptProfile("auto", auto)).toBe("large"); // текст промпта не меняем
    expect(isExplicitLargeProfile(auto)).toBe(false);
    expect(isExplicitLargeProfile(large)).toBe(true);
  });
});
```

- [ ] **Step 2: run test to verify it fails**

Run: `bun test tests/core/prompt-tool-visibility.test.ts`
Expected: FAIL — `isExplicitLargeProfile` is not exported.

- [ ] **Step 3: implement helper and use it**

In `src/core/system-prompt-render.ts` after `LARGE_WINDOW_THRESHOLD`:

```ts
/**
 * Широкий режим тулов/карты включается только явным `promptProfile: "large"`.
 * Auto-профиль на большом окне меняет текст промпта, но не expands тулы.
 */
export function isExplicitLargeProfile(config: AppConfig): boolean {
  return config.promptProfile === "large";
}
```

In `src/core/system-prompt.ts` add re-export:

```ts
export { buildSystemInfo, LARGE_WINDOW_THRESHOLD, resolvePromptProfile, isExplicitLargeProfile } from "./system-prompt-render";
```

In `src/core/bootstrap/session-phase.ts` lines 196-202:

```ts
  const explicitLarge = isExplicitLargeProfile(config);
  const enableOnDemand = config.tools?.enableOnDemand !== false && !explicitLarge;
  const activeToolTags: string[] = enableOnDemand
    ? config.tools?.defaultTags
      ? [...config.tools.defaultTags]
      : []
    : [];
```

Add the import from `../system-prompt` next to the existing `resolvePromptProfile` import.

- [ ] **Step 4: run tests and commit wave 3a**

Run: `bun test tests/core/prompt-tool-visibility.test.ts tests/core/prompt-large-profile.test.ts && bun run quality`
Expected: PASS.
Commit: `git add src/core/system-prompt-render.ts src/core/system-prompt.ts src/core/bootstrap/session-phase.ts tests/core/prompt-tool-visibility.test.ts && git commit -m "fix(prompt): large tool set only with explicit profile"`

---

### Task 4: Wave 3b — ленивая карта и `project_map action=map` с focus

**Files:**
- Modify: `src/core/bootstrap/workspace-phase.ts:117-124`
- Modify: `src/modules/indexer/module.ts:20-53,183-212,271-291`
- Modify: `src/modules/indexer/rank.ts` (append), `src/modules/indexer/map-report.ts:24-34,92-101`, `src/modules/indexer/map-info.ts:16-54`
- Modify: `src/modules/indexer/map-tool.ts:14-75`, `src/modules/indexer/map-tool-host.ts:11-39`
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/modules/indexer/map-focus.test.ts` (create), `tests/core/prompt-tool-visibility.test.ts`

- [ ] **Step 1: failing test — focus ранжирует соседей**

Create `tests/modules/indexer/map-focus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { focusRanks } from "../../src/modules/indexer/rank";
import type { IndexedFile } from "../../src/modules/indexer/walker";

function file(path: string, exports: string[] = []): IndexedFile {
  return { path, language: "typescript", exports, symbols: [], size: 10, mtimeMs: 1 } as IndexedFile;
}

describe("focus ranks", () => {
  it("соседи по папке первые, чужой файл последний, порядок детерминирован", () => {
    const files = [
      file("src/core/agent.ts", ["Agent"]),
      file("src/core/agent/loop.ts", ["loop"]),
      file("src/diff/other.ts", ["other"]),
    ];
    const ranks = focusRanks(files, "src/core/agent.ts");
    expect(ranks.get("src/core/agent.ts")).toBe(0);
    expect(ranks.get("src/core/agent/loop.ts")).toBeLessThan(ranks.get("src/diff/other.ts")!);
    expect([...ranks.entries()].map(([p]) => p)).toEqual([...ranks.entries()].map(([p]) => p));
  });

  it("несуществующий focus не даёт релевантных файлов", () => {
    const ranks = focusRanks([file("src/a.ts")], "src/missing.ts");
    expect(ranks.get("src/a.ts")).toBe(99);
  });
});
```

- [ ] **Step 2: run test to verify it fails**

Run: `bun test tests/modules/indexer/map-focus.test.ts`
Expected: FAIL — `focusRanks` not exported.

- [ ] **Step 3: implement focus ranking**

Append to `src/modules/indexer/rank.ts`:

```ts
/**
 * Детерминированный ранг «карты вокруг файла»: сам файл, затем его папка,
 * затем потомки, затем файлы с общими экспортами; остальные — 99.
 */
export function focusRanks(files: IndexedFile[], focus: string): Map<string, number> {
  const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
  const f = norm(focus).replace(/\/$/, "");
  const dir = f.slice(0, f.lastIndexOf("/"));
  const focusExports = new Set(
    files.find((x) => norm(x.path) === f)?.exports.map((e) => e.toLowerCase()) ?? [],
  );
  const ranks = new Map<string, number>();
  for (const item of files) {
    const p = norm(item.path);
    let rank = 99;
    if (p === f) rank = 0;
    else if (p.slice(0, p.lastIndexOf("/")) === dir) rank = 1;
    else if (p.startsWith(`${f}/`)) rank = 2;
    else if (item.exports.some((e) => focusExports.has(e.toLowerCase()))) rank = 3;
    ranks.set(item.path, rank);
  }
  return ranks;
}
```

- [ ] **Step 4: run test to verify it passes**

Run: `bun test tests/modules/indexer/map-focus.test.ts`
Expected: PASS.

- [ ] **Step 5: failing test — stub block и action `map`**

Add to `tests/core/prompt-tool-visibility.test.ts`:

```ts
import { IndexerModule } from "../../src/modules/indexer/module";

it("stub-режим карты короткий и помечен kind=project-map", () => {
  const mod = new IndexerModule({ baseDir: process.cwd(), cacheDir: "<tmp>", promptMapMode: "stub" });
  const block = mod.getSystemPromptBlock();
  expect(block?.kind).toBe("project-map");
  expect((block?.content.length ?? 0) < 400).toBe(true);
  expect(block?.content).toContain("project_map");
});
```

- [ ] **Step 6: run test to verify it fails**

Run: `bun test tests/core/prompt-tool-visibility.test.ts -t "stub-режим"`
Expected: FAIL — option not known / block too big.

- [ ] **Step 7: implement stub block and focus wiring**

In `src/modules/indexer/module.ts`:

```ts
  /** Режим блока карты в системном промпте. */
  promptMapMode?: "full" | "stub";
```

add field `private promptMapMode: "full" | "stub";` and constructor assignment
`this.promptMapMode = opts.promptMapMode ?? "full";`.

Replace `getSystemPromptBlock()`:

```ts
  getSystemPromptBlock(): PromptBlock | null {
    if (this.promptMapMode === "stub") {
      const content = [
        "Workspace map is not preloaded. Call `project_map` with action `map`",
        "(optionally `focus=<path>`) to get ranked files and exports;",
        "use find/symbol/outline for targeted lookups.",
      ].join("\n");
      return {
        content,
        priority: "normal",
        essential: false,
        estimatedTokens: estimateTokens(content),
        kind: "project-map",
      };
    }
    if (!this.index) return null;
    const content = this.formatMap(this.index);
    return {
      content,
      priority: "normal",
      essential: false,
      estimatedTokens: estimateTokens(content),
      kind: "project-map",
    };
  }
```

Add `getPromptMap(focus?: string): string | null`:

```ts
  getPromptMap(focus?: string): string | null {
    if (!this.index) return null;
    return formatMapOf(this.mapView(), this.index, focus);
  }
```

In `src/core/bootstrap/workspace-phase.ts` replace the indexer construction (lines ~117-124):

```ts
  const indexerModule = new IndexerModule({
    baseDir,
    cacheDir: projectMapCacheDir,
    maxFiles: config.indexer?.maxFiles,
    respectGitignore: config.indexer?.respectGitignore,
    mapTokenBudget,
    promptMapMode: isExplicitLargeProfile(config) ? "full" : "stub",
    logger: logger.child("indexer"),
  });
```

(import `isExplicitLargeProfile` from `../system-prompt`).

- [ ] **Step 8: implement tool action `map` and host**

In `src/modules/indexer/map-tool.ts`:

```ts
  getPromptMap(focus?: string): string | null;
```

extend enum to `["summary", "refresh", "map", "find", "symbol", "outline"]`; add case:

```ts
    case "map":
      return mapResult(host, query);
```

implementation:

```ts
function mapResult(host: MapToolHost, focus: string): ToolResult {
  if (!host.getIndex()) return { success: false, output: t("indexer.not_indexed") };
  if (focus && !host.getIndex()!.files.some((f) => f.path.replace(/\\/g, "/") === focus.replace(/\\/g, "/"))) {
    return { success: false, output: t("tool.invalid_params") };
  }
  const text = host.getPromptMap(focus) ?? t("indexer.not_indexed");
  return makeResult(text);
}
```

In `src/modules/indexer/map-tool-host.ts`: add `getPromptMap: (focus?: string) => string | null;` to `MapToolHostInput` and include it in returned object. In `src/modules/indexer/module.ts` `mapToolHost()` add `getPromptMap: (focus) => this.getPromptMap(focus),`.

In `src/modules/indexer/map-info.ts` change signature:

```ts
export function formatMapOf(input: MapViewInput, result: IndexResult, focus?: string): string {
  return formatMapReport(result, {
    baseDir: input.baseDir,
    maxFiles: input.maxFiles,
    mapTokenBudget: input.mapTokenBudget,
    ranks: focus ? focusRanks(result.files, focus) : computeRanks(result),
    summary: input.summarize(result),
    stackLine: buildProjectProfileLine(input.baseDir),
  });
}
```

(import `focusRanks` from `./rank`).

- [ ] **Step 9: update i18n both dictionaries**

In `src/i18n/en.json`:

```json
  "indexer.project_map_desc": "Get a map of the project: summary of files, languages, and exports. Use action 'map' for the ranked file list (optionally with focus=<path>), 'find' to search files by path or exported name, 'symbol' to locate a symbol definition, 'outline' for a file's symbol table of contents, 'refresh' to rebuild the index.",
  "indexer.project_map_action_desc": "Action: summary, refresh, map, find, symbol, or outline; optional focus=<path> for action map",
```

In `src/i18n/ru.json` symmetrically:

```json
  "indexer.project_map_desc": "Получить карту проекта: сводка по файлам, языкам и экспортам. Действие 'map' — ранжированный список файлов (можно focus=<путь>), 'find' — поиск файла по пути или экспорту, 'symbol' — найти определение символа, 'outline' — оглавление символов файла, 'refresh' — перестроить индекс.",
  "indexer.project_map_action_desc": "Действие: summary, refresh, map, find, symbol или outline; для map необязательно focus=<путь>",
```

- [ ] **Step 10: run tests and commit wave 3b**

Run:
`bun test tests/modules/indexer/map-focus.test.ts tests/core/prompt-tool-visibility.test.ts tests/i18n.test.ts tests/core/system-prompt-freeze.test.ts && bun run quality`
Expected: PASS.
Commit: `git add src/core/bootstrap/workspace-phase.ts src/modules/indexer/module.ts src/modules/indexer/map-info.ts src/modules/indexer/map-tool.ts src/modules/indexer/map-tool-host.ts src/modules/indexer/rank.ts src/i18n/en.json src/i18n/ru.json tests/modules/indexer/map-focus.test.ts tests/core/prompt-tool-visibility.test.ts && git commit -m "feat(indexer): lazy project map with focus, narrow tools by default"`

---

### Task 5: Whole-suite verification and live evidence

**Files:**
- Task comment in press-f-tasks (8VJYKE); no code changes expected.

- [ ] **Step 1: full local gates**

Run: `bun test && bun run quality && bun test tests/docs-link-check.test.ts tests/docs-consistency.test.ts`
Expected: all green. If a new test fails, fix in its owning wave commit (do not amend old commits after merge).

- [ ] **Step 2: live run with isolated config**

Run (from repo root, temp config, local provider from current config; do not touch `~/.mma`):

```bash
$env:MMA_CONFIG_DIR="C:\Users\Alexe\AppData\Local\Temp\opencode\mma-8vjyke-config"
bun run mma -d E:\projects\micro-models-agent "расскажи, какие файлы отвечают за конфиг?"
```

Expected in produced `session.jsonl`:
- first `system` event has full prompt with `chars` and `sha256`;
- `llm_request` has matching `systemSha256`, `systemChars`, `systemClipped`;
- first `context` event `systemTokens + toolTokens` ≈ 4–5K (not 17K);
- a `project_map` tool call with `action:"map"` or `focus` appears; its output is a ranked file list;
- with explicit `indexer.mapTokenBudget: 1500` in temp config, map block ≈1500 tokens.

- [ ] **Step 3: record evidence**

Add a comment to task 8VJYKE via `press_f_tasks_api` (`comments.add`) with the session id, before/after token numbers, and the spec path. Do not change CHANGELOG (AGENTS rule 10).

---

## Self-review checklist (already performed)

- Spec §1 (problem) → Tasks 1–3; §2 boundaries → no AGENTS.md/CHANGELOG work; §3 → Task 1; §4 → Task 2; §5 → Tasks 3–4; §6 → Task 5.
- No placeholders/TODO in steps; every code step contains exact code.
- Names consistent: `explicitKeys`, `effectiveMapTokenBudget(..., explicit)`, `isExplicitLargeProfile`, `focusRanks`, `getPromptMap(focus?)`, `action:"map"`, `systemChars/systemSha256/systemClipped`.
