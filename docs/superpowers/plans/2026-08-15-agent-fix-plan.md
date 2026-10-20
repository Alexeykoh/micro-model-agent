# План исправлений агента по пост-мортему двух сессий (qwen + gemma)

> **Статус:** исполнено (2026-10-20) — A: `findTypecheckRoot` для вложенных tsconfig;
> B: exit-код аудит-раннера; C: bridge-клиент (хвост stderr, `proc.on("error")`,
> одноразовый рестарт); D: отключение LSP-сервера + retry `initialize`; E: `exec.npm_exec_hint`.
> Чекбоксы проставлены по факту.

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ SUB-SKILL: superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans — выполнять по шагам. Шаги используют синтаксис чекбоксов (`- [ ]`).

**Цель:** Устранить ошибки агента, найденные в двух тестовых сессиях (обе строили веломагазин Vite+React+TS+Tailwind+shadcn):

- `ses_msudj2kx_ke4wml` (qwen/qwen3.5-9b, 264 сообщения) — **ложный успех**: финальный ответ и `step=done` при сломанном билде (`Failed to resolve import "@/lib/utils"` — 38 и 126 ошибок tsc), browser bridge падал 4 раза («Bridge process exited»), `npm error could not determine executable to run`.
- `ses_msuexz1b_lffcxt` (google/gemma-4-12b-qat, 65 сообщений) — **ложный успех**: финальный ответ при runtime-ошибке (`Uncaught SyntaxError ... export named 'Bike'`), LSP-таймаут на CSS (`LSP request timeout: initialize`), сессия прервана `LLM call aborted (interrupt)`.

**Архитектура:** 3 независимых точечных фикса в существующих модулях + 1 низкоприоритетный (Windows-хинты в bash). Никаких изменений поведения там, где не требуется. TDD: сначала тесты, потом код.

**Tech Stack:** Bun + TypeScript, vitest, строгий `tsc --noEmit`.

**Rules honored:** #7 TDD, #8 все строки через `t()`, #4 единый источник истины, #2 маленькие файлы. Выходной аудит и план-гейт не меняют свою механику — только качество проверок.

**Вне скоупа:** исправления поведения модели (алиас `@`, verbatimModuleSyntax, Tailwind v4 — это не баги харнесса), настройка провайдера, и рефакторинг `agent.ts` (нет loop-тест-харнесса).

---

## Задача A (P1): Финальный аудит не находит tsconfig во вложенном проекте → typecheck молча пропущен → ложный успех

**Проблема:** `Auditor.audit()` (src/modules/execution/auditor.ts:158-168) запускает typecheck ТОЛЬКО если `existsSync(join(baseDir, "tsconfig.json"))`. Агент часто создаёт проект во вложенной папке (`bicycle-shop/`), поэтому tsconfig.json лежит в `baseDir/bicycle-shop/`, проверка молча пропускается, и аудит проходит даже при 38 ошибках tsc. Это корень ложного успеха в ОБЕИХ сессиях.

**Файлы:**
- Modify: `src/modules/execution/audit-runners.ts` — новый `findTypecheckRoot()`
- Modify: `src/modules/execution/auditor.ts` — использовать найденный корень
- Test: `tests/execution-auditor.test.ts`

- [x] **Step 1: Написать падающий тест**

В `tests/execution-auditor.test.ts` добавить кейс: sandbox с проектом во вложенной папке:

```ts
// baseDir/<project>/tsconfig.json + baseDir/<project>/src/broken.ts
// с реальной ошибкой типов (напр. `const x: number = "str"`).
// План: 1 шаг, kind "create", status "done", description упоминает src/broken.ts.
// Ожидание: audit.typecheckError !== null (независимо от того, что
// baseDir/tsconfig.json отсутствует).
```

Также кейс-регрессия: без tsconfig вообще (ни в baseDir, ни во вложенных) typecheck не запускается → `typecheckError === null` и аудит не блокирует (существующее поведение).

- [x] **Step 2: Реализовать `findTypecheckRoot(baseDir, existingFiles)`**

В `src/modules/execution/audit-runners.ts` добавить и экспортировать:

```ts
import { dirname } from "path";

/**
 * Корень проекта для финального typecheck-аудита. Сначала подъём вверх от
 * baseDir (ближайший каталог с tsconfig.json), затем подъём вверх от каждого
 * реально существующего файла шага (агент кладёт проект во вложенную папку —
 * bicycle-shop/, tsconfig там, а не в baseDir; раньше проверка молча
 * пропускалась и аудит «проходил» при сломанном билде). Ищет ближайший
 * tsconfig.json. Возвращает null, когда tsconfig не найден нигде.
 */
export function findTypecheckRoot(
  baseDir: string,
  existingFiles: string[] = [],
): string | null {
  const candidates: string[] = [baseDir, ...existingFiles];
  let best: { depth: number; root: string } | null = null;
  for (const start of candidates) {
    let dir = resolve(start);
    // walk up from a file → its dirname first
    for (let depth = 0; depth <= 10; depth++) {
      if (existsSync(join(dir, "tsconfig.json"))) {
        if (!best || depth < best.depth) best = { depth, root: dir };
        break; // ближайший tsconfig вверх от этой точки
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return best?.root ?? null;
}
```

ВАЖНО: для файла (например `bicycle-shop/src/broken.ts`) первый кандидат — это его каталог (`bicycle-shop/src`), затем `bicycle-shop` (там tsconfig). Для baseDir — сам baseDir. `existingFiles` передаётся из `audit()` — это уже разрешённые через `findExistingFile()` абсолютные пути (они есть в `existingFiles` после цикла проверок).

- [x] **Step 3: Подключить в `Auditor.audit()`**

В `src/modules/execution/auditor.ts` заменить блок:

```ts
if (
  missingFiles.length === 0 &&
  leftoverFiles.length === 0 &&
  existsSync(join(this.baseDir, "tsconfig.json"))
) {
  try {
    typecheckError = await runTypecheck(this.baseDir);
  } catch {
    typecheckError = null;
  }
}
```

на:

```ts
if (missingFiles.length === 0 && leftoverFiles.length === 0) {
  const root = findTypecheckRoot(this.baseDir, existingFiles);
  if (root) {
    try {
      typecheckError = await runTypecheck(root);
    } catch {
      typecheckError = null;
    }
  }
}
```

Импорт: `import { runTests, runTypecheck, findTypecheckRoot, ... } from "./audit-runners";`. Убрать ставший ненужным `existsSync(join(...))` — но проверить, что `existsSync`/`join` ещё нужны в auditor.ts (они используются в `findExistingFile`/`findTypecheckRoot`? нет — в auditor.ts `join` используется только в этом месте; если так, убрать из импортов, чтобы не было unused).

`existingFiles` уже есть в scope `audit()` (массив `existingFiles` накапливается в цикле). Проверить, что он объявлен ДО блока typecheck.

- [x] **Step 4: Проверка**

```bash
bun test tests/execution-auditor.test.ts
bun test tests/execution-plan-deliverables.test.ts tests/execution-scenario-tests.test.ts
bunx tsc --noEmit
```

Ожидание: новые тесты проходят, старые — не сломаны, exit 0.

- [x] **Step 5: Коммит**

```bash
git add src/modules/execution/audit-runners.ts src/modules/execution/auditor.ts tests/execution-auditor.test.ts
git commit -m "fix(audit): resolve nested project root for final typecheck gate"
```

---

## Задача B (P1): `runTests` — `failed:-1` не признаётся падением, нераспознанный раннер прячет фейл

**Проблема:** `runTests()` (src/modules/execution/audit-runners.ts:93-106) при нераспознанном выводе раннера и ненулевом exit-коде возвращает `failed: -1`. В `auditor.ts:189` `testsFailing = testRun !== null && testRun.failed > 0` — `-1 > 0` ложно → падение тестов молча игнорируется, аудит проходит.

**Файлы:**
- Modify: `src/modules/execution/audit-runners.ts`
- Modify: `src/modules/execution/auditor.ts`
- Test: `tests/execution-auditor.test.ts`

- [x] **Step 1: Написать падающий тест**

В `tests/execution-auditor.test.ts`: план с verify-шагом и существующим тест-файлом, но `runTests` возвращает `failed: -1` (exit != 0, нераспознанный вывод). Ожидание: `testsFailing === true`, аудит `passed === false`.

Практически — замокать `runTests` или вставить в sandbox тест-файл с настоящим фейлом, вывод которого `detectTestResults` НЕ распознаёт (например тест на Python `pytest` без установленного pytest → stdout пустой/ошибка, exit != 0). Надёжнее замокать: в тесте `vi.spyOn(auditRunners, "runTests").mockResolvedValue({ checked: true, passed: false, failed: -1, passedCount: 0, detail: "unknown", command: "bun test" })`.

- [x] **Step 2: Исправить семантику `failed:-1`**

В `runTests()` нераспознанный случай: раз exit-код != 0, это падение, а не «неизвестно». Вернуть:

```ts
return {
  checked: true,
  passed: entry.exitCode === 0,
  failed: entry.exitCode === 0 ? 0 : 1,
  passedCount: 0,
  detail: output.slice(0, 200).trim(),
  command: "bun test",
};
```

(`failed: 1` вместо `-1` — «как минимум один тест-фейл», детали в `detail`.) Это делает `testsFailing` истинным при ненулевом exit. Комментарий над блоком обновить: «нераспознанный вывод + ненулевой exit = падение (детали в detail); нулевой exit = прошло».

Альтернатива с меньшим изменением: в `auditor.ts:189` изменить условие на `testRun !== null && !testRun.passed`. ВЫБРАТЬ ОДИН вариант. Рекомендация: править `auditor.ts` условие — меньше риск сломать другие потребители `TestRunCheck` (например подсказки stuck-detector). Проверить, кто ещё читает `failed`.

- [x] **Step 3: Проверка**

```bash
bun test tests/execution-auditor.test.ts
bun test tests/execution-scenario-tests.test.ts
bunx tsc --noEmit
```

- [x] **Step 4: Коммит**

```bash
git add src/modules/execution/audit-runners.ts src/modules/execution/auditor.ts tests/execution-auditor.test.ts
git commit -m "fix(audit): unrecognized non-zero test run counts as failing"
```

---

## Задача C (P2): Browser bridge — «Bridge process exited» без диагностики, нет retry

**Проблема:** `spawnBridge()` (src/modules/browser/bridge-client.ts:82-110) не имеет `proc.on("error")` (spawn-сбой вроде ENOENT node → unhandled 'error' → крэш), stderr отбрасывается (`proc.stderr.on('data', () => {})`), после неожиданного exit `send()` бросает «Bridge is not running» без авто-restart. В qwen-сессии это случилось 4 раза.

**Файлы:**
- Modify: `src/modules/browser/bridge-client.ts`
- Test: `tests/browser-bridge.test.ts`

- [x] **Step 1: Написать падающий тест**

В `tests/browser-bridge.test.ts`: замокать `spawn` так, чтобы он вернул child, который немедленно эмитит `error` (например `ENOENT`), и вызвать `bridge.launch(...)`. Ожидание: промис отклоняется с сообщением, содержащим текст ошибки spawn (не «Bridge is not running»), и процесс без утечки pending.

- [x] **Step 2: Обработка `error` + stderr + авто-restart**

В `spawnBridge()`:

```ts
private spawnBridge(): void {
  const script = bridgeScriptPath();
  const proc = spawn("node", [script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  this.proc = proc;
  // держим хвост stderr для диагностики
  proc.stderr.on("data", (chunk: Buffer) => {
    this.lastStderr = [...this.lastStderr.slice(-4), chunk.toString()];
  });
  proc.on("error", (err) => {
    this.failPending(`Bridge process failed to start: ${err.message}`);
    this.proc = null;
    this.rl = null;
  });
  proc.on("exit", (code) => {
    const stderrTail = this.lastStderr.join("").trim();
    this.failPending(
      stderrTail
        ? `Bridge process exited (code ${code}): ${stderrTail.slice(0, 300)}`
        : `Bridge process exited (code ${code})`,
    );
    this.proc = null;
    this.rl = null;
  });
  // readline / pending wiring как раньше
}

private failPending(error: string): void {
  for (const [, resolver] of this.pending) {
    resolver({ id: -1, ok: false, error });
  }
  this.pending.clear();
}
```

Добавить поле `private lastStderr: string[] = [];`. В `send()` — авто-restart при неожиданном падении (но не после `close()`): если `!this.proc` и команда не `close` — `spawnBridge()` и повторить команду ОДИН раз:

```ts
private async send(cmd, params = {}, retried = false): Promise<BridgeResponse> {
  if (!this.proc || !this.rl) {
    if (retried) throw new Error("Bridge is not running");
    this.spawnBridge();
    return this.send(cmd, params, true);
  }
  // ... как раньше
}
```

(рекурсия с флагом `retried` = один повтор, защита от бесконечного цикла при падающем spawn).

- [x] **Step 3: i18n + поверхностная проверка**

`browser.error` в `src/i18n/en.json:479` / `ru.json` уже оборачивает message — новых ключей не нужно (сообщение приходит из bridge). Проверить, что `session.ts:173-178` (`catch` → `t("browser.error")`) передаёт полное сообщение. Запустить:

```bash
bun test tests/browser-bridge.test.ts tests/browser-session.test.ts
bunx tsc --noEmit
```

- [x] **Step 4: Коммит**

```bash
git add src/modules/browser/bridge-client.ts tests/browser-bridge.test.ts
git commit -m "fix(browser): bridge spawn error diagnostics + one-shot restart"
```

---

## Задача D (P3): LSP — таймаут `initialize` на CSS, отключение по-языково

**Проблема:** в gemma-сессии `LSP request timeout: initialize` на CSS-файлах. `vscode-css-languageserver` грузится через npx (первый запуск — скачивание), 10с таймаута (config.ts:61-67) не хватает. Плюс модуль отключает LSP глобально после 3 фейлов (`module.ts:94`) — таймаут CSS убивает проверки и для TypeScript.

**Файлы:**
- Modify: `src/modules/lsp/config.ts` — увеличить таймаут CSS
- Modify: `src/modules/lsp/module.ts` — отключение по языку (серверу), не глобально
- Modify: `src/modules/lsp/client.ts` — один retry на `initialize` при таймауте
- Test: `tests/lsp-module.test.ts`

- [x] **Step 1: Написать падающий тест**

В `tests/lsp-module.test.ts`: mock `client.checkFile`, который бросает для CSS-файла 3 раза подряд и успешен для TS-файла. Ожидание нового поведения: после 3 фейлов на CSS проверки CSS прекращаются, но проверка TS-файла продолжает работать (`isLspDisabled()` для CSS = true, для TS = false).

- [x] **Step 2: Per-server disable в `LspModule`**

Заменить глобальные `consecutiveFailures` / `lspDisabled` на:

```ts
private failuresByServer = new Map<string, number>();
private disabledServers = new Set<string>();

// ключ сервера — стабильный идентификатор конфигурации
private serverKey(server: LspServerConfig): string {
  return `${server.command}:${(server.args ?? []).join(" ")}`;
}
```

В `onAfterTool`: `const key = this.serverKey(serverConfig); if (this.disabledServers.has(key)) return;` в начале; при успехе `this.failuresByServer.set(key, 0)`; при ошибке инкремент, при `>= MAX` → `disabledServers.add(key)` + одно сообщение `[LSP disabled ...]`. `isLspDisabled()` оставить (тесты используют) — возвращать `disabledServers.size > 0`, но добавить тест-хук `isServerDisabled(key)`.

- [x] **Step 3: Retry initialize в `LspClient`**

В `checkFile()` (client.ts:46-55) обернуть `sendRequest("initialize", ...)` в маленький retry-цикл — при таймауте (`LSP request timeout: initialize`) повтор один раз, с полным сбросом (shutdown + startServer заново):

```ts
let initResult: unknown;
try {
  initResult = await this.sendRequest("initialize", { ... }, timeout);
} catch (e) {
  if (!(e instanceof Error) || !e.message.includes("initialize")) throw e;
  await this.shutdown();
  await this.startServer(config, projectRoot);
  initResult = await this.sendRequest("initialize", { ... }, timeout);
}
```

Проверить, что после `shutdown()` флаг `this.initialized` сброшен (shutdown уже делает `this.initialized = false` — client.ts:277).

- [x] **Step 4: Таймаут CSS в конфиге**

В `config.ts` css: `timeout: 10000` → `timeout: 20000` (как typescript).

- [x] **Step 5: Проверка**

```bash
bun test tests/lsp-module.test.ts tests/lsp-command.test.ts tests/lsp-project-root.test.ts
bunx tsc --noEmit
```

- [x] **Step 6: Коммит**

```bash
git add src/modules/lsp/config.ts src/modules/lsp/module.ts src/modules/lsp/client.ts tests/lsp-module.test.ts
git commit -m "fix(lsp): per-server disable + initialize retry + CSS timeout"
```

---

## Задача E (P4, низкий приоритет): Windows/npm-хинты в bash

**Проблема:** обе сессии: `npm error could not determine executable to run` (модель запускала `bunx`/`npx` на пакете без bin, либо `npm run dev` в cmd.exe). Агент долго искал причину. Правило #9/#10 — хинт по фактической ошибке, не по ключевым словам.

**Файлы:**
- Modify: `src/tools/bash.ts` — новый `exec.` хинт по распознанной ошибке npm
- Modify: `src/i18n/en.json` / `ru.json` — ключ
- Test: `tests/execution-forbidden-cmd.test.ts` или новый

- [x] **Step 1: Написать тест**

В `tests/execution-forbidden-cmd.test.ts` (или `tests/execution-scenario-tests.test.ts`): bash-вывод, содержащий `could not determine executable to run`, должен добавлять хинт (например «run the package's script via `npm run <script>` or check that a `bin` is declared in package.json; on Windows prefer `bun run`»).

- [x] **Step 2: Реализовать**

В `src/tools/bash.ts` в секцию hint/recovery (рядом с `UNIX_TO_WIN_HINTS`, строка ~479-510) добавить распознавание ошибки:

```ts
const NPM_EXEC_HINT = /could not determine executable to run/i;
// в обработчике вывода при failure:
if (NPM_EXEC_HINT.test(output)) {
  output += `\n\nHint: "could not determine executable to run" — no "bin" for that package/script. Use "npm run <script>" (script must exist in package.json) or "bunx <pkg>" for a package that declares a bin.`;
}
```

(без `t()`? — НЕТ, правило #8: через `t("exec.npm_exec_hint")`. Добавить ключ в en.json/ru.json.)

- [x] **Step 3: Проверка**

```bash
bun test tests/execution-forbidden-cmd.test.ts tests/execution-scenario-tests.test.ts
bunx tsc --noEmit
```

- [x] **Step 4: Коммит**

```bash
git add src/tools/bash.ts src/i18n/en.json src/i18n/ru.json tests/execution-forbidden-cmd.test.ts
git commit -m "fix(bash): hint for npm 'could not determine executable to run'"
```

---

## Self-Review

- **Спека:** A/B — ложный успех обеих сессий (типчек не бежал: корень — вложенный проект + `failed:-1`); C — 4 падения bridge; D — LSP-таймаут CSS + отключение всего LSP из-за одного языка; E — npm-ошибка, встреченная в обеих сессиях.
- **Правило #8:** ни одной новой пользовательской строки без `t()`; в D/E — новые ключи i18n en+ru.
- **TDD:** каждый фикс сначала тестом, затем реализацией.
- **Проверка на реальных артефактах** (после всех задач, вручную): пересобрать `_testing/qwen9b_32k/bicycle-shop` (tsc exit 0 сейчас, но vite build падает по `@/lib/utils`) и `_testing/gemma-4-12b-qat_32k/bike-store` (tsc exit 2: TS6133 React unused в Footer/Header/Hero) — финальный аудит должен теперь ловить оба.
- **Версия:** PATCH-бамп (багфиксы, новые i18n-ключи). Обновить раздел «Current Version» в AGENTS.md.

## Развернуть на реальных артефактах (checkpoint)

Перед `bun run build:prod` и публикацией — прогнать регрессию на обеих сессиях:

```bash
bun test
bunx tsc --noEmit
# артефакты из сессий (уже в _testing/)
bun run mma "Собери проект и проверь, что билд проходит" --no-agents-md --exit-on-complete -d _testing/regression-qwen/
```