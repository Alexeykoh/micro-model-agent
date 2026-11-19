# Code Review Fixes (2026-08-20) Implementation Plan

> **Статус:** исполнено (2026-10-20) — все 7 фаз закрыты (релизы 0.47.0/0.48.0–0.48.1,
> коммит `0b3d319c`): `exec.task_reminder`, `Agent.getModule()`, `security.*`-флаги и блок
> опасных конструкций, prefix-escape через `isInsideDir`, SSRF (`isIpPrivate` + manual redirect),
> санитизация логов, `timingSafeEqual`, права 0700/0600, opt-in интеграции, изоляция тестов,
> кеш токенов, async grep, byte-budget `read_file`, i18n. Чекбоксы проставлены по факту.
> Мелочи: спека `docs/specs/2026-08-05-model-certification-design.md:45` описывает spawn
> через `--model/--provider-url/--provider-key` вместо env-механизма; Task 17 (кап MoE)
> неактуален — MoE удалён.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Исправить все находки полного код-ревью MMA v2 (0.46.2): runtime-баги (i18n-ключ, `/lsp`), безопасность (валидация bash, prefix-escape, SSRF, секреты в логах, шифрование), изоляцию тестов, производительность (O(n²) подсчёт токенов, sync grep, read_file), мёртвый код, i18n rule #8, синхронизацию документации.

**Architecture:** Изменения локальные и не меняют поведение ядра агента: (1) исправления i18n и доступа к модулям — точечные правки `t()` и типизированных аксессоров; (2) безопасность — включение по умолчанию с Balanced-политикой + закрытие обходов валидаторов; (3) тесты — изоляция на `mkdtemp`, opt-in для интеграционных; (4) производительность — кеш токенов на Message, асинхронный ripgrep, байтовый read_file. Крупного рефакторинга `agent.ts`/`bootstrap.ts` (правило #1) в этом плане НЕТ — выделен отдельным follow-up (не блокирует выпуск).

**Tech Stack:** Bun + TypeScript, vitest (`bun test`), `tsc --noEmit`, i18n `t()` (en+ru), AES-256-CBC+HMAC.

---

## File Structure

| Файл | Действие | Ответственность |
| --- | --- | --- |
| `src/i18n/en.json`, `src/i18n/ru.json` | Modify | новый ключ `exec.task_reminder`, i18n-ключи для hardcoded строк |
| `src/core/agent.ts` | Modify | `getModule<T>()` аксессор, удаление дубля `updateProvider`, `t()` в exit/retry |
| `src/cli/repl-commands.ts` | Modify | починка `/lsp` через `getModule`, удаление `as any` |
| `src/modules/registry.ts` | Modify | метод `getModules()` (для `/lsp`) |
| `src/config/security.ts` | Modify | `enabled: true`, `bash.enabled: true`, `blockDangerousFlags: true`, операторы `; && \|\| \| $(`, `maxParallelTasks` в policies |
| `src/modules/security/command-validator.ts` | Modify | блок интерпретаторов `-c/-e`, многострочных, цепочек |
| `src/modules/security/path-validator.ts` | Modify | prefix-escape: `startsWith(base + sep)` |
| `src/tools/scope-check.ts` | Modify | то же |
| `src/modules/security/network-validator.ts` | Modify | блок private-IP + схема + helper `isIpPrivate` |
| `src/tools/web-fetch.ts` | Modify | `redirect:"manual"` + перепроверка редиректов |
| `src/tools/attach-image.ts` | Modify | `isUrlAllowed` перед fetch |
| `src/modules/browser/session.ts` | Modify | запрет `file:`/`chrome:` схем |
| `src/core/session-logger.ts` | Modify | санитизация `logUser`/`logToolCall`/`logToolResult` |
| `src/logger/app-logger.ts` | Modify | санитизация `logToolCall`/`logToolOutput`/`logREPL`/`logLLMRequest` |
| `src/modules/security/encryption.ts` | Modify | throw при неудачной записи ключа, `timingSafeEqual` |
| `src/modules/session/store.ts` | Modify | `mode: 0o700` dirs / `0o600` files, инкрементальный meta |
| `src/modules/context/manager.ts` | Modify | кеш токенов на Message |
| `src/tools/grep-tool.ts` | Modify | async `spawn` + kill-on-timeout |
| `src/tools/read-file.ts` | Modify | байтовый бюджет вместо чтения всего файла |
| `src/modules/execution/moe-executor.ts` | Modify | семафор `maxParallelTasks`, удаление мёртвого кода |
| `src/tools/subagent.ts` | Modify | удаление мёртвого `scopeRestored` |
| `src/llm/openai-compat.ts` | Modify | удаление `reasoningAcc`, dedup helpers |
| `src/cli/repl.ts` | Modify | `t()` для Ctrl+C |
| `src/core/version.ts` | Modify | единый `readVersion()` |
| `src/cli/main.ts`, `src/cli/commands.ts`, `src/cli/repl-commands.ts` | Modify | use `readVersion()` из `version.ts` |
| `src/modules/execution/plan-tool.ts` | Modify | `t()` для todo-строк |
| `src/modules/execution/execution-plugin.ts` | Modify | `t()` для STOP/test-run |
| `src/modules/execution/agent-moe.ts` (фактич. `src/core/agent-moe.ts`) | Modify | `t()` для MoE-меты |
| `src/modules/execution/stuck-detector.ts` | Modify | `t()` для hints |
| `bunfig.toml` | Modify | exclude `tests/integration/**` |
| `tests/integration/*.integration-test.ts` (5 файлов) | Modify | opt-in gate `MMA_RUN_INTEGRATION` |
| `tests/cli/repl-history.test.ts` | Modify | `mkdtemp` вместо `~/.mma` |
| `tests/security/session-isolation.test.ts` | Modify | `mkdtemp` вместо `~/` |
| `tests/core/bootstrap-model-loader.test.ts` | Modify | `mkdtemp` вместо `/tmp` |
| `tests/execution-scenario-tests.test.ts` | Modify | `mkdtemp` вместо `/tmp` (строка 453) |
| `tests/i18n.test.ts` | Modify | restore локали в `afterEach` |
| `tests/openai-compat.test.ts` | Modify | restore `global.fetch` в `afterEach` |
| `tests/config-security.test.ts` | Modify/создать | новые дефолты security |
| `tests/command-validator.test.ts` | Modify/создать | обходы bash |
| `tests/path-validator.test.ts` | Modify | prefix-escape |
| `tests/network-validator.test.ts` | Modify | private-IP, схемы |
| `tests/session-logger.test.ts` | Create | санитизация |
| `tests/context-manager.test.ts` | Modify | кеш токенов |
| `tests/grep-tool.test.ts` | Modify | async grep |
| `tests/read-file.test.ts` | Modify | байтовый бюджет |
| `tests/moe-executor.test.ts` | Modify | лимит параллельных |
| `README.md` | Modify | корректные дефолты, инструменты, REPL/CLI |
| `AGENTS.md` | Modify | версия, changelog, факты |
| `CHANGELOG.md` | Modify | синхронизация релизов |
| `docs/plugins.md` | Modify | version/minMmaVersion/onBeforeTool |
| `docs/specs/2026-08-05-model-certification-design.md` | Modify | env-механизм вместо флагов |
| `package.json` | Modify | версия 0.47.0 |

Порядок задач: TDD — тест → реализация → проверка → коммит. Проверка каждого таска: `bun test tests/<file>` + `tsc --noEmit`.

---

## Phase 1 — P0 runtime-баги

### Task 1: Недостающий i18n-ключ `exec.task_reminder`

**Files:**
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/ru.json`
- Test: `tests/i18n.test.ts`

- [x] **Step 1: Написать failing-тест**

В `tests/i18n.test.ts` добавить:

```typescript
it("defines exec.task_reminder in en and ru", () => {
  expect(t("exec.task_reminder", { task: "x" })).not.toBe("exec.task_reminder");
});
```

- [x] **Step 2: Запустить — убедиться, что падает**

Run: `bun test tests/i18n.test.ts`
Expected: FAIL — возвращается сырой ключ `exec.task_reminder` (обёртка не найдена в словаре).

- [x] **Step 3: Добавить ключ**

В `src/i18n/en.json` рядом с блоком `exec.*`:

```json
"exec.task_reminder": "Task: {task}. Continue making progress — do not repeat failed actions.",
```

В `src/i18n/ru.json`:

```json
"exec.task_reminder": "Задача: {task}. Продолжай работу — не повторяй неудачные действия.",
```

- [x] **Step 4: Запустить тест — PASS**

Run: `bun test tests/i18n.test.ts`
Expected: PASS.

- [x] **Step 5: Коммит**

```bash
git add src/i18n/en.json src/i18n/ru.json tests/i18n.test.ts
git commit -m "fix(i18n): add missing exec.task_reminder key (en+ru)"
```

---

### Task 2: Починка команды `/lsp` (типизированный доступ к модулям)

**Files:**
- Modify: `src/modules/registry.ts`
- Modify: `src/core/agent.ts`
- Modify: `src/cli/repl-commands.ts`
- Test: `tests/core/agent.test.ts`, `tests/registry.test.ts`

- [x] **Step 1: Написать failing-тест на `Agent.getModule()`**

В `tests/core/agent.test.ts` (создать агента через существующий `makeDeps`/мок bootstrap) добавить:

```typescript
it("exposes getModule() for CLI access", () => {
  const agent = new Agent(depsWithModuleRegistry);
  const mod = agent.getModule("lsp");
  expect(mod).toBeDefined();
  expect(agent.getModule("nope")).toBeUndefined();
});
```

`depsWithModuleRegistry` — тот же мок, что в `makeDeps`, плюс `moduleRegistry: new ModuleRegistry().register({ name: "lsp", getSystemPromptBlock: () => null })` (регистрация возвращает `this` для цепочки).

В `tests/registry.test.ts` добавить:

```typescript
it("listModules() returns registered names", () => {
  const r = new ModuleRegistry();
  r.register({ name: "lsp", getSystemPromptBlock: () => null });
  expect(r.listModules()).toEqual(["lsp"]);
});
```

- [x] **Step 2: Запустить — FAIL**

Run: `bun test tests/core/agent.test.ts tests/registry.test.ts`
Expected: FAIL — `getModule` не существует.

- [x] **Step 3: Реализовать**

В `src/core/agent.ts`, в интерфейс `AgentDeps` добавить поле:

```typescript
moduleRegistry?: ModuleRegistry;
```

(импорт `import type { ModuleRegistry } from "../modules/registry";`).

В класс `Agent` добавить метод:

```typescript
getModule<T>(name: string): T | undefined {
  return this.deps.moduleRegistry?.get(name) as T | undefined;
}
```

В `src/modules/registry.ts` метод `getModules()`:

```typescript
getModules(): AgentModule[] {
  return Array.from(this.modules.values());
}
```

В `src/cli/repl-commands.ts:497-499` заменить `as any`-цепочку:

```typescript
const lspModule = ctx.agent.getModule<LspModule>("lsp");
```

с импортом `import type { LspModule } from "../modules/lsp/module";` (проверить фактическое имя экспортируемого класса в `src/modules/lsp/module.ts`).

- [x] **Step 4: Запустить тесты — PASS + typecheck**

Run: `bun test tests/core/agent.test.ts tests/registry.test.ts && tsc --noEmit`
Expected: PASS, чисто.

- [x] **Step 5: Коммит**

```bash
git add src/core/agent.ts src/modules/registry.ts src/cli/repl-commands.ts tests/core/agent.test.ts tests/registry.test.ts
git commit -m "fix(cli): typed Agent.getModule() accessor, unbreak /lsp command"
```

---

### Task 3: Удаление дубля `updateProvider` + мёртвого `reasoningAcc`

**Files:**
- Modify: `src/core/agent.ts`
- Modify: `src/llm/openai-compat.ts`
- Test: `tests/core/agent.test.ts`, `tests/openai-compat.test.ts`

- [x] **Step 1: Удалить строку `agent.ts:1145`**

```typescript
(this.deps.toolExecutor as any).ctx.llmProvider = newProvider; // DELETE — updateProvider() уже делает это
```

- [x] **Step 2: Удалить `reasoningAcc`**

В `src/llm/openai-compat.ts` строки 109, 114-116:

```typescript
let reasoningAcc = ""; // DELETE
...
if (chunk.type === "reasoning" && chunk.content) {  // DELETE весь блок
  reasoningAcc += chunk.content;
}
```

- [x] **Step 3: Проверка**

Run: `bun test tests/core/agent.test.ts tests/openai-compat.test.ts && tsc --noEmit`
Expected: PASS, чисто. (Ни один тест не читал `reasoningAcc` — поведение `chat()` не меняется, reasoning-чанки по-прежнему `yield`-ятся вниз.)

- [x] **Step 4: Коммит**

```bash
git add src/core/agent.ts src/llm/openai-compat.ts
git commit -m "refactor: remove dead reasoningAcc accumulation and redundant updateProvider call"
```

---

## Phase 2 — Безопасность (P0/P1)

### Task 4: Включение security по умолчанию + блок обходов bash-валидации

**Files:**
- Modify: `src/config/security.ts`
- Modify: `src/modules/security/command-validator.ts`
- Modify: `src/cli/setup.ts`
- Test: `tests/config-security.test.ts` (если есть) / `tests/security/command-validator.test.ts`

- [x] **Step 1: Написать failing-тесты на обходы**

В `tests/security/command-validator.test.ts` добавить:

```typescript
import { isCommandAllowed } from "../../src/modules/security/command-validator";

const ON: any = {
  enabled: true,
  bash: {
    enabled: true,
    blacklist: ["rm", "curl"],
    whitelist: [],
    blockDangerousFlags: true,
    dangerousOperators: [";", "&&", "||", "|", ">", ">>", "`"],
    dangerousFlags: ["-rf", "--force"],
  },
};

describe("command-validator bypasses", () => {
  it("blocks interpreter -c invocations", () => {
    for (const cmd of ["bash -c 'rm -rf /'", "python -c 'import os'", "node -e 'require(\"fs\")'"]) {
      expect(isCommandAllowed(cmd, ON).allowed).toBe(false);
    }
  });
  it("blocks multi-line commands", () => {
    expect(isCommandAllowed("echo hi\nrm -rf /", ON).allowed).toBe(false);
  });
  it("blocks command chaining", () => {
    for (const cmd of ["echo hi; rm -rf /", "echo hi && rm -rf /", "echo hi | bash"]) {
      expect(isCommandAllowed(cmd, ON).allowed).toBe(false);
    }
  });
});
```

- [x] **Step 2: Запустить — FAIL**

Run: `bun test tests/security/command-validator.test.ts`
Expected: FAIL — все три кейса возвращают `allowed: true`.

- [x] **Step 3: Реализовать в `command-validator.ts`**

После блока `ALWAYS_BLOCKED` (строка ~138), до проверки операторов:

```typescript
// Interpreters with -c/-e execute arbitrary code and bypass the blacklist.
const INTERPRETER_FLAGS = /(?:^|\s)(bash|sh|zsh|dash|python|python3|node|bun|perl|ruby)(?:\s+)(?:-c|-e|--command|--eval)\b/;
if (INTERPRETER_FLAGS.test(trimmedCommand)) {
  return { allowed: false, reason: "Interpreter -c/-e invocation is blocked" };
}

// Multi-line commands can hide blacklisted commands after a newline.
if (/\r?\n/.test(trimmedCommand)) {
  return { allowed: false, reason: "Multi-line commands are blocked" };
}

// Chained commands bypass the base-command check (rm after ;).
if (/[;&|]\s*/.test(trimmedCommand) && /(^|\s)(rm|del|rd|dd|chmod|chown|wget|curl|nc|netcat|shutdown|reboot|mkfs|fdisk)\b/.test(trimmedCommand)) {
  return { allowed: false, reason: "Command chaining to a dangerous command is blocked" };
}
```

Добавить в blacklist `config/security.ts` (строка ~50): `bash`, `sh`, `zsh`, `dash`, `python`, `python3`, `node`, `bun`, `perl`, `ruby`, `del`, `rd`, `erase`, `taskkill`.

- [x] **Step 4: Включить по умолчанию**

В `src/config/security.ts`:
- строка 8: `enabled: true`
- строка 10: `enabled: true`
- строка 56: `blockDangerousFlags: true`
- строка 78: `dangerousOperators: [">", ">>", "2>", "2>>", ";", "&&", "||", "|", "`", "$("]`

В `src/cli/setup.ts` (около строки 237, где применяются ответы wizard-а): если пользователь не указал явно — применить `applySecurityPolicy("balanced")` (уже есть в `security-policies.ts`). Проверить текущий флоу и добавить ключ ответа «включить безопасность?».

- [x] **Step 5: Проверка**

Run: `bun test tests/security/command-validator.test.ts && bun test tests/config.test.ts && tsc --noEmit`
Expected: PASS. ВАЖНО: прогнать `bun test` целиком — включение security может сломать тесты тулов, которые теперь будут блокироваться (rm/curl/операторы). Все тесты, ожидающие успешного `bash` с `curl`/`rm`/`;`, нужно обновить на отключённый security-конфиг в тесте ИЛИ на безопасную команду.

- [x] **Step 6: Коммит**

```bash
git add src/config/security.ts src/modules/security/command-validator.ts src/cli/setup.ts tests/security/command-validator.test.ts
git commit -m "feat(security): enable security by default (balanced) + close bash validator bypasses"
```

---

### Task 5: Fix prefix-escape в path-validator и scope-check

**Files:**
- Modify: `src/modules/security/path-validator.ts`
- Modify: `src/tools/scope-check.ts`
- Test: `tests/security/path-validator.test.ts` (или существующий)

- [x] **Step 1: Написать failing-тест**

```typescript
it("does not treat sibling dir with shared prefix as in-scope", () => {
  const base = resolve("E:/projects/agent");
  const sibling = resolve("E:/projects/agent2/secret.txt"); // prefix "agent" shared
  expect(isPathInScope(base, sibling, undefined, { enabled: true, denied: [], allowed: [] }).allowed).toBe(false);
});
```

- [x] **Step 2: Запустить — FAIL** (текущий `startsWith("E:/projects/agent")` вернёт `true`)

- [x] **Step 3: Реализовать**

В `src/modules/security/path-validator.ts` строка 27 и 117:

```typescript
if (targetResolved !== baseResolved && !targetResolved.startsWith(baseResolved + sep)) {
```

(импорт `sep` из `path`). То же в `src/tools/scope-check.ts:12,18-19,35,41`:

```typescript
const contained = (t: string) => t === baseResolved || t.startsWith(baseResolved + sep);
```

- [x] **Step 4: Проверка**

Run: `bun test tests/security/path-validator.test.ts && tsc --noEmit` + полный `bun test tests/tools` (path-utils, read/write/edit/delete используют эти функции — sibling-кейс не должен ломать легитимные вложенные пути).

- [x] **Step 5: Коммит**

```bash
git add src/modules/security/path-validator.ts src/tools/scope-check.ts tests/security/path-validator.test.ts
git commit -m "fix(security): path containment requires separator, block sibling-prefix escape"
```

---

### Task 6: SSRF — private-IP, схемы, редиректы

**Files:**
- Modify: `src/modules/security/network-validator.ts`
- Modify: `src/tools/web-fetch.ts`
- Modify: `src/tools/attach-image.ts`
- Modify: `src/modules/browser/session.ts`
- Test: `tests/security/network-validator.test.ts` (или существующий)

- [x] **Step 1: Написать failing-тесты**

```typescript
describe("network-validator SSRF", () => {
  const ON = { enabled: true, deniedDomains: [], allowedDomains: [], requestTimeout: 15000, maxResponseSize: 15000 };
  it("blocks private IPs and link-local", () => {
    for (const u of ["http://127.0.0.1/", "http://localhost/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://192.168.1.1/", "http://[::1]/"]) {
      expect(isUrlAllowed(u, ON).allowed).toBe(false);
    }
  });
  it("blocks non-http(s) schemes", () => {
    expect(isUrlAllowed("file:///etc/passwd", ON).allowed).toBe(false);
    expect(isUrlAllowed("chrome://settings", ON).allowed).toBe(false);
  });
  it("allows public https", () => {
    expect(isUrlAllowed("https://example.com/x", ON).allowed).toBe(true);
  });
});
```

- [x] **Step 2: Запустить — FAIL**

- [x] **Step 3: Реализовать**

В `src/modules/security/network-validator.ts` добавить helper и проверки в `isUrlAllowed` (до deny/allow списков):

```typescript
const PRIVATE_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isIpPrivate(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return PRIVATE_HOST.test(h) || /^(fc|fd)/.test(h) || (h.includes(":") && h.startsWith("fe80"));
}

// В isUrlAllowed, сразу после try { const urlObj = new URL(url);:
const scheme = urlObj.protocol.toLowerCase();
if (scheme !== "http:" && scheme !== "https:") {
  return { allowed: false, reason: `Scheme "${scheme}" is not allowed` };
}
if (isIpPrivate(urlObj.hostname)) {
  return { allowed: false, reason: `Private address "${urlObj.hostname}" is blocked (SSRF)` };
}
```

В `src/tools/web-fetch.ts` строки 58-60 — редиректы вручную:

```typescript
const response = await fetch(url, {
  signal: AbortSignal.timeout(securityConfig?.requestTimeout || 15000),
  redirect: "manual",
});
if (response.status >= 300 && response.status < 400) {
  const loc = response.headers.get("location");
  if (!loc) return { success: false, output: t("error.fetch_failed", { message: "Redirect without location" }) };
  const next = new URL(loc, url).toString();
  const recheck = isUrlAllowed(next, securityConfig);
  if (!recheck.allowed) {
    logSecurityBlock(ctx.sessionId, "network_request", recheck.reason || "redirect blocked", sanitizeUrl(next));
    return { success: false, output: `[SECURITY BLOCKED] redirect: ${recheck.reason}` };
  }
  // follow one level
  const followed = await fetch(next, { signal: AbortSignal.timeout(securityConfig?.requestTimeout || 15000), redirect: "follow" });
  if (!followed.ok) { /* прежняя обработка !ok */ }
  // далее использовать `followed`
}
```

В `src/tools/attach-image.ts:49-51` перед fetch добавить `isUrlAllowed(url, securityConfig)` (вычислить `securityConfig` как в web-fetch через `getSessionSecurityConfig`).

В `src/modules/browser/session.ts:231-234` (действие `open`) добавить: отклонить `file:`/`chrome:`/`about:`/`data:` схемы и private-IP (переиспользовать `isUrlAllowed` + `isIpPrivate`), если `browser.enabled`-конфиг с security не отключает это явно.

- [x] **Step 4: Проверка**

Run: `bun test tests/security/network-validator.test.ts && bun test tests/tools/web-fetch.test.ts tests/attach-image.test.ts tests/modules/browser/session.test.ts && tsc --noEmit`
Expected: PASS. Реальные URL-тесты web-fetch (zed.dev) должны остаться `allowed` (публичный https).

- [x] **Step 5: Коммит**

```bash
git add src/modules/security/network-validator.ts src/tools/web-fetch.ts src/tools/attach-image.ts src/modules/browser/session.ts tests/security/network-validator.test.ts
git commit -m "fix(security): block SSRF (private IPs, schemes) + manual redirect re-validation"
```

---

### Task 7: Санитизация секретов в логах сессии

**Files:**
- Modify: `src/core/session-logger.ts`
- Modify: `src/logger/app-logger.ts`
- Test: `tests/session-logger.test.ts` (Create), `tests/logger.test.ts` (если есть)

- [x] **Step 1: Написать failing-тест**

```typescript
describe("session-logger sanitization", () => {
  it("redacts api keys from logUser and logToolCall", () => {
    const store = new SessionStore(tmpdir); // mок или временный
    const logger = new SessionLogger(store, "ses_1");
    logger.logUser("my api key sk-ABCDEF12345678901234 and token ghp_xxxxxxxxxxxxxxxxxxxxxxxx");
    const log = store.loadSessionLog("ses_1");
    expect(JSON.stringify(log)).not.toContain("sk-ABCDEF12345678901234");
    expect(JSON.stringify(log)).not.toContain("ghp_xxxxxxxxxxxxxxxxxxxxxxxx");
  });
});
```

- [x] **Step 2: Запустить — FAIL** (сырые значения пишутся)

- [x] **Step 3: Реализовать**

В `src/core/session-logger.ts` импортировать `sanitizeLogMessage` из `../modules/security/data-sanitizer`; прогнать через него контент в `logUser`, `logToolCall` (args), `logToolResult` (output). В `src/logger/app-logger.ts` — те же вызовы в `logToolCall`/`logToolOutput`/`logREPL`/`logLLMRequest` (пока существует `preview`/`content`).

- [x] **Step 4: Проверка**

Run: `bun test tests/session-logger.test.ts && bun test tests/core/session-logger.test.ts 2>$null; tsc --noEmit`
Expected: PASS. Существующие тесты сессий (session-manager/store) не должны сломаться — санитизация заменяет только совпавшие паттерны секретов.

- [x] **Step 5: Коммит**

```bash
git add src/core/session-logger.ts src/logger/app-logger.ts tests/session-logger.test.ts
git commit -m "fix(security): sanitize secrets in session/log file writes"
```

---

### Task 8: Шифрование — throw при неудачной записи ключа, timingSafeEqual

**Files:**
- Modify: `src/modules/security/encryption.ts`
- Test: `tests/security/encryption.test.ts` (существующий)

- [x] **Step 1: Написать failing-тест**

```typescript
it("throws when encryption key cannot be persisted", () => {
  expect(() => getOrCreateEncryptionKey({ keyPath: "Z:/nonexistent-dir/key" })).toThrow();
});
it("uses timing-safe comparison for HMAC", async () => {
  // decryptString с подделанным tag должен кидать, а не тихо проходить
});
```

- [x] **Step 2: Запустить — FAIL** (сейчас возвращает ключ несмотря на неудачную запись)

- [x] **Step 3: Реализовать**

В `getOrCreateEncryptionKey` (строки 52-61): вместо `return key` в `catch` — `throw new Error(...)` с понятным сообщением. Перед `writeFileSync` — `mkdirSync(dir, { recursive: true, mode: 0o700 })`.

В `decryptString` (строка 137): заменить `computedTag.equals(authTag)` на константное сравнение:

```typescript
import { timingSafeEqual } from "node:crypto";
...
if (computedTag.length !== authTag.length || !timingSafeEqual(computedTag, authTag)) {
  throw new Error("Authentication failed: invalid tag");
}
```

- [x] **Step 4: Проверка**

Run: `bun test tests/security/encryption.test.ts && tsc --noEmit`
Expected: PASS. Проверить, что `ConfigEncryptor`-потребители (config.ts) корректно обрабатывают throw (показывают warning, а не падают) — при необходимости обернуть в try/catch в `saveConfig`/load.

- [x] **Step 5: Коммит**

```bash
git add src/modules/security/encryption.ts tests/security/encryption.test.ts
git commit -m "fix(security): fail on key-write failure, timing-safe HMAC compare"
```

---

### Task 9: Права на файлы сессий (0700/0600) + инкрементальный meta

**Files:**
- Modify: `src/modules/session/store.ts`
- Test: `tests/modules/session/store.test.ts` (существующий)

- [x] **Step 1: Реализовать**

В `store.ts`: все `mkdirSync(dir, { recursive: true })` → `mkdirSync(dir, { recursive: true, mode: 0o700 })`. `writeFileSync`/`appendFileSync` для meta/history/session — добавить `{ mode: 0o600 }` (в appendFileSync вторым аргументом объект-опции: `appendFileSync(path, data, { encoding: "utf-8", mode: 0o600 })`).

В `appendMessage` (строки 181-186): вместо `saveMeta(id, meta)` (полная перезапись) — инкрементально обновлять только `messageCount`/`updatedAt`:

```typescript
const meta = this.loadMeta(id);
if (meta) {
  meta.messageCount = (meta.messageCount || 0) + 1;
  meta.updatedAt = msg.timestamp || new Date().toISOString();
  this.patchMeta(id, meta); // отдельный метод: read+merge только 2 полей
}
```

(или, проще и без риска: оставить `saveMeta`, но вынести её в `appendFileSync`-атомарность через временный файл + rename — перезапись meta.json небольшая, приоритет низкий; главное — permissions.)

- [x] **Step 2: Проверка**

Run: `bun test tests/modules/session/store.test.ts && tsc --noEmit`
Expected: PASS (на Windows mode-флаги не влияют, но не должны ломать).

- [x] **Step 3: Коммит**

```bash
git add src/modules/session/store.ts tests/modules/session/store.test.ts
git commit -m "fix(security): 0700/0600 perms for session dirs/files"
```

---

## Phase 3 — Изоляция тестов (P1)

### Task 10: Интеграционные тесты — opt-in

**Files:**
- Modify: `bunfig.toml`
- Modify: `tests/integration/agent.integration-test.ts`, `all-mechanics.integration-test.ts`, `llm-provider.integration-test.ts`, `plan-tools.integration-test.ts`, `todo-app.integration-test.ts`
- Test: сами файлы

- [x] **Step 1: Исключить из `bun test`**

В `bunfig.toml`:

```toml
[test]
root = "tests"
exclude = ["tests/integration/**", "node_modules/**", "_testing/**"]
```

- [x] **Step 2: Инвертировать gate в 5 файлах**

В каждом `*.integration-test.ts` заменить:

```typescript
const shouldSkip = process.env.MMA_SKIP_INTEGRATION === "1";
```

на:

```typescript
const shouldSkip = process.env.MMA_RUN_INTEGRATION !== "1";
```

и заголовочный комментарий обновить: `Run: bun run test:integration` (уже есть) + `Skip by default in bun test; opt-in with $env:MMA_RUN_INTEGRATION=1`.

- [x] **Step 3: Проверка**

Run: `bun test tests` — integration не должны исполняться (никаких обращений к localhost:1234), сумма по остальным файлам достигается.
Run: `MMA_RUN_INTEGRATION=1 bun test tests/integration/agent.integration-test.ts` — должен работать опционально (если есть локальный сервер; при отсутствии — пропускается `skipIf`).

- [x] **Step 4: Коммит**

```bash
git add bunfig.toml tests/integration
git commit -m "test: exclude integration suite from bun test, opt-in via MMA_RUN_INTEGRATION"
```

---

### Task 11: `repl-history.test.ts` — не трогать реальный `~/.mma`

**Files:**
- Modify: `tests/cli/repl-history.test.ts`

- [x] **Step 1: Реализовать**

Заменить `join(homedir(), ".mma", "repl-history")` на temp-dir. Проверить, как `Repl` определяет путь истории (вероятно `join(homedir(), ".mma", ...)` через `os.homedir()`). Если путь не инжектируется — временно переопределить `homedir()` (Bun: `import { homedir } from "os"` + `vi.spyOn` не работает на нативной функции; вместо этого — установить env `HOME`/`USERPROFILE` перед конструкцией `Repl`, если код читает `process.env.HOME ?? homedir()`) ЛИБО добавить инъекцию пути истории в `Repl` (предпочтительно):

```typescript
// repl.ts — конструктор принимает опциональный historyPath
constructor(opts: { ..., historyPath?: string })
// внутри: this.historyPath = opts.historyPath ?? join(homedir(), ".mma", "repl-history")
```

В тесте:

```typescript
const dir = mkdtempSync(join(tmpdir(), "mma-repl-history-"));
const historyPath = join(dir, "repl-history");
// ... конструировать Repl с historyPath, после теста rmSync(dir, { recursive: true, force: true })
```

Убрать `unlinkSync(historyPath)` из `afterEach` (удалять temp-каталог, а не реальный файл).

- [x] **Step 2: Проверка**

Run: `bun test tests/cli/repl-history.test.ts`
Expected: PASS, и реальный `~/.mma/repl-history` не создаётся/не удаляется.

- [x] **Step 3: Коммит**

```bash
git add src/cli/repl.ts tests/cli/repl-history.test.ts
git commit -m "test: isolate repl-history test to temp dir (was deleting real ~/.mma file)"
```

---

### Task 12: `session-isolation.test.ts` и `/tmp`-пути

**Files:**
- Modify: `tests/security/session-isolation.test.ts`
- Modify: `tests/core/bootstrap-model-loader.test.ts`
- Modify: `tests/execution-scenario-tests.test.ts`

- [x] **Step 1: Реализовать**

`tests/security/session-isolation.test.ts:16-17`:

```typescript
const root = mkdtempSync(join(tmpdir(), "mma-session-isolation-"));
const testProjectDir = join(root, "test-project");
const testTempDir = join(root, ".mma", "sessions", testSessionId, "temp");
```

`afterEach` → `rmSync(root, { recursive: true, force: true })`.

`tests/core/bootstrap-model-loader.test.ts` — заменить `/tmp/test-config-model-auto` и `/tmp/test-project` на `mkdtempSync(join(tmpdir(), ...))` в `beforeAll`/`beforeEach`, cleanup в `afterAll`.

`tests/execution-scenario-tests.test.ts:453` — `new ExecutionModule("/tmp", 8)` → `new ExecutionModule(mkdtempSync(join(tmpdir(), "mma-exec-scen-")), 8)`.

- [x] **Step 2: Проверка**

Run: `bun test tests/security/session-isolation.test.ts tests/core/bootstrap-model-loader.test.ts tests/execution-scenario-tests.test.ts`
Expected: PASS.

- [x] **Step 3: Коммит**

```bash
git add tests/security/session-isolation.test.ts tests/core/bootstrap-model-loader.test.ts tests/execution-scenario-tests.test.ts
git commit -m "test: replace homedir()/tmp hardcoded paths with mkdtemp isolation"
```

---

### Task 13: Restore локали и `global.fetch` в тестах

**Files:**
- Modify: `tests/i18n.test.ts`
- Modify: `tests/openai-compat.test.ts`

- [x] **Step 1: Реализовать**

`tests/i18n.test.ts` — в `afterEach` (или в конце ru-тестов):

```typescript
import { setLocale } from "../../src/i18n/index";
afterEach(() => setLocale("en"));
```

(проверить имя экспортируемого setter-а в `src/i18n/index.ts` — текущий тест уже его использует).

`tests/openai-compat.test.ts` — в начале файла сохранить оригинал, в конце восстановить:

```typescript
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
```

- [x] **Step 2: Проверка**

Run: `bun test tests/i18n.test.ts tests/openai-compat.test.ts tests/core/agent.test.ts`
Expected: PASS. (agent-тесты больше не должны флейкать из-за ru-локали.)

- [x] **Step 3: Коммит**

```bash
git add tests/i18n.test.ts tests/openai-compat.test.ts
git commit -m "test: restore locale and global.fetch after tests (kill shared-worker flakes)"
```

---

## Phase 4 — Производительность (P2)

### Task 14: Кеш токенов на Message (устранение O(n²))

**Files:**
- Modify: `src/modules/context/manager.ts`
- Test: `tests/context-manager.test.ts`

- [x] **Step 1: Написать failing-тест (поведенческий)**

Добавить кеш-флажок на сообщениях и проверить, что `getEstimatedTokens()` использует кеш (не пересчитывает всё):

```typescript
it("caches per-message token counts across getEstimatedTokens calls", () => {
  const counter = new CountingTokenCounter(); // мок, считающий вызовы count()
  const cm = new ContextManager(32768, { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 }, counter);
  cm.addMessage({ role: "user", content: "hello world" });
  const callsAfterAdd = counter.countCalls;
  cm.getEstimatedTokens();
  cm.getEstimatedTokens();
  expect(counter.countCalls - callsAfterAdd).toBeLessThan(5); // не полный пересчёт всех
});
```

- [x] **Step 2: Запустить — FAIL** (каждый вызов реэнкодит все сообщения)

- [x] **Step 3: Реализовать**

В `manager.ts`:
- На тип сообщения (или WeakMap `Map<Message, number>`) добавить кеш токенов.
- `estimateMessageTokens` сохраняет результат в кеш по объекту сообщения.
- `addMessage` считает токены только для нового сообщения (инкрементально к общему `this.cachedTokens`), инвалидирует общий кеш при compaction/`resize`/`reset`.
- `getEstimatedTokens()` возвращает `this.cachedTokens` без полного reduce (суммировать кешированные значения сообщений).
- Сообщения иммутабельны в рамках lifecycle — кеш безопасен; при замене массива после compaction — пересчитать.

Реализация минимальная (без смены публичного API):

```typescript
private msgTokens = new Map<Message, number>();
private totalTokens = 0;

private estimateMessageTokensCached(m: Message): number {
  let t = this.msgTokens.get(m);
  if (t === undefined) {
    t = this.estimateMessageTokens(m);
    this.msgTokens.set(m, t);
    this.totalTokens += t;
  }
  return t;
}
```

`getEstimatedTokens()` → `this.totalTokens + this.toolTokens`. Инвалидация в `compact()`/`reset()`/`resize()`: `this.msgTokens.clear(); this.totalTokens = 0;`.

- [x] **Step 4: Проверка**

Run: `bun test tests/context-manager.test.ts && tsc --noEmit` + `bun test tests/core/agent.test.ts` (агент использует snapshot/quality — должно остаться зелёным).
Expected: PASS. Проверить что `getQuality()`/`needsCompaction()` используют кешированный путь.

- [x] **Step 5: Коммит**

```bash
git add src/modules/context/manager.ts tests/context-manager.test.ts
git commit -m "perf(context): cache per-message token counts, eliminate O(n^2) re-encoding"
```

---

### Task 15: Асинхронный grep (kill-on-timeout)

**Files:**
- Modify: `src/tools/grep-tool.ts`
- Test: `tests/grep-tool.test.ts`

- [x] **Step 1: Написать failing-тест (таймаут прерывает)**

```typescript
it("kills rg on timeout", async () => {
  // большой паттерн/путь, который не завершится быстро; mock execFile, который не резолвится
});
```

Тест проще на уровне helper: извлечь `runSearch(command, args, timeoutMs)` как чистую функцию, вернущую Promise, и проверить kill-on-timeout через мок `spawn`.

- [x] **Step 2: Реализовать**

В `grep-tool.ts` заменить `execFileSync("rg", ...)` на `spawn` из `child_process` с таймаутом:

```typescript
import { spawn } from "child_process";

function runSearch(bin: string, args: string[], cwd: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 1) resolve("");
      else if (code === 0) resolve(out);
      else reject(new Error(err || `exit ${code}`));
    });
  });
}
```

Хендлер: `try { const out = await runSearch("rg", rgArgs, ctx.baseDir); ... } catch → fallback grep → runSearch("grep", grepArgs, ...)`. Сохранить семантику `status === 1 → no matches`.

- [x] **Step 3: Проверка**

Run: `bun test tests/grep-tool.test.ts && bun test tests/tools/grep-tool.test.ts 2>$null; tsc --noEmit`
Expected: PASS.

- [x] **Step 4: Коммит**

```bash
git add src/tools/grep-tool.ts tests/grep-tool.test.ts
git commit -m "perf(tools): async grep with kill-on-timeout (was blocking event loop)"
```

---

### Task 16: read_file — байтовый бюджет вместо чтения всего файла

**Files:**
- Modify: `src/tools/read-file.ts`
- Test: `tests/read-file.test.ts`

- [x] **Step 1: Написать failing-тест**

```typescript
it("reads only needed bytes for large files", () => {
  // mock readFileSync/fs.open чтобы увидеть, что запрошенный байтовый диапазон мал
});
```

Поведенческий: большой файл (5МБ), `limit: 50` — результат корректен и `fs`-вызовы читают ограниченный диапазон.

- [x] **Step 2: Реализовать**

В `read-file.ts` заменить `readFileSync(resolved, "utf-8")` + `split` на байтовое чтение:

```typescript
import { openSync, readSync, closeSync, statSync } from "fs";

// Оценка байт: строки ASCII ~1 байт, но допускаем UTF-8 множитель.
function readLineSlice(path: string, offset: number, limit: number, total: number): string {
  const stat = statSync(path);
  const byteStart = estimateByteOffset(path, offset);
  const buffer = Buffer.alloc(Math.min(stat.size, (limit + 1) * 128 + 64)); // запас на длинные строки
  const fd = openSync(path, "r");
  try {
    const bytes = readSync(fd, buffer, 0, buffer.length, byteStart);
    const chunk = buffer.subarray(0, bytes).toString("utf-8");
    const lines = chunk.split("\n");
    // Взять limit строк с учётом, что первая строка может быть частичной
    return lines.slice(0, limit).join("\n");
  } finally {
    closeSync(fd);
  }
}
```

Проще и безопаснее (сохранить точность `total`): оставить полное чтение только для файлов ≤ 1МБ, для больших — читать `offset+limit` строк через `fs.createReadStream` с `start`/`end` байтами (оценка `bytes = (limit+1)*256` от байтового смещения строки offset). Допустимо небольшое перечитывание, но НЕ всего файла. Для определения `total` строк больших файлов использовать `rg -c ""` или `wc -l` (через `execFile`), а не чтение целиком.

- [x] **Step 3: Проверка**

Run: `bun test tests/read-file.test.ts && bun test tests/tools/read-file.test.ts 2>$null; tsc --noEmit`
Expected: PASS, все существующие кейсы (offset/limit/header/truncated) зелёные.

- [x] **Step 4: Коммит**

```bash
git add src/tools/read-file.ts tests/read-file.test.ts
git commit -m "perf(tools): read_file reads bounded byte range, not the whole file"
```

---

### Task 17: Лимит параллельных задач в MoE-волнах

**Files:**
- Modify: `src/modules/execution/moe-executor.ts`
- Modify: `src/tools/subagent.ts` (если семафор нужен и там)
- Test: `tests/moe-executor.test.ts`

- [x] **Step 1: Написать failing-тест**

```typescript
it("caps concurrent subtasks per wave at maxParallelTasks", async () => {
  let active = 0, peak = 0;
  const deps = mockDepsWithExecutor(async () => { active++; peak = Math.max(peak, active); await sleep(20); active--; });
  const plan = planWithNIndependentSubtasks(8); // 8 независимых
  await runMoE(plan);
  expect(peak).toBeLessThanOrEqual(5); // дефолт maxParallelTasks
});
```

- [x] **Step 2: Реализовать**

В `moe-executor.ts` строки 325-349 — обернуть волну семафором:

```typescript
const maxParallel = this.deps.rateLimiter?.getConfig().maxParallelTasks ?? 5;
const limiter = this.deps.rateLimiter; // или createRateLimiter({ maxParallelTasks: maxParallel })

for (const subtask of wave) {
  if (limiter && !limiter.canStartParallelTask()) {
    await waitForSlot(limiter); // promise-очередь: освобождается по endParallelTask
  }
  limiter?.startParallelTask();
  const p = executeSubtask(...).finally(() => limiter?.endParallelTask());
  tasks.push(p);
}
await Promise.all(tasks);
```

Проверить, что `rateLimiter` доступен в deps MoE (если нет — инжектировать `RateLimiter` через deps, либо завести локальный семафор). Если `rateLimiter` не проброшен — использовать локальный счётчик с `maxParallel` из config.

- [x] **Step 3: Проверка**

Run: `bun test tests/moe-executor.test.ts && bun test tests/core/agent-moe.test.ts 2>$null; tsc --noEmit`
Expected: PASS. Обычные одиночные волны (≤5) работают без изменений.

- [x] **Step 4: Коммит**

```bash
git add src/modules/execution/moe-executor.ts tests/moe-executor.test.ts
git commit -m "feat(moe): cap concurrent subtasks per wave at maxParallelTasks"
```

---

## Phase 5 — Мёртвый код, дубликаты, i18n rule #8 (P2)

### Task 18: Удаление мёртвого кода

**Files:**
- Modify: `src/modules/execution/moe-executor.ts` (строки 121, 192, 359-361)
- Modify: `src/tools/subagent.ts:185,228`
- Modify: `src/cli/repl-commands.ts:418-419`
- Modify: `src/modules/plugins/manager.ts:69,83` (решить: удалить ИЛИ задействовать)

- [x] **Step 1: Реализовать**

- `moe-executor.ts`: удалить `lastResult` (2 присваивания), удалить метод `getChainMaxAttempts()` (grep — 0 вызовов).
- `subagent.ts:185`: удалить `let scopeRestored = false;` и ветку `if (!scopeRestored) { scopeRestored = true; ... }` — восстановить scope безусловно (проверить по коду, что условие было всегда истинным и поведение не изменится).
- `repl-commands.ts:418-419`: удалить пустой no-op `if` (автосейв уже обработан выше).
- `manager.ts:69,83`: `runOnBeforeTool`/`runOnAfterTool` — задействовать их в `executor.ts` (единый диспетчер) ИЛИ удалить из manager. Рекомендация: удалить из manager, оставить диспетчеризацию в executor (единственный реальный путь). Если executor завязан на manager-методы в других местах — наоборот, перевести executor на них.

- [x] **Step 2: Проверка**

Run: `rg -n "getChainMaxAttempts|scopeRestored|lastResult" src tests` → пусто (кроме новых). `bun test tests/modules/execution/moe-executor.test.ts tests/tools/subagent.test.ts tests/modules/plugins/manager.test.ts tests/executor.test.ts && tsc --noEmit`
Expected: PASS.

- [x] **Step 3: Коммит**

```bash
git add src/modules/execution/moe-executor.ts src/tools/subagent.ts src/cli/repl-commands.ts src/modules/plugins/manager.ts
git commit -m "refactor: remove dead code (lastResult, getChainMaxAttempts, scopeRestored, no-op if)"
```

---

### Task 19: Единый `readVersion()` + dedup запросов в openai-compat

**Files:**
- Modify: `src/core/version.ts` (добавить `readVersion` как экспорт-обёртку над `readMmaVersion`)
- Modify: `src/cli/main.ts`, `src/cli/commands.ts`, `src/cli/repl-commands.ts`
- Test: `tests/core/version.test.ts` (если есть) / `tests/cli/commands.test.ts`

- [x] **Step 1: Реализовать**

В `src/core/version.ts`:

```typescript
/** Legacy alias — use readMmaVersion(). */
export const readVersion = readMmaVersion;
```

(или перенести реализацию readVersion в version.ts и заменить вызовы). В `main.ts:17-31`, `commands.ts:14-28`, `repl-commands.ts:18-32` заменить локальные `readVersion()` на `import { readVersion } from "../core/version"`.

В `openai-compat.ts` — вынести общие helper-блоки (headers, abort-signal) в приватные методы (строки 178-183 vs 377-382, 191-201 vs 390-400).

- [x] **Step 2: Проверка**

Run: `bun test tests/cli/commands.test.ts tests/core/version.test.ts 2>$null; tsc --noEmit && bun run mma --help`
Expected: версия печатается корректно, typecheck чистый.

- [x] **Step 3: Коммит**

```bash
git add src/core/version.ts src/cli/main.ts src/cli/commands.ts src/cli/repl-commands.ts src/llm/openai-compat.ts
git commit -m "refactor: single readVersion() source, dedup openai-compat request helpers"
```

---

### Task 20: i18n rule #8 — hardcoded строки в t()

**Files:**
- Modify: `src/cli/repl.ts:269`
- Modify: `src/core/agent-moe.ts` (MoE мета/результаты)
- Modify: `src/modules/execution/execution-plugin.ts:263,409,414`
- Modify: `src/modules/execution/plan-tool.ts:660,668,671`
- Modify: `src/modules/execution/stuck-detector.ts` (getHints блоки)
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/i18n.test.ts` (parity-тест уже есть)

- [x] **Step 1: Реализовать**

Для каждой строки добавить ключ в оба файла i18n и заменить вызов `t()`. Ключи (en+ru):

- `repl.ctrl_c_interrupt`: `"Stopping agent... (press again to force)"` / `"Остановка агента... (ещё раз — принудительно)"` — заменить в `repl.ts:269`.
- `moe.planning` / `moe.executing` / `moe.verifying` / `moe.results_header` / `moe.crash` — для `agent-moe.ts` (сверять с существующим `moe.*` блоком в i18n — возможно, часть уже есть; добавить недостающие).
- `exec.stop_directive`: `"STOP. Step {stepId} is blocked. Do not continue — fix the issue or ask the user."` / `"СТОП. Шаг {stepId} заблокирован. Не продолжай — исправь проблему или спроси пользователя."` — для `execution-plugin.ts:263`.
- `exec.test_runner_fail` / `exec.test_runner_pass` — для инъекций `[test-runner]` (строки 409/414).
- `plan.subtasks_done` / `plan.no_subtasks` / `plan.step_label` — для `plan-tool.ts:660,668,671`.
- `exec.hint_*` — для блоков `getHints()` в `stuck-detector.ts` (перевести каждый блок; они уже рядом с `t()`-использующим кодом).

ВАЖНО: эти строки попадают в **контекст модели** (`<system-summary>`), поэтому перевод должен быть точным и не ломать семантику инструкций. Для model-facing строк допустимо оставить английский текст как значение ключа в ru.json (если модель обучена на EN-инструкциях) — но правило #8 требует наличия ключа; решение зафиксировать в коде комментарием.

- [x] **Step 2: Проверка**

Run: `bun test tests/i18n.test.ts && rg -n "\"[A-Z][a-z]+ [a-z]" src/modules/execution src/core src/cli | Select-Object -First 20`
Expected: parity-тест зелёный; хардкод-строк в обновлённых файлах нет.

- [x] **Step 3: Коммит**

```bash
git add src/cli/repl.ts src/core/agent-moe.ts src/modules/execution src/i18n/en.json src/i18n/ru.json
git commit -m "feat(i18n): route remaining hardcoded user/model strings through t() (rule #8)"
```

---

## Phase 6 — Синхронизация документации (P3)

### Task 21: README, AGENTS.md, CHANGELOG, plugins.md, cert-spec

**Files:**
- Modify: `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/plugins.md`, `docs/specs/2026-08-05-model-certification-design.md`

- [x] **Step 1: README — фактические дефолты**

Исправить в `README.md`:
- таблицу конфига: `maxToolIterations` 25 → **1000**, `stuckThreshold` 8 → **6**, `model` `qwen3.5-9b` → `qwen/qwen3.5-9b`.
- таблицу инструментов: убрать `question`/`approve` (выключены), исправить `web_browse` (это JS-less HTTP fetch, НЕ Playwright — Playwright это `browser`), добавить 11 пропущенных тулов (`chunk_query`, `download_file`, `process_list/log/kill`, `remember`, `recall`, `attach_image`, `enable_tools`, `lsp_check`, `verify`, `browser`).
- REPL-таблицу: убрать `/config set` (display-only), добавить реальные команды `/run`, `/image`, `/status`, `/reasoning`, `/wizard`, `/sysprompt`, `/provider`, `/model`, `/context`, `/reload`, `/plugins`, `/lsp`, `/skill`, `/clear` + алиасы.
- CLI-секцию: добавить `model certify/cert-status/cert-list/uncertify`, `context`, `provider use`, `security` (8 команд), `plugins list`, флаги `--json/-e/-d/--no-agents-md`.
- «13 модулей / 20+ инструментов» → «19 модулей / 33 инструмента».

- [x] **Step 2: AGENTS.md**

- «Current Version: 0.46.1» → **0.47.0**.
- `stuckThreshold` default 8 → **6** (два места).
- Memory: добавить `facts.md` в список файлов.
- Model Certification: добавить `--provider-key` и `--context-window` в сигнатуру команды.
- Добавить запись в changelog про этот план (нумерация — следующая свободная, после 56).

- [x] **Step 3: CHANGELOG.md**

- Перенести `[Unreleased]`-контент 0.37.0-эры в соответствующие релизы.
- Добавить записи 0.43.1–0.46.2 (перенести текст из AGENTS.md entries 51-56 + фактический diff git log).

- [x] **Step 4: docs/plugins.md**

- Обновить интерфейс `AgentPlugin`: добавить `version`, `minMmaVersion`, `source`; `onBeforeTool` → `boolean | string | Promise<boolean | string>`.
- Добавить раздел «Versioning & dedup» (текст из AGENTS.md Plugins).

- [x] **Step 5: cert-spec**

- `docs/specs/2026-08-05-model-certification-design.md:45` — заменить описание спавна `--model/--provider-url/--provider-key` на env-механизм `MMA_MODEL`/`MMA_PROVIDER_BASEURL`/`MMA_PROVIDER_APIKEY` (как в AGENTS.md).

- [x] **Step 6: Проверка**

Run: `rg -n "maxToolIterations|stuckThreshold|qwen3.5-9b" README.md` → совпадает с defaults.ts (1000/6/qwen/qwen3.5-9b). Parity-тест i18n зелёный.

- [x] **Step 7: Коммит**

```bash
git add README.md AGENTS.md CHANGELOG.md docs/plugins.md docs/specs/2026-08-05-model-certification-design.md
git commit -m "docs: sync README/AGENTS/CHANGELOG/plugins/cert-spec with v0.47.0 reality"
```

---

## Phase 7 — Релиз

### Task 22: Версия, полный прогон, тег

**Files:**
- Modify: `package.json`

- [x] **Step 1: Полный прогон перед бампом**

Run: `bun test && tsc --noEmit`
Expected: всё зелёное (интеграционные исключены).

- [x] **Step 2: Бамп версии (MINOR — включение security по умолчанию + новые i18n-ключи)**

```bash
npm version minor
```

(поднимет до 0.47.0 и создаст git tag).

- [x] **Step 3: Сборка**

```bash
bun run build:prod
```

- [x] **Step 4: Финальный коммит (если npm version не закоммитил всё) и push**

```bash
git push --follow-tags
```

---

## Self-Review

**1. Spec coverage.** Все находки код-ревью покрыты задачами:
- Runtime-баги: Task 1 (task_reminder), Task 2 (/lsp), Task 3 (reasoningAcc + дубль). ✅
- Security: Task 4 (bash-обходы + дефолт on), Task 5 (prefix-escape), Task 6 (SSRF), Task 7 (санитизация), Task 8 (encryption), Task 9 (perms). ✅
- Тесты: Task 10 (integration opt-in), Task 11 (repl-history), Task 12 (homedir//tmp), Task 13 (locale/fetch restore). ✅
- Perf: Task 14 (token cache), Task 15 (async grep), Task 16 (read_file bytes), Task 17 (MoE parallel cap). ✅
- Мёртвый код/dedup/i18n: Task 18, 19, 20. ✅
- Доки: Task 21. Релиз: Task 22. ✅
- **НЕ покрыто (осознанно):** рефакторинг `agent.ts` (1121) / `bootstrap.ts` (478) / `repl-commands.ts` (784) / split `stuck-detector` / `plan-tool` / `bash.ts` / i18n-ключи в `bash.ts` (`UNIX_TO_WIN_HINTS` — model-facing, локализация не требуется, но ключи rule #8 — follow-up), дубликаты в `session/store.ts` parse-pipeline, `(ctx as any).fileOperationsCount` ×5 (типизация ToolContext), README не полностью. Выделить в отдельный plan `complexity-refactor-followup.md`.

**2. Placeholder scan.** Код во всех шагах конкретный. Исключения-помеченные-решения: имя класса `LspModule` (проверить фактический экспорт), имя setter-а локали (проверить в `i18n/index.ts`), поведение `executor.ts`↔`manager.ts` при Task 18 (выбрать по grep). Все помечены «проверить фактический».

**3. Type consistency.** `getModule<T>(name)` используется в Task 2 и в repl-commands согласованно; `isIpPrivate`/`isUrlAllowed` — в Task 6; `readVersion` — Task 19. Имена согласованы между задачами.