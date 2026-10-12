# MMA — Architecture v2: модульный каркас, enforcement, наблюдаемость

**Дата:** 2026-10-12 · **Статус:** target (нормативный документ) · **Ветка:** `docs/architecture-v2`
**Источник:** [аудит модулей 0.3.3](../analysis/2026-10-12-harness-module-audit.md) (~90
подтверждённых дефектов) + разбор `src/core/agent.ts`, `src/tools/executor.ts`,
`src/core/bootstrap/*`, `src/modules/registry.ts`.

**Что это.** Не план фиксов и не переписывание. Это спецификация **целевой архитектуры**:
какие инварианты обязаны быть истинны, где проходит граница «ядро / модуль», где стоит
единственная точка enforcement, и как устроен наблюдаемый позвоночник. План реализации
(волны, файлы, тесты) — отдельный документ; здесь фиксируется **что правильно**, чтобы волны
не расходились.

**Статус по отношению к коду.** Описанное ниже **не соответствует** текущему `src/`.
Спека нормативна для нового кода и для миграции. Фактическое состояние помечено `[AS-IS]`,
целевое — `[TARGET]`.

**Схемы и матрица контрактов** — в
[architecture-v2-schematics.md](./2026-10-12-architecture-v2-schematics.md): общая схема,
boot, фазы хода, цепочка enforcement, поток наблюдаемости, запись конфига и таблица
«кто с кем говорит».

---

## 0. Почему это не «ещё одна правка»

Аудит дал ~90 дефектов. Каждый чинится точечно, но почти все объединяются четырьмя
системными причинами — и именно они, а не симптомы, объясняют, почему часть из них
возвращается после каждого фикса:

| Класс | Симптомы в аудите | Первопричина |
|---|---|---|
| **Модуль — не модуль** | 5.1, 5.3, 5.5, 8.1, 6.11, 8.7 | нет контракта жизненного цикла; половина «модулей» вне реестра |
| **Нет fail-closed зоны** | 1.10, 5.8, 5.6, 8.7, 4.8 | модуль не может объявить себя критичным; отказ неотличим от «не нужно» |
| **Безопасность — соглашение** | 4.1, 4.4, 4.5, 4.6, 4.7, 4.11 | enforcement делегирован авторам тулов, а не точке исполнения |
| **Инварианты — текст** | 1.5, 1.13, 2.1, 3.2, 7.5 | правило живёт в AGENTS.md/комментарии, а не в проверке |

Добавьте сюда 13 новых находок, которых не было в аудите (см. §2) — из них 6 про
отсутствие владения данными (владелец тула, владелец промпт-блока, владелец лог-записи).

---

## 1. Инварианты

Это normative-часть. Каждый инвариант — проверяемый, а не провозглашаемый. Формат:
`INV-N` — описание — где проверяется.

### 1.1 Границы и владение

- **`INV-1. Единственный источник истины на единицу данных.** У каждого тул-определения
  есть **владелец** (`owner: string`), у каждого промпт-блока — **владелец**
  (`PromptBlock.source`), у каждой лог-записи — **модуль** (`SessionLogEntry.module`).
  Сейчас все три поля отсутствуют, поэтому «кто это произвёл» не восстановить.
  _Проверяется: `tests/arch/ownership.test.ts` (каждый тул/блок имеет непустого владельца)._

- **`INV-2. Один реестр тулов.** Тулы попадают в систему **одним** путём
  (`ToolRegistry.register` из `ModuleHost`). Сегодня три вызова в трёх местах bootstrap
  (`tools/index.ts:80`, `modules-phase.ts:182`, `modules-phase.ts:214`) и второй порядок
  схемы в `buildRunnerRegistry`.
  _Проверяется: guard-тест «вне `ModuleHost` `ToolRegistry.register` не вызывается»._

