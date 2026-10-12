# W1 — стандарт модулей и взаимодействия с ядром: `ModuleHost`

**Дата:** 2026-10-13 · **Ветка:** `docs/w1-module-host-spec` (в рамках architecture v2)
**Статус:** draft (нужно подтверждение 3 решений из §4 — handoff §5)
**Нормативная база:** [architecture v2](./2026-10-12-architecture-v2-design.md) §3.3
(`ModuleHost`), INV-1/2/5/7/8/16 · [handoff](../plans/2026-10-12-architecture-v2-handoff.md) §4–5

**Причина.** Сегодня у модуля **нет контракта с ядром** — есть `AgentModule`
(`src/modules/types.ts`: `name` + три геттера) и россыпь ad-hoc швов:

- **Тулы регистрируются пятью путями** (INV-2 нарушен): `registerAllTools`
  (`src/tools/index.ts:142`), `moduleRegistry.collectToolDefinitions` →
  `toolRegistry.register` (`modules-phase.ts:184`), `setThinkingTool`
  (`agent-phase.ts:192`, `session-runner.ts:424`), runner-тулы
  (`session-runner-scope.ts:49,51`), плюс `pluginManager.attachToolRegistry`.
- **Lifecycle нет.** `MCPModule.initialize()` зовётся вручную с ad-hoc таймаутом
  10s (`modules-phase.ts:117`); `teardown` не вызывает никто; порядка `requires` нет.
- **Сборка промпта — три копии** (INV-16): `buildStaticPromptBlocks` +
  `collectDynamicPromptBlocks` (`modules-phase.ts`), `buildRunnerDynamicBlocks`
  (`session-runner-scope.ts`), и они уже разошлись (в раннере нет plugin-блока).
- **`Logger.child()` — 0 вызовов** (W0.2): модули создают `new Logger(prefix)`
  вручную, `source` не выделяется контейнером.

W1 вводит контракт и **один гейт**, который его охраняет (правило 5). Это тот
самый «общий стандарт», к которому мы шли через W0.

---

## 1. Границы W1

**Входит:** `ModuleDef`/`ModuleCtx`/`ModuleHost` (lifecycle), единый путь
регистрации тулов (`ToolDefinition.owner` + `ToolRegistry` через хост),
`PromptAssembler` (INV-16), `Logger.child()` из хоста (закрыть W0.2),
`scripts/check-arch.ts` (гейт).

**Не входит (другие волны):**
- enforcement возможностей тула (`caps`/`pathArgs`/`urlArgs`) — **W2**;
- `ConfigStore` с эффектами — **W3**;
- переезд `context`/`hallucination` в ядро, `core/api/*` — **W4**;
- `verify_error` (шов `ToolContext.sessionLog`) — отдельный шаг (см. handoff §3).

`ModuleHost` строится **в ядре** (`src/core/module-host.ts`), но **не** форсирует
`core/api`-границу (это W4): модули пока получают существующие типы ядра.

---

## 2. Контракт

`ModuleDef` — из спеки §3.3 1:1 (`name/requires/critical/setupTimeoutMs/setup/
teardown/health/tools/promptBlocks/hooks/configKeys/onConfigChange`).

`ModuleCtx` для W1 — **подмножество**, достаточное текущим модулям (полный
ролевой ctx — W4):

```ts
interface ModuleCtx<C = unknown> {
  config: AppConfig;          // живой read-only
  logger: Logger;             // child с source = module:<name>  (W0.2)
  bus: OutputBus;
  data: ModuleData;           // типизированный доступ к сервисам ядра (сужен)
  extensions: C;              // модуль-специфичное DI
}
```

`ModuleHost` владеет: реестром, топосортировкой по `requires`, таймаутами
setup (единый владелец, INV-8), проверкой `critical` (INV-5), единым
`dispose()` в обратном порядке (INV-7), `health()`-сводкой для баннера и
`session.jsonl`, и **единственным вызовом `ToolRegistry.register`** (INV-2).

**Совместимость с `AgentModule` — инкрементальная.** `getSystemPromptBlock()` /
`getToolDefinitions()` / `getPlugin()` остаются как тонкие адаптеры к
`promptBlocks()` / `tools()` / `hooks()` на время миграции. **`AgentModule`
сейчас публичный тип** (`src/index.ts:15`) — его замена/сужение это breaking
change для плагинов и фиксируется в CHANGELOG (`Changed`/`Removed`).

---

## 3. Миграция (по одному модулю)

| # | Модуль | Что уже есть | Что добавить |
|---|---|---|---|
| 1 | `mcp` | `initialize()` + таймаут | `requires`/`critical:false`/`teardown`, таймаут → в хост |
| 2 | `lsp` | пул, idle-reap, `getPlugin` | `critical:false`, реальный `teardown` (audit 8.1: pid) |
| 3 | `browser` | условная регистрация | `critical:false`, `health()` (Chromium есть?) |

Остальные модули переводятся после того, как первые три докажут хост.

---

## 4. Решения по открытым вопросам (handoff §5)

### 4.1 Глобальные синглтоны — per-session в W1?
`processRegistry`, `globalRateLimiter`, `globalSecurityPolicyManager`
процесс-глобальны по природе. `mma serve` уже даёт изоляцию «1 тенант = 1
процесс» (§8.2). **Решение:** в W1 синглтоны остаются процесс-глобальными;
`ModuleHost` получает их как `ModuleData` (владение — ядро, не модуль), но
**не** делает per-session. Per-session — отдельная волна, если появится
многотенантный процесс. Зафиксировать как осознанный долг.

### 4.2 Реакция на падение `critical`-модуля
Спека: падение `setup()` критичного модуля «валит boot». **Решение:**
`critical:true` + отказ `setup()` → **boot падает** с внятной причиной (не
молчаливый degrade), во всех поверхностях (REPL/one-shot/web/serve);
`critical:false` → модуль переходит в `degraded` через `health()` и это
видно (INV-6). «Безопасный режим» не вводим (YAGNI): `mma serve` = 1 процесс,
падение процесса честнее ложной уверенности. Ложная уверенность хуже отказа.

### 4.3 `ModuleHost` и per-session раннеры
Раннеры (`session-runner-scope.ts`) уже **делят** модули с main-агентом и
добавляют лишь свои session-scoped тулы. **Решение:** **один** `ModuleHost`
на процесс, поднятый в bootstrap; раннеры получают **фасад** (хендл для
`tools()`/`promptBlocks()` своей сессии), а не второй хост. Иначе два
`dispose()` владеют одними ресурсами — прямой конфликт с INV-7.
Session-специфичные тулы раннера регистрируются **через тот же** путь хоста.

---

## 5. `scripts/check-arch.ts` — гейт (правило 5)

Гейт вводится **вместе** с контрактом и растёт инкрементально. Проверки
(каждая — с явным allowlist и причиной):

| # | Проверка | Инвариант | Стартовое состояние |
|---|---|---|---|
| A | `ToolRegistry.register` вызывается только из `ModuleHost` | INV-2 | 6 call-site: `tools/index.ts:142`, `modules-phase.ts:184`, `agent-phase.ts:192`, `session-runner-scope.ts:49,51`, `session-runner.ts:424` (+ `attachToolRegistry`) — **отложено** до миграции (W1.6) |
| B1 | модуль не импортирует агент-петлю (`from ".../core/agent"`) | INV-3/4 | 4: `service/state.ts`, `webui/module.ts`, `webui/session/run-agent.ts`, `webui/settings/model-cache.ts` (allowlist) |
| B2 | модуль не импортирует `core/agent/*`-утилиты напрямую | INV-3 | 12 файлов (`context-log`, `canonical-args`, `tool-output`, `context-calibration`) + B1 = 16 всего; вынести утилиты в нейтральное место (W4) |
| C | модуль не вызывает чужой `tool.handler` напрямую | INV-4 | 0 — гейт строгий (пустой allowlist) |
| D | файл >300 строк — только из `.arch-allowlist.json` | правило 6 | **отложено**: 58 файлов >300 строк — фиксировать массово сейчас значило бы закрепить bloat |

**Реализовано в W1.4 (первая версия):** `tests/arch/module-boundaries.test.ts` — B1/B2/C.
**A и D** — отдельными шагами: A после W1.6 (миграция тулов), D — когда начнём реально резать файлы (W5).

Формат — как у существующих гвардов (`tests/output/no-direct-console.test.ts`):
чистый сканер + allowlist + падающий фикстур-тест. Размещение: `scripts/`
(запуск) + `tests/arch/*.test.ts` (юнит). Гейт добавляется в `bun run quality`.

**Порядок:** гейт A (единый путь тулов) включать **после** перевода первых
модулей, чтобы не держать allowlist из 5 записей дольше необходимого.

---

## 6. Порядок задач W1 (каждая — отдельная ветка, `bun test` + `quality` зелёные)

| # | Задача | Проверка |
|---|---|---|
| W1.1 | `ModuleHost` + `ModuleDef`/`ModuleCtx` (lifecycle, requires, timeout, critical, dispose, health) **без** миграции модулей | новый `tests/core/module-host.test.ts` |
| W1.2 | `Logger.child()` в модулях через хост (закрывает W0.2) | тест: `source = module:<name>`; `Logger`-инстансы в модулях — через child |
| W1.3 | Единый путь тулов: `ToolDefinition.owner` + регистрация через хост | перенос 5 call-site; INV-2 |
| W1.4 | `check-arch.ts` гейт A–D + `.arch-allowlist.json` + в `quality` | `tests/arch/*` |
| W1.5 | `PromptAssembler` — единая сборка блоков (INV-16) | тест: main и runner дают один состав |
| W1.6 | Миграция `mcp` → `lsp` → `browser` на `ModuleDef` | per-module тесты |

Порядок не произвольный: W1.1 — фундамент; W1.2–W1.4 дают эффект независимо;
W1.6 замыкает INV-2/5/7 на реальных модулях.

---

## 7. Что НЕ делаем

- Не делаем per-session синглтоны (§4.1) — отдельная волна.
- Не вводим «безопасный режим» boot (§4.2).
- Не вводим DI-контейнер с рефлексией: явный `requires` + ролевой ctx достаточно.
- Не переписываем все модули сразу: сначала три, хост должен доказать себя.
- Не делаем `caps`/enforcement — это W2.

## 8. Риски

- **Двойная регистрация тулов** на переходном периоде (`registerAllTools` +
  хост) → гейт A включать последним, но `owner` проставлять сразу.
- **Раннеры = второй потребитель**; фасад (§4.3) не должен давать им `dispose()`.
- **`AgentModule` — публичный экспорт** (`src/index.ts:15`): снятие/сужение —
  breaking change для внешних плагинов; фиксировать в CHANGELOG, проверить
  `examples/plugins/**` на импорт.
