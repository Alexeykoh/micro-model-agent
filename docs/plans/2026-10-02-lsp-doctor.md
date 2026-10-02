# LSP Doctor & Locked-Down Networks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline).
> Steps use checkbox (`- [ ]`) syntax.

**Goal:** Сделать причину неисправности LSP видимой: `/lsp doctor` с классом
причины и подсказкой, классифицированные `[LSP check failed]`-хинты, офлайн-режим
`MMA_LSP_OFFLINE=1` (не ходить в npx), раздел документации про закрытую сеть.

**Architecture:** вынос npx-резолва из `LspClient.startServer` в чистый
`resolve.ts`; новый `diagnose.ts` (переиспользует `collectCheckFiles`,
`getServerKeyForFile`, `findProjectRoot`, `client.probe`); `LspModule.diagnose()`
как фасад; `/lsp doctor` в handler-map; классификация ошибок — общая функция.

**Tech Stack:** TypeScript strict, Bun, vitest (`bun test`), i18n en/ru.

**Спека:** `docs/specs/2026-10-02-lsp-doctor-design.md` (approved).
**Ветка:** `feat/lsp-doctor`.

---

### Task 1: `resolve.ts` + env + рефакторинг `client.startServer`

**Files:**
- Create: `src/modules/lsp/resolve.ts`
- Modify: `src/config/env.ts`
- Modify: `src/modules/lsp/client.ts`
- Test: `tests/modules/lsp/resolve.test.ts`

- [ ] **Step 1: env**

В `MMA_ENV` добавить после `BROWSER_CHANNEL`:
```ts
  LSP_OFFLINE: "MMA_LSP_OFFLINE",
```

- [ ] **Step 2: `resolve.ts`**

```ts
// Резолв запуска LSP-сервера: npx→глобальный бинарник, поиск в PATH, офлайн-флаг.
import { execSync } from "child_process";
import { platform } from "os";
import { readEnv } from "../../config/env";

/** Имя реального бинарника из npx-args (строгий layout `[--yes] [--package X]… <binary> --stdio`). */
export function extractBinaryFromNpxArgs(args: string[]): string | null {
  const stdioIdx = args.lastIndexOf("--stdio");
  if (stdioIdx !== args.length - 1 || stdioIdx < 1) return null;
  const binary = args[stdioIdx - 1];
  if (!binary || binary.startsWith("-") || isPackageVersion(binary)) return null;
  for (let i = 0; i < stdioIdx - 1; i++) {
    const a = args[i];
    if (a === "--yes") continue;
    if (a === "--package") { i++; continue; }
    return null;
  }
  return binary;
}

/** Похоже ли на спецификатор версии пакета (напр. "typescript@5"). */
export function isPackageVersion(s: string): boolean {
  return /^[\w-]+@[\d.+*-]/.test(s);
}

/** Библиотека/путь бинарника в PATH или null (where/which, 3с). */
export function findOnPath(name: string): string | null {
  const cmd = platform() === "win32" ? `where ${name}` : `which ${name}`;
  try {
    const out = execSync(cmd, { stdio: "pipe", timeout: 3000 }).toString().trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/** Офлайн-режим LSP: не использовать npx совсем. */
export function isOfflineLsp(env?: NodeJS.ProcessEnv): boolean {
  const raw = readEnv("LSP_OFFLINE", env);
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

/** Итог резолва npx-команды. */
export interface NpxLaunch {
  command: string;
  args: string[];
  binaryName: string | null;
  binaryOnPath: boolean;
  useNpxFallback: boolean;
}

/**
 * Резолв npx-запуска: если args строгого layout и бинарник есть в PATH —
 * запуск напрямую, иначе npx. Не-npx команды не трогает.
 */
export function resolveNpxLaunch(
  command: string,
  args: string[],
  probe: (name: string) => string | null = findOnPath,
): NpxLaunch {
  if (command !== "npx" || args.length === 0) {
    return { command, args, binaryName: null, binaryOnPath: false, useNpxFallback: false };
  }
  const binaryName = extractBinaryFromNpxArgs(args);
  if (binaryName && probe(binaryName)) {
    const stripped = args.filter(
      (a) => a !== "--yes" && a !== "--package" && a !== binaryName && !isPackageVersion(a),
    );
    return { command: binaryName, args: stripped, binaryName, binaryOnPath: true, useNpxFallback: false };
  }
  return { command, args, binaryName, binaryOnPath: false, useNpxFallback: true };
}
```