- **`INV-3. Направление зависимостей: ядро → модули.** Модуль **не импортирует** внутренние
  файлы ядра (`src/core/agent/*`). Сегодня `modules/context/manager.ts` тянет
  `core/agent/context-calibration`, `modules/execution/stuck-detector.ts` — `core/agent/canonical-args`,
  `modules/critic/evidence.ts` — `core/agent/tool-output`.
  Модуль зависит только от **публичного API ядра** (`src/core/api/`).
  _Проверяется: AST-guard (существует прецедент — `tests/webui-boundaries.test.ts`)._

- **`INV-4. Модуль не ходит в чужие тулы.** `modules/execution/module.ts` вызывает
  `performWebSearch` напрямую, минуя `ToolExecutor` ⇒ минуют allowlist, security, таймаут,
  плагин-хуки. Разрешён единственный путь — `ToolExecutor.execute`.
  _Проверяется: guard «вне `src/tools/` `tool.handler(` не вызывается»._

### 1.2 Отказоустойчивость

- **`INV-5. Модуль объявляет критичность.** `ModuleDef.critical?: boolean`. Если `critical`
  и `setup()` упал — **boot падает** с внятной ошибкой, а не продолжает «как получится».
  Если не `critical` — падение изолируется, модуль переходит в `degraded`, и это **видно**
  в `health()`, в баннере и в `session.jsonl`.
  Сегодня оба варианта выглядят одинаково: `withTimeout(mcpModule.initialize(), 10_000)` +
  warn (audit 8.x / `modules-phase.ts:117`).

- **`INV-6. Отказ модуля не равен отсутствию модуля.** Контракт различает
  `null` («блока нет») и `degraded` («блок есть, но неполон»). Сегодня
  `getSystemPromptBlock(): PromptBlock | null` — и индексер этим пользуется: во время
  пересборки карта проекта **исчезает из системного промпта** (audit 8.7), а модель этого
  не знает.
  _Проверяется: каждый `getSystemPromptBlock` реализует `PromptBlock | null | Degraded`._

- **`INV-7. Teardown обязателен.** Каждый модуль, который что-то запускает (процесс, сокет,
  watcher, подписка), обязан реализовать `teardown()`, вызываемый при shutdown. Сегодня
  LSP-серверы **не убиваются вообще** (audit 8.1 — у `ServerProcess` нет `pid`), а
  `RunPool.slotFor()` держит Agent+ContextManager+LSP без TTL/LRU (audit 6.11).
  _Проверяется: `ModuleHost.dispose()` закрывает всё; тест на отсутствие живых `ServerProcess`._

- **`INV-8. Есть один таймаут-владелец.** Таймауты модулей объявляются декларативно и
  применяются контейнером, а не каждый реализует `setTimeout` сам.
  _Проверяется: запрет `setTimeout` в `src/modules/**` без `config/timeouts.ts` (lint-правило)._

### 1.3 Enforcement

- **`INV-9. Безопасность проверяется в точке исполнения.** `ToolExecutor.execute()` до
  вызова хендлера применяет: allowlist → теги → **scope/protected/SSRF по декларации** →
  rate-limit → плагин-хуки → хендлер. Сегодня `execute()` проверяет **только**
  `ctx.toolAllowlist` (`executor.ts:186-194`), остальное делегировано 12 авторам тулов,
  двое из которых (`glob`, `bash`) не проверяют ничего (audit 4.1, 4.5).
  _Проверяется: guard «хендлер не импортирует `isPathWritable`/`protectedPathBlock`
  напрямую» — вместо этого декларирует `capabilities`._

- **`INV-10. «Забыть нельзя, потому что забывать нечего».** Новый тул без `capabilities`
  и без явного `securityCheck: "manual"` **не компилируется** (тип) — не «ломается на
  проде», не «должен вспомнить автор».
  _Проверяется: TypeScript-типы + `tests/arch/tool-capabilities.test.ts`._

- **`INV-11. Теги ограничивают исполнение, а не только видимость.** Сегодня `tool_tags`
  влияет только на `getAllForLLM` (схема), а в `execute()` его нет (audit 4.6): сабагент
  с `tool_tags:["file"]`, вызвавший `bash`, получит `bash`.

- **`INV-12. Fail-open только с записью.** Если продюсер возвращает «ок» после отказа,
  в логе **обязана** быть запись с причиной отказа. Иначе поломка неотличима от успеха —
  именно это делает критик и MoE-верификатор (audit 5.6, 5.8).
  _Проверяется: `tests/arch/fail-open-logged.test.ts` + review-вопрос._

### 1.4 Наблюдаемость

- **`INV-13. Ошибка называет модуль.** Любая ошибка/лог/событие несёт `source`.
  Формат: `mma` | `module:<name>` | `tool:<name>` | `core`.
  Сегодня `OutputEvent.source` объявлен (с примером в комментарии) и всегда пуст
  (`channel.ts:289`), `Logger.child()` — **0 вызовов** во всём `src/`, а
  `SessionLogEntry` не имеет поля модуля вовсе.

- **`INV-14. Ошибка — объект, а не строка.** Единый тип ошибки с полями
  `module / operation / kind / cause / recoverable`. Сегодня `logError(message: string)`
  (`core/session-logger.ts`), а `ToolResult.output` — строка без причины.
  Образец для подражания уже есть: `LlmError` (`llm/llm-errors.ts`) — но покрывает только
  LLM-транспорт.

- **`INV-15. Различие «сломался» и «сказал ок».** Для каждого fail-open пути обязателен
  отдельный сигнал (`critic.error`, `verify.error`, `tool_attempt` в `session.jsonl`).
  _Проверяется: список в `docs/agents/observability.md` (новый документ), guard на
  полноту._

### 1.5 Промпты

- **`INV-16. Сборка системного промпта — одна.** Сегодня три копии:
  `collectDynamicPromptBlocks` (`modules-phase.ts:314`),
  `buildRunnerDynamicBlocks` (`session-runner-scope.ts:197`) — и они **уже разошлись**
  (в раннере нет `pluginCapabilitiesBlock`). Дублирование уже работает как генератор багов.

- **`INV-17. Промпт-блок знает владельца и деградацию.** `PromptBlock.source` +
  `degraded?: { reason: string }`. При выпадении по бюджету лог должен говорить
  «indexer: project map (2400 ток.) не поместился», а не обрезанную первую строку контента
  (`PromptBuilder.blockLabel()` режет текст по `\n`).

### 1.6 Конфигурация

- **`INV-18. Один путь записи с декларацией последствий.** `ConfigStore.set(key, value)`
  возвращает не `reconfigure: boolean` (24 домена, 18 требуют reconfigure, и что именно
  делать — решает поверхность), а список **эффектов**: `["provider.rebuild"]`,
  `["context.resize"]`, `["i18n.reload"]` — и применяет их сам через реестр подписчиков.

- **`INV-19. Слой конфига не знает про устройство других доменов.**
  `applyProviderModelMemory` (`config/registry.ts`) — скрытая мутация
  `provider.entries[]` из слоя конфига; именно она стоила рассинхрона 2026-09-28.

- **`INV-20. Конфиг — снимок с версией, а не долгоживущая ссылка.** `WebUiState.config`
  держит снимок с bootstrap, и любая запись перезаписывает все домены из него, затирая
  параллельные изменения CLI (audit 7.5).

- **`INV-21. Модуль объявляет свои ключи.** Сейчас `config/registry.ts` +
  `registry-extra.ts` — ручная таблица на 156 ключей; модуль **не может** добавить
  настройку, не правя её руками, и UI получает плоский список вместо модели.

### 1.7 Границы петли

- **`INV-22. Один путь выполнения хода.** MoE-путь **заменял** одиночную петлю целиком,
  и `HallucinationGate`/`CriticGate`/`AuditGate`/`finalizeWithoutTools` не вызывались
  (audit 5.1). **MoE удалён** — см.
  [спеку удаления](./2026-10-12-remove-moe-design.md): путь один, обойти контур
  структурно невозможно. Параллельные сабагенты остались доступны через `parallelizable`
  на туле `subagent` — они идут через тот же `ToolExecutor`.
  _Проверяется: тест «в `Agent.run` ровно один вызов `executeSingleAgentLoop`;
  в `src/` нет `runWithMoE` / `moeHandled`»._

- **`INV-23. Нет файла, который держит состояние и оркестрирует, и собирает зависимости.**
  `src/core/agent.ts` — ~1620 строк, 23 приватных метода, внутри собирает critic-провайдера,
  critic tool-loop и evidence-pack. Правило «≤300 строк» теперь проверяется
  (`tests/arch/file-size.test.ts` + `.arch-allowlist.json`), но раздутые файлы (их 83,
  флагман — `agent.ts`) ещё не разбиты: `DEBT(split-bloated-files)`.

---

## 2. Новые находки (не в аудите)

Эти не были в отчёте `docs/analysis/2026-10-12-harness-module-audit.md`; найдены при
разборе под архитектурный вопрос.

| # | Дефект | Место | Инвариант |
|---|---|---|---|
| A | Три реестра тулов, у определения нет владельца ⇒ модуль нельзя выключить (только не вызвать `collectToolDefinitions`, после чего повторный `register` бросит) | `tools/index.ts:80`, `modules-phase.ts:182,214` | INV-1, INV-2 |
| B | `OutputEvent.source` объявлен с примером и всегда `""` | `output/channel.ts:289` | INV-13 |
| C | `Logger.child()` — 0 вызовов по всему `src/` | весь `src/` | INV-13 |
| D | `SessionLogEntry` без поля модуля; `logError(string)` | `session/store.ts`, `core/session-logger.ts` | INV-13, INV-14 |
| E | Сборка промптов продублирована в раннере и **уже разошлась** | `modules-phase.ts:314` vs `session-runner-scope.ts:197` | INV-16 |
| F | `PromptBlock` без владельца; `null` = «сломался» == «нет блока» | `core/types.ts`, `prompt-builder.ts:34` | INV-1, INV-6 |
| G | `applyProviderModelMemory` — скрытая мутация чужого домена внутри `setConfigValue` | `config/registry.ts` | INV-19 |
| H | `reconfigure: boolean` — флаг без декларации действия | `config/registry.ts` + `-extra.ts` | INV-18 |
| I | Реестр конфига — ручная таблица; модуль не может добавить ключ | `config/registry.ts`, `registry-extra.ts` | INV-21 |
| J | Модуль исполнения вызывает чужой тул мимо `ToolExecutor` | `execution/module.ts` | INV-4 |
| K | `modules/context` и `modules/execution` зависят от внутренних файлов `core/agent/` | `context/manager.ts`, `stuck-detector.ts` | INV-3 |
| L | 7 глобальных мутабельных синглтонов при per-session раннерах | `security/*.ts`, `processes/registry.ts` | INV-5 |
| M | `buildRunnerRegistry` создаёт второй порядок схемы тулов | `session-runner-scope.ts:42` | INV-2 |

---

## 3. Целевая архитектура

### 3.1 Слои и направление

```
Поверхности (Host):        REPL · mma web · mma serve · one-shot
                                    │  реализуют Host / CommandOutput
                                    ▼
┌──────────────────────── src/core ────────────────────────┐
│  Agent (петля + фазы)  ·  ToolExecutor (ENFORCEMENT)     │
│  ContextManager          ·  PromptAssembler              │
│  ConfigStore             ·  Observability (Logger/Log)   │
│  ModuleHost              ·  SecurityPolicy (enforcement) │
│  публичный API: src/core/api/**  ← единственное, что    │
│                                   видят модули           │
└───────────────────────────┬──────────────────────────────┘
                            │  (зависимости только вниз)
┌──────────────────────── src/modules ─────────────────────┐
│  lsp · browser · indexer · skills · mcp · memory ·        │
│  critic(service) · execution(plan) · onboarding · service  │
│  updater · certification · pipelines · artifacts · …        │
└───────────────────────────────────────────────────────────┘
```

**Ключевое изменение:** граница проходит **по ответственности**, а не по тому, где файл
лежит физически. Подсистемы, рассечённые пополам, сведены в одну сторону (см. §3.2).

### 3.2 Что в ядре, что в модуле

Критерий: **можно ли отключить и продолжить работать?** Если да — модуль. Если нет — ядро.

| Подсистема | [AS-IS] | [TARGET] | Почему |
|---|---|---|---|
| Петля агента, фазы | `core/agent.ts` (1903 стр.) | **ядро**, разбит на фазы | выключить нельзя |
| `HallucinationGate` | `core/agent/hallucination-gate.ts` + `modules/hallucination/` | **целиком ядро** | доверие к ответу — не опция |
| `CriticGate` | `core/agent/critic-gate.ts` + `modules/critic/` | **гейт — ядро**, клиент/провайдер/тулы — модуль | сегодня выключение меняет форму хода (`beforeFinish` исчезает) |
| `AuditGate` | `core/agent/audit-gate.ts` | **ядро** | то же |
| Компакция | `core/agent/compaction.ts` + `modules/context/manager.ts` | **ядро** | бюджет контекста неотключаем |
| `ContextManager` | `modules/context/` | **ядро** (`core/context/`) | то же; сейчас тянет `core/agent/*` |
| `ReasoningEffortResolver` + `policy.ts` | рассечены | **ядро** | влияет на каждый запрос |
| Enforcement политик | `modules/security/*` — библиотека, зовётся вручную | **ядро**: политики вызываются из `ToolExecutor` | INV-9 |
| `ToolExecutor` / `ToolRegistry` | `src/tools/` | **ядро** (`core/tools/`) | единственная точка исполнения |
| Наблюдаемость | 3 независимые системы | **ядро**, один позвоночник | INV-13/14 |
| Конфиг | `src/config/` + реестр на 156 ключей | **ядро** (`ConfigStore`) | INV-18…21 |
| `ModuleRegistry` | сборщик промптов | **ядро**: `ModuleHost` с lifecycle | INV-5…7 |
| lsp, browser, indexer, skills, mcp, memory | модули | **модули** | отключаемы |
| execution (план/stuck) | модуль вне реестра | **модуль в реестре** | но `critical: false` |
| critic (клиент/провайдер/тулы) | модуль | **модуль** | гейт в ядре дергает его |
| service, webui, updater, certification, pipelines, artifacts | модули | **модули** | поверхности |

**Что переезжает из `src/modules/` в `src/core/`:** `context/` (менеджер),
`hallucination/` (детекторы и проверки), гейт `critic`, `reasoning/` (policy).
**Что остаётся в модулях:** всё, что можно выключить.

### 3.3 `ModuleHost` — контракт модуля

```ts
export interface ModuleDef<C = unknown> {
  name: string;
  /** Порядок инициализации: этот модуль требует, чтобы `requires` поднялись первыми. */
  requires?: readonly string[];
  /** true — без него агент работает неправильно: падение setup() валит boot. */
  critical?: boolean;
  /** Таймаут setup в мс; применяется контейнером (INV-8). */
  setupTimeoutMs?: number;

  setup?(ctx: ModuleCtx<C>): Promise<void> | void;
  teardown?(): Promise<void> | void;
  /** Отказ не фатален: модуль живёт в degraded и это видно. */
  health?(): ModuleHealth;

  tools?(): ToolDefinition[];
  promptBlocks?(): PromptBlock[] | null | DegradedPromptBlock;
  hooks?(): AgentPlugin;
  /** Ключи конфига, которые модуль объявляет (INV-21). */
  configKeys?(): ConfigKeyDef[];
  /** Что нужно пересобрать при изменении этих ключей (INV-18). */
  onConfigChange?(keys: readonly string[]): void | Promise<void>;
}
```

`ModuleCtx` — **ролевой интерфейс**, не `WebUiState`-подобный композит:

```ts
interface ModuleCtx<C = unknown> {
  config: AppConfig;              // живой read-only
  logger: Logger;                 // уже с source = `module:<name>`
  bus: OutputBus;
  log: SessionLog;                // типизированный экспорт в session.jsonl
  data: ModuleData;               // типизированный доступ к сервисам ядра
  extensions: C;                  // модуль-специфичное (DI)
}
```

`ModuleHost` владеет: реестром, топологической сортировкой по `requires`, таймаутами,
проверкой `critical`, единым `dispose()` в обратном порядке, `health()`-сводкой для баннера и
`session.jsonl`.

**Переезд инкрементальный, по одному модулю.** Первые три (у них уже почти всё есть):

| Модуль | Что уже есть | Что добавить |
|---|---|---|
| `mcp` | `initialize()` + таймаут в bootstrap | `requires`/`critical`/`teardown`, перенос таймаута в хост |
| `lsp` | пул, idle-reap (декларативный) | `critical: false`, реальный `teardown` (audit 8.1: pid) |
| `browser` | условная регистрация | `critical: false`, `health()` (Chromium есть?) |

### 3.4 Инструменты: декларация + enforcement

`ToolDefinition` получает декларативные поля — **никакой логики безопасности в хендлере**:

```ts
export type ToolCapability =
  | { fs: "read" } | { fs: "write" } | { fs: "any" }
  | { net: true } | { proc: true } | { interactive: true }
  | { mem: true } | { subagent: true };

export interface ToolSecurityDecl {
  caps: ToolCapability[];
  /** Какие аргументы — пути / URL: enforcement применит к ним общие политики. */
  pathArgs?: string[];   // ["path"] | ["from","to"]
  urlArgs?: string[];    // ["url"]
  /** Явная отказка от декларации (только для действительно особых тулов). */
  manual?: { reason: string; reviewedBy: string; date: string };
}
```

`execute()` до хендлера:

```
allowlist → tags → [pathArgs → isPathInScope/isPathWritable + protected-paths]
          → [urlArgs → isUrlAllowed] → rate-limit → плагин-хуки → хендлер
```

Последствия:

- `glob` **автоматически** проходит path-фильтр по результату — забыть нельзя.
- `bash` получает `proc: true` и `manual: { reason: "shell — command-validator в хендлере", … }`.
  Это **видно** в `mma plugins show` / `/tools`, а не спрятано.
- `browser` и `attach_image` автоматически проходят SSRF-политику (audit 2.3, 2.5) —
  сегодня не проходят вообще.

### 3.5 Наблюдаемость: один позвоночник

```ts
type Source = `mma` | `module:${string}` | `tool:${string}` | `core`;

interface Diagnostic {
  source: Source;
  operation: string;         // "lsp.checkFile", "critic.verify", "tool.write_file"
  kind: "ok" | "degraded" | "failed" | "skipped" | "blocked";
  cause?: string;            // обязателен при kind !== "ok"  (INV-12)
  recoverable?: boolean;
  detail?: Record<string, unknown>;
}
```

Требования:

- `OutputEvent.source` **заполняется везде** (сейчас всегда `""`).
- `Logger.child()` включается в `ModuleHost` автоматически (сейчас 0 вызовов).
- `SessionLogEntry.module: string` — новое поле; тип записи расширяется шаблоном
  `module_${string}` по аналогии с существующим `onboarding_${string}`.
- `logError` переходит с `string` на `Diagnostic`.
- Каждый fail-open путь обязан завести отдельный тип события
  (`critic.error`, `verify.error`, `tool_attempt`) — это волна 0 плана фиксов, но она
  становится **частью контракта**, а не разовой задачей.

### 3.6 Промпты: один сборщик

`PromptAssembler` вместо трёх копий:

```ts
interface PromptBlock {
  content: string;
  source: string;              // INV-1
  priority: "critical" | "high" | "normal" | "low";
  essential: boolean;
  estimatedTokens: number;
  kind?: PromptBlockKind;      // instructions | project-map | …
  degraded?: { reason: string; since: string };  // INV-6
}
```

При выпадении по бюджету лог и `/sysprompt` показывают
`indexer: project map (2400 ток.) — не поместился`, а не обрезанный текст промпта.
При деградации модуля подставляется плашка «модуль X работает частично: <reason>» —
модель знает, чего ей не хватает.

### 3.7 Конфигурация: `ConfigStore`

```
ConfigStore.set("contextWindow", 65536)
  → валидация (ConfigKeyDef, владельцем модуля)
  → запись в домен (атомарно, temp+rename)
  → ConfigChange { key, value, effects: ["context.resize", "provider.rebuild"] }
  → подписчики по effects
  → ConfigChangeEvent в OutputBus + session.jsonl