- [ ] **Step 3: `client.ts` — использовать resolve**

Заменить блок в `startServer` (от `// Команда npx — сначала ищем…` до конца
ветки `if (config.command === "npx" …)`) на:
```ts
    const launch = resolveNpxLaunch(config.command, config.args ?? []);
    if (launch.command !== config.command) {
      this.logger?.debug(`LSP: using globally installed ${launch.binaryName} (skipped npx)`);
    } else if (launch.useNpxFallback && launch.binaryName) {
      this.logger?.debug(`LSP: ${launch.binaryName} not found globally, falling back to npx`);
    }
    if (launch.useNpxFallback && isOfflineLsp()) {
      throw new Error(
        `LSP offline mode: ${launch.binaryName ?? "npx"} not found in PATH; ` +
          `npx auto-install is disabled (MMA_LSP_OFFLINE)`,
      );
    }
    const effectiveCommand = launch.command;
    const effectiveArgs = launch.args;
```
Удалить приватные методы `extractBinaryFromNpxArgs`/`isPackageVersion` и
неиспользуемый импорт `execSync` (проверить: `execSync` ещё нужен для
`autoInstall === false` — оставить). Добавить импорт:
`import { resolveNpxLaunch, isOfflineLsp } from "./resolve";`.

- [ ] **Step 4: Тесты `resolve.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import {
  extractBinaryFromNpxArgs, isPackageVersion, resolveNpxLaunch, isOfflineLsp,
} from "../../../src/modules/lsp/resolve";

const TS_ARGS = ["--yes","--package","typescript-language-server","--package","typescript@5","typescript-language-server","--stdio"];

describe("resolveNpxLaunch", () => {
  it("uses the global binary and strips npx wrapper when present", () => {
    const l = resolveNpxLaunch("npx", TS_ARGS, (n) => (n === "typescript-language-server" ? "/usr/bin/x" : null));
    expect(l).toMatchObject({ command: "typescript-language-server", args: ["--stdio"], binaryOnPath: true, useNpxFallback: false });
  });
  it("falls back to npx when no global binary", () => {
    const l = resolveNpxLaunch("npx", TS_ARGS, () => null);
    expect(l.useNpxFallback).toBe(true);
    expect(l.command).toBe("npx");
  });
  it("leaves angular-style npx args untouched", () => {
    const args = ["--yes","--package","@angular/language-server","--package","typescript@5","ngserver","--stdio","--tsProbeLocations","./node_modules"];
    const l = resolveNpxLaunch("npx", args, () => "/x");
    expect(l.useNpxFallback).toBe(true);
    expect(l.binaryName).toBeNull();
  });
  it("does not touch non-npx commands", () => {
    const l = resolveNpxLaunch("rust-analyzer", [], () => "/x");
    expect(l).toMatchObject({ command: "rust-analyzer", useNpxFallback: false });
  });
});

describe("extractBinaryFromNpxArgs", () => {
  it("returns null for a tail-arg layout", () => {
    expect(extractBinaryFromNpxArgs(["--package","x","srv","--stdio","--foo"])).toBeNull();
  });
  it("rejects version-like tokens", () => {
    expect(isPackageVersion("typescript@5")).toBe(true);
    expect(isPackageVersion("pyright")).toBe(false);
  });
});

describe("isOfflineLsp", () => {
  it("reads the flag and treats 0/false/empty as off", () => {
    expect(isOfflineLsp({ MMA_LSP_OFFLINE: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOfflineLsp({ MMA_LSP_OFFLINE: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOfflineLsp({ MMA_LSP_OFFLINE: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isOfflineLsp({ MMA_LSP_OFFLINE: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isOfflineLsp({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
```

- [ ] **Step 5: Тест + typecheck**

Run: `bun test tests/modules/lsp/resolve.test.ts tests/lsp-client-framing.test.ts tests/lsp-command.test.ts && tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/modules/lsp/resolve.ts src/modules/lsp/client.ts tests/modules/lsp/resolve.test.ts
git commit -m "refactor(lsp): extract npx launch resolution + offline mode"
```

---

### Task 2: `diagnose.ts`

**Files:**
- Create: `src/modules/lsp/diagnose.ts`
- Test: `tests/modules/lsp/diagnose.test.ts`

- [ ] **Step 1: `diagnose.ts`**

Реализовать типы `LspFailureReason`/`LspServerDiagnosis`/`LspDiagnosis` из
спеки; `classifyLspError(message, opts)` по правилам §3; `diagnoseLspServers`
по алгоритму §3. Детали:
- дефолты `timeoutMs = LSP_PROBE_TIMEOUT_MS` (из `config/timeouts.ts`), но
  разумный кап для doctor — 20 000; `deadlineMs = 45_000`.
- `collectFiles ?? collectCheckFiles`.
- клиент: `deps.client ?? new LspClient()`; если свой — `setLogger(deps.logger ?? null)`.
- `projectRoot` для проб = `findProjectRoot(baseDir, baseDir, server.workspaceMarkers ?? [])`.
- результат `projectRoot` в `LspDiagnosis` = `baseDir`.
- `offline = deps.offline ?? isOfflineLsp()`.
- `binaryOnPath` для не-npx: `(deps.findOnPath ?? findOnPath)(server.command) != null`.

- [ ] **Step 2: Тесты**

Инжектировать fake `client` (`{ probe: async () => {} }` / бросающий),
`collectFiles`, `findOnPath`, `offline`. Кейсы из §9. Пример:
```ts
it("classifies an npx initialize timeout as network", async () => {
  const client = { probe: async () => { throw new Error("LSP request timeout: initialize"); } } as any;
  const d = await diagnoseLspServers(config, dir, {
    client, offline: false, collectFiles: async () => [join(dir, "a.ts")],
    findOnPath: () => null,
  });
  expect(d.servers.find((s) => s.language === "typescript")?.reason).toBe("network");
});
```

- [ ] **Step 3: Запуск + typecheck**

Run: `bun test tests/modules/lsp/diagnose.test.ts && tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/lsp/diagnose.ts tests/modules/lsp/diagnose.test.ts
git commit -m "feat(lsp): structured server diagnosis with failure classification"
```

---

### Task 3: `LspModule.diagnose()` + hint в failure-путях

**Files:**
- Modify: `src/modules/lsp/module.ts`
- Modify: `src/modules/lsp/index.ts`
- Test: `tests/lsp-module.test.ts`

- [ ] **Step 1: `module.ts`**

Добавить public-метод:
```ts
  /** Структурная диагностика серверов (для `/lsp doctor`). */
  async diagnose(deps?: Parameters<typeof diagnoseLspServers>[2]) {
    return diagnoseLspServers(this.config, "", { ...deps, client: deps?.client ?? this.client });
  }
```
(Фактический baseDir берётся вызывающим; в REPL передаётся `ctx.baseDir`. Лучше
сигнатура `diagnose(baseDir: string, deps?)` — так и сделать.)

Хинты в двух failure-точках (плагин и `runCheck`): заменить
```ts
result.output += `\n\n[LSP check failed]: ${msg}`;
```
на:
```ts
const hintKey = lspHintKey(classifyLspError(msg, { npxFallback: serverConfig.command === "npx" }));
result.output += `\n\n[LSP check failed]: ${msg}\n${t(hintKey)}`;
```
где `lspHintKey(reason): string` маппит класс на `lsp.hint_*` (ok/disabled/
not-applicable/deadline → общий `lsp.hint_timeout` не нужен — для них хинт не
добавляется; см. helper). Для `[LSP disabled: …]` хинт не добавляется.

- [ ] **Step 2: `index.ts`**

Экспортировать `diagnoseLspServers`, `classifyLspError` и типы
`LspDiagnosis`/`LspServerDiagnosis`/`LspFailureReason`.

- [ ] **Step 3: Тесты**

В `tests/lsp-module.test.ts`:
```ts
it("classifies a missing-binary failure with a hint", async () => {
  // как в существующем failure-тесте; checkFile бросает "rust-analyzer not found in PATH"
  expect(result.output).toContain("[LSP check failed]");
  expect(result.output).toContain("install the language server"); // hint
});
```
и тест, что `diagnose(baseDir, {client, collectFiles, findOnPath})` возвращает
`servers`.

- [ ] **Step 4: Запуск**

Run: `bun test tests/lsp-module.test.ts && tsc --noEmit`
Expected: PASS; существующие кейсы (порог отключения, per-server disable) зелёные.

- [ ] **Step 5: Commit**

```bash
git add src/modules/lsp/module.ts src/modules/lsp/index.ts tests/lsp-module.test.ts
git commit -m "feat(lsp): diagnose() facade and classified failure hints"
```

---

### Task 4: `/lsp doctor` + completer

**Files:**
- Modify: `src/cli/repl-commands-lsp.ts`
- Modify: `src/cli/repl.ts`

- [ ] **Step 1: хендлер `doctor`**

В `handlers` карте добавить:
```ts
        doctor: async () => {
          if (!ctx.agent.getModule) return;
          const lsp = ctx.agent.getModule<LspModule>("lsp");
          // формат по STYLE.md: строки/глифы, без боксов
          const diag = await lsp.diagnose(ctx.baseDir);
          // ... рендер строк через pc/t()
          ctx.output.writeLine(...);
        },
```
Конкретный рендер: шапка `t("repl.lsp_doctor_header")`; строки `enabled/
offline/project`; по серверу `glyph lang · reason · detail`; `↳ hint` для
network/offline/binary-missing/timeout/spawn; общий `t("repl.lsp_doctor_hint")`
если есть хоть один из этих классов. Глифы: `✓`/`✗`/`–`.

- [ ] **Step 2: completer**

`src/cli/repl.ts` в `SubcommandProvider("lsp", …)`:
```ts
        { name: "doctor", description: t("lsp.sub_doctor") },
```
Обновить `repl.lsp_usage`/`repl.lsp` (§7 спеки).

- [ ] **Step 3: Запуск + typecheck**

Run: `tsc --noEmit && bun test tests/lsp-command.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/repl-commands-lsp.ts src/cli/repl.ts
git commit -m "feat(cli): /lsp doctor command"
```

---

### Task 5: i18n

**Files:**
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`

- [ ] **Step 1:** добавить все ключи из §7 спеки (рядом с существующими
  `repl.lsp_*` и `lsp.*`).
- [ ] **Step 2:** Run: `bun test tests/i18n.test.ts` → PASS (паритет).
- [ ] **Step 3:** Commit `feat(i18n): lsp doctor strings (en/ru)`.

---

### Task 6: Документация, версия, финал

**Files:**
- Modify: `docs/agents/tools.md`, `CHANGELOG.md`, `AGENTS.md`, `package.json`

- [ ] **Step 1:** `docs/agents/tools.md` — раздел «LSP in locked-down networks»:
  npx-докачка, `findOnPath` (глобальный бинарник важнее npx), правка
  `lsp.servers.<lang>` (`command`/`args`/`env.npm_config_registry`/`autoInstall`/
  `enabled`), `MMA_LSP_OFFLINE=1`, `/lsp doctor`.
- [ ] **Step 2:** CHANGELOG `## [2.17.0] - 2026-10-02` (Added: doctor, classification,
  offline, docs).
- [ ] **Step 3:** AGENTS.md — строка про `/lsp doctor` / `MMA_LSP_OFFLINE` в
  подходящем разделе.
- [ ] **Step 4:** `package.json` → `2.17.0`.
- [ ] **Step 5:** `bun test && bun run quality` — зелёные.
- [ ] **Step 6:** Commit `docs: lsp doctor changelog, AGENTS and 2.17.0`.

---

## Часть 2: WebUI LSP tab

### Task 7: Проброс `LspModule` из bootstrap

**Files:** `src/core/bootstrap/modules-phase.ts`, `src/core/bootstrap/state.ts`,
`src/core/bootstrap.ts`, `src/cli/web-command.ts`

- [ ] `startLanguageModules` возвращает `{ lspModule, startupCheck }`
  (вместо `Promise<PromptBlock|null>`); `setupModulesPhase` кладёт `lspModule`
  в `ModulesPhase`.
- [ ] `BootstrapResult.lspModule?: LspModule` (опционально — не ломать тестовые
  литералы), `bootstrap()` возвращает `modules.lspModule`.
- [ ] `web-command.ts` деструктурирует `lspModule` и передаёт `lsp: lspModule`.
- [ ] `bun test tests/core/bootstrap.test.ts && tsc --noEmit`.

### Task 8: Backend API `GET/POST /api/lsp/doctor`

**Files:** Create `src/modules/webui/lsp-api.ts`; modify `state.ts`, `module.ts`,
`server.ts`; test `tests/webui-lsp-doctor.test.ts`

- [ ] `state.ts`: `lspDiagnose?: () => Promise<LspDiagnosis>`, `lspDoctor?`,
  `lspProbing?`.
- [ ] `module.ts`: `WebUiDeps.lsp?: WebLsp`; в `startWebUi` —
  `if (deps.lsp) state.lspDiagnose = () => deps.lsp!.diagnose(deps.baseDir ?? process.cwd());`
- [ ] `lsp-api.ts`: `handleLspDoctorGet`/`handleLspDoctorPost` (SSE `lsp`,
  single-flight, 503 без модуля).
- [ ] `server.ts`: роуты `GET /api/lsp/doctor`, `POST /api/lsp/doctor`.
- [ ] Тесты: GET 503 без модуля; GET отдаёт кэш; POST запускает diagnose,
  пишет `lspDoctor`, шлёт `lsp`, повторный POST single-flight; POST 503.
- [ ] `bun test tests/webui-lsp-doctor.test.ts && tsc --noEmit`.

### Task 9: Frontend tab

**Files:** `assets/index.html`, `assets/js/dom.js`, `assets/js/sidebar.js`,
`assets/app.js`, `assets/styles.css` (по необходимости)

- [ ] `dom.js`: иконка `stethoscope`.
- [ ] `index.html`: таб + `#pane-lsp`/`#lspBody`.
- [ ] `sidebar.js`: `TABS` += `lsp`, refs, `renderLsp`, `sidebarLspState`,
  `sidebarLspEvent`, авто-запуск при открытии вкладки, «Re-check», `Alt+4`.
- [ ] `app.js`: SSE `lsp` → `sidebarLspEvent`; `renderState` → `sidebarLspState`.
- [ ] `bun test tests/webui-assets.test.ts`.

### Task 10: i18n, доки, версия

- [ ] `web.sidebar.tab_lsp`, `web.sidebar.lsp_*`, `web.sidebar.lsp_reason_*`
  (en+ru); `tests/i18n.test.ts`.
- [ ] `docs/agents/modules.md` (Web UI) — абзац про вкладку LSP;
  `AGENTS.md` — дополнить раздел 2.17.0; CHANGELOG — дополнить запись 2.17.0.
- [ ] `bun test && bun run quality`.

## Ручная проверка

1. `bun run mma` в TS-проекте → `/lsp doctor` → `✓ typescript · ok`.
2. `MMA_LSP_OFFLINE=1` в проекте без глобального сервера → `/lsp doctor` →
   `offline`, сеть не трогается.
3. Симуляция закрытой сети: заведомо битый `command` в `lsp.servers.typescript`
   → `binary-missing`/`spawn-failed` + `↳`-подсказка.
4. `lsp_check`/write при мёртвом сервере → `[LSP check failed]` + `hint:`
   класса; после 3 сбоев — прежнее `[LSP disabled]`.
5. `mma web` → сайдбар: вкладка LSP; открытие запускает проверку, строки
   серверов появляются, «Re-check» повторяет; `Alt+4`; прочерк при недоступном
   модуле.