```

Что это убирает: `reconfigure: boolean` (INV-18), `applyProviderModelMemory` (INV-19),
снимок `WebUiState.config` как источник истины (INV-20), ручную таблицу ключей, которую
нельзя расширить из модуля (INV-21).

### 3.8 Петля: фазы вместо одной функции

`executeSingleAgentLoop` (~640 строк) распадается на объекты с явными входами/выходами:

```
TurnCoordinator
 ├─ BeforeThink   (plugins, compaction, prompt refresh, prefix monitor)
 ├─ Think         (LLM stream, usage, reasoning policy, calibration)
 ├─ Observe       (ToolBatchExecutor, tool images, memo)
 ├─ Verify        (hallucination → critic → audit)
 └─ Finalize      (accept | retry | finalizeWithoutTools | stopReason)
```

Развилки в петле больше нет: после удаления MoE (см.
[спеку удаления](./2026-10-12-remove-moe-design.md)) `Agent.run` вызывает
`executeSingleAgentLoop` ровно один раз, а все гейты стоят **внутри** него. Поэтому
разбор на фазы — чистая декомпозиция функции, а не согласование двух путей.
Параллельные сабагенты не создают развилку: `ToolBatchExecutor` выполняет их через
`fork()` в той же фазе `Observe`.

---

## 4. Чего спецификация НЕ меняет

- **Контракты:** `LLMProvider`, SSE/REST веба, `mma serve` v1, plugin API, `--json`,
  версии конфига, имена тулов.
- **Исключение — MoE.** Удаление MoE — единственное изменение, которое **меняет
  контракт** (публичные экспорты `OrchestratorClient`/`OrchestratorConfig`, ключи
  `moe.*`/`orchestrator.*`, события `moe_*`). Оформлено отдельной спекой
  [remove-moe](./2026-10-12-remove-moe-design.md) и выполняется в этой же ветке.
- **Стиль чата** — STYLE.md остаётся каноном.
- **Поведение пользователя** в этой волне не меняется. Все волны — рефакторинг
  с сохранением поведения; каждая закрывается зелёным `bun test` + `bun run quality`.
- **Не переписываем `agent.ts` целиком.** Он распадается на ~5 фаз; каждая фаза — отдельный
  коммит с работающим тестом.

## 5. Порядок миграции

Порядок определяется не удобством, а риском: **наблюдаемость → владение → enforcement →
границы петли**.

| Волна | Содержание | Закрывает |
|---|---|---|
| **W0** Наблюдаемость | `Source` в `OutputEvent`, `Logger.child` в модулях, `SessionLogEntry.module`, `logError(Diagnostic)`, `PromptBlock.source` | A, B, C, D, F (INV-13, 14) |
| **W1** Владение данными | `ToolDefinition.owner`, единый `ToolRegistry`, `PromptAssembler`, `ModuleHost` (lifecycle) | A, E, F, M (INV-1, 2, 5, 7, 16, 17) |
| **W2** Enforcement | `ToolSecurityDecl`, проверки в `execute()`, enforcement тегов, `bash` в jail | INV-9…12 (audit 4.1, 4.4–4.7) |
| **W3** Конфиг | `ConfigStore` с эффектами, атомарная запись, модульные ключи | G, H, I (INV-18…21) |
| **W4** Границы | переезд `context`/`hallucination` в ядро, `core/api/*`, guard направления зависимостей | INV-3, 4 |
| **W5** Петля | фазы `TurnCoordinator` (MoE уже удалён — развилки нет) | INV-22, 23 |

Каждая волна — отдельная ветка, отдельный коммит на шаг, `bun test` + `bun run quality` зелёные.
W1 и W2 дают эффект независимо от W5: после них «модуль выключается чисто» и
«забытый security-check невозможен».

## 6. Гейты

Инварианты, которые не проверяются автоматически, — это текст, а значит через полгода
перестанут быть правдой. Поэтому:

- **Гейты живут как тесты** и прогоняются в `bun run quality` шагом `check:arch`
  (`bun test tests/arch tests/output`) — решение 2026-10-13: отдельный
  `scripts/check-arch.ts` не нужен, проверки и так используют AST-хелперы
  (`tests/helpers/import-graph.ts`) и общий allowlist-механизм тестов:
  - `ToolRegistry.register` вне `ModuleHost` — `tests/arch/tool-registration.test.ts`
    (INV-2; заодно запрещает `collectToolDefinitions` вне `ModuleRegistry`);
  - `tool.handler(` вне `src/tools/`, импорт `core/agent/*` из `src/modules/**` —
    `tests/arch/module-boundaries.test.ts` (INV-3/4);
  - владелец у каждого тула — `tests/tools/security-decl.test.ts` + типы `RegisteredTool`;
  - `console.*` / `process.*.write` — `tests/output/no-direct-console.test.ts`;
  - долг и его пометка — `tests/arch/debt-register.test.ts`.
- **Правило ≤300 строк — гейт** `tests/arch/file-size.test.ts` + `.arch-allowlist.json`
  (потолки только уменьшаются; запись снимается при ≤300). `setTimeout` в
  `src/modules/**` пока не покрыт.
- **Allowlist — явный и датированный.** Не «список исключений на будущее», а запись вида
  `{ file, lines, reason, decidedAt }`; файл без такой записи — падение.

Правило «≤300 строк» станет проверкой вместе с гейтом D. Исключения, признанные
осознанными (`agent.ts` до разбора W5, `repl.ts`, `line-editor.ts`, `stuck-detector.ts`,
`execution/module.ts`, `registry-extra.ts`, `webui/settings-api.ts`, `webui/turns.ts`),
фиксируются списком с датой — чтобы W5 могла их снять явно, а не «когда-нибудь».

## 7. Открытые решения

1. **`ProcessRegistry` и прочие глобальные синглтоны.** Нужно ли делать их per-session уже
   в W1, или достаточно, чтобы W1 дал `ModuleHost`-владельца? (Сейчас это аудит 4.9 + 7.8.)
2. **Реакция на `critical`-отказ.** Падать ли всему boot'у, или поднимать «безопасный режим»
   без критичного модуля? Для `mma serve` (тенант) ответ, вероятно, другой, чем для REPL.
3. **`runner`-специфичные модули.** Per-session раннеры делят модули с main-агентом
   (`session-runner-scope.ts`). Значит ли `ModuleHost` два инстанса, или один с
   per-session фасадом?
4. **Обратная совместимость `session.jsonl`.** Новые поля аддитивны; старые записи без
   `module` читаются как `module: "unknown"`.

## Связанные документы

- [Аудит модулей 0.3.3](../analysis/2026-10-12-harness-module-audit.md)
- [План фиксов аудита](../plans/2026-10-12-harness-module-audit-fixes.md)
- [feature-history.md](../agents/feature-history.md) — как реализовывались фичи
- [architecture.md](../agents/architecture.md) — описание текущего состояния
- [STYLE.md](../design/ui/STYLE.md) — канон стиля чат-вывода