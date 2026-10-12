# MMA — Architecture v2: схемы и контракты

**Дата:** 2026-10-12 · **К спецификации:** [architecture v2](./2026-10-12-architecture-v2-design.md)
**Читать, если:** правишь `src/core/`, `src/tools/`, добавляешь модуль/тул/ключ конфига.

Документ отвечает на два вопроса:
**1)** как течёт ход и где стоят границы, **2)** кто с кем говорит и по какому контракту.

Все схемы помечены `[TARGET]`. Текущее состояние — в
[architecture.md](../agents/architecture.md); расхождение само по себе является долгом (§5 спеки).

---

## 1. Общая схема: одна точка исполнения

Главная идея: **модуль ничего не защищает сам**. Модуль объявляет, что он делает; всё
остальное делает ядро.

```mermaid
flowchart TB
  subgraph HOST["Поверхности (Host)"]
    REPL["REPL"]
    WEB["mma web"]
    SERVE["mma serve"]
    ONESHOT["one-shot"]
  end

  subgraph CORE["ЯДРО — src/core"]
    BOOT["Bootstrap<br/>ModuleHost.setup()"]
    TURN["Agent: TurnCoordinator<br/>INIT→THINK→OBSERVE→VERIFY→OUTPUT"]
    EXEC["ToolExecutor<br/>⚡ ЕДИНСТВЕННАЯ ТОЧКА ENFORCEMENT"]
    POL["SecurityPolicy<br/>path · url · protected · rate"]
    CM["ContextManager"]
    PA["PromptAssembler"]
    CS["ConfigStore"]
    OBS["Observability<br/>Logger · SessionLog · OutputBus"]
    MH["ModuleHost"]
  end

  subgraph API["Публичный API ядра — src/core/api/*"]
    A1["ToolDefinition / ToolResult"]
    A2["ModuleDef / ModuleCtx"]
    A3["PromptBlock"]
    A4["Diagnostic"]
    A5["ConfigKeyDef"]
  end

  subgraph MOD["МОДУЛИ — src/modules (отключаемы)"]
    LSP["lsp"]
    IDX["indexer"]
    SK["skills"]
    MCP["mcp"]
    BR["browser"]
    MEM["memory"]
    EX["execution (план)"]
    CR["critic service"]
    ONB["onboarding"]
  end

  HOST --> TURN
  BOOT --> MH
  MH -.->|ModuleDef| MOD
  MOD -.->|tools/promptBlocks/hooks/configKeys| API
  API --> EXEC
  API --> PA
  API --> CS
  TURN --> EXEC --> POL
  TURN --> CM
  TURN --> PA
  CORE --> OBS

  classDef core fill:#1a3a5c,stroke:#5ba3d0,color:#e8f4ff
  classDef mod fill:#2d4a2d,stroke:#6faf6f,color:#eafaea
  classDef api fill:#4a3a1a,stroke:#d0a85b,color:#fff5e0
  classDef host fill:#3a1a3a,stroke:#a85bd0,color:#f5e8ff
  class TURN,EXEC,POL,CM,PA,CS,OBS,MH,BOOT core
  class LSP,IDX,SK,MCP,BR,MEM,EX,CR,ONB mod
  class A1,A2,A3,A4,A5 api
  class REPL,WEB,SERVE,ONESHOT host
```

**Правило слоёв:** ядро знает о модулях только через `src/core/api/*`. Модуль знает о ядре
только через тот же пакет. Никаких прямых импортов `modules → core/agent/*` и
`tool.handler(...)` вне `src/tools/` (INV-3, INV-4).

---

## 2. Boot: что происходит при старте

```mermaid
sequenceDiagram
  participant CLI as cli/main
  participant CS as ConfigStore
  participant MH as ModuleHost
  participant API as core/api
  participant M as Модуль
  participant EX as ToolRegistry
  participant PA as PromptAssembler

  CLI->>CS: load(configDir)
  CS-->>CLI: AppConfig (snapshot + version)
  CLI->>MH: setup(ctx)
  Note over MH: топологическая сортировка по ModuleDef.requires

  loop для каждого модуля по requires
    MH->>M: setup(ModuleCtx) с таймаутом setupTimeoutMs
    alt ok
      M-->>MH: tools() · promptBlocks() · hooks() · configKeys()
      MH->>EX: register(tool, owner="module:<name>")   ← единственный путь (INV-2)
      MH->>PA: add(source="module:<name>", …)
      MH->>CS: registerConfigKeys(keys)
    else упал и critical=true
      MH-->>CLI: boot FAILED — агент работает неправильно (INV-5)
    else упал и critical=false
      MH->>M: health() → degraded { reason }
      MH-->>MH: модуль помечен degraded, причина идёт в лог и баннер (INV-6/12)
    end
  end

  MH-->>CLI: ModuleReport (что поднялось, что degraded)
  CLI->>PA: assemble(blocks) → system prompt
```

Ключевое отличие от текущего: `ModuleReport` — **обязательный** артефакт. Сегодня
`withTimeout(mcp.initialize(), 10_000)` + `logger.warn` — это единственный след отказа,
и он неотличим от «MCP не настроен».

---

## 3. Ход: фазы и общий VERIFY

MoE сегодня **заменяет** петлю целиком и обходит все гейты (аудит 5.1). В `[TARGET]`
различие только в `Observe`: у MoE «действия» — сабтаски, у одиночного пути — вызовы тулов.
`Verify` и `Finalize` — общие.

```mermaid
flowchart TB
  IN["Agent.run(input)"] --> BEFORE

  subgraph TURN["TurnCoordinator — фазы хода"]
    BEFORE["BeforeThink<br/>• хуки плагинов<br/>• компакция<br/>• обновление system prompt<br/>• prefix-монитор"]
    THINK["Think<br/>• LLM stream<br/>• usage + калибровка контекста<br/>• reasoning policy"]
    OBS["Observe<br/>• ToolBatchExecutor<br/>• (MoE: MoEExecutor → сабтаски)<br/>• tool images, memo"]
    VERIFY["Verify ⚖️ ОБЩИЙ ДЛЯ ОБОИХ ПУТЕЙ<br/>• hallucination gate<br/>• critic gate<br/>• audit gate"]
    FIN["Finalize<br/>• accept | retry | finalizeWithoutTools | stopReason"]
    BEFORE --> THINK --> OBS --> VERIFY --> FIN
  end

  FIN -->|"retry"| THINK
  FIN -->|accept| OUT["AgentResult"]

  OBS -.->|только в одиночном пути| TB["ToolExecutor.execute()"]
  TB --> POL["SecurityPolicy"]
```

**Контракт между путями:**

| | Одиночный путь | MoE-путь |
|---|---|---|
| Observe | `ToolBatchExecutor` → `ToolExecutor.execute()` | `MoEExecutor` → сабтаски |
| Think | `llmProvider.chat` | оркестратор + сабагенты |
| **Verify** | **тот же** `HallucinationGate → CriticGate → AuditGate` | **тот же** |
| **Finalize** | **тот же** | **тот же** |

Инвариант INV-22 проверяется тестом «MoE-ход проходит те же гейты».

---

## 4. Вызов тула: enforcement

Единственное место, где применяются границы. Хендлер получает уже проверенные аргументы.

```mermaid
flowchart TB
  CALL["ToolCall { name, args }"] --> A1

  A1["1. allowlist<br/>ctx.toolAllowlist строгий:<br/>alwaysOn и теги НЕ обходят"]
  A1 -->|нет| R1["tool.not_allowed ❌"]
  A1 -->|да| A2

  A2["2. теги ⚠️ СЕЙЧАС ОТСУТСТВУЕТ (аудит 4.6)<br/>ctx.toolTags — исполнение, не только видимость"]
  A2 -->|нет| R2["tool.not_allowed ❌"]
  A2 -->|да| A3

  A3["3. pathArgs → isPathInScope / isPathWritable<br/>+ protected-paths (always-on)"]
  A3 -->|вне джейла| R3["file.path_not_allowed ❌"]
  A3 -->|ok| A4

  A4["4. urlArgs → isUrlAllowed (SSRF)"]
  A4 -->|private IP| R4["tool.url_blocked ❌"]
  A4 -->|ok| A5

  A5["5. rate-limit (сессионный, не глобальный)"]
  A5 -->|лимит| R5["tool.rate_limited ⚠️ recoverable"]
  A5 -->|ok| A6

  A6["6. плагин-хуки onBeforeTool<br/>fail-closed для security-хуков (аудит 4.8)"]
  A6 -->|blocked| R6["tool.blocked ❌ + причина"]
  A6 -->|ok| A7

  A7["7. таймаут + abort → killByCallId → cleanup"]
  A7 -->|timeout| R7["tool.timeout ❌ (kill процесса)"]
  A7 --> HANDLER["handler(ctx, args)<br/>чистая функция: только логика тула"]

  HANDLER --> A8["8. плагин-хуки onAfterTool"]
  A8 --> RES["ToolResult { success, output, errorMeta? }"]

  classDef bad fill:#5c1a1a,stroke:#d05b5b,color:#ffe8e8
  classDef ok fill:#1a3a5c,stroke:#5ba3d0,color:#e8f4ff
  class R1,R2,R3,R4,R5,R6,R7 bad
  class A1,A2,A3,A4,A5,A6,A7,A8,HANDLER ok
```

**Декларация тула** вместо проверок внутри хендлера:

```ts
const writeFileTool: ToolDefinition = {
  name: "write_file",
  tags: ["file"],
  caps: [{ fs: "write" }],
  pathArgs: ["path"],          // enforcement проверит сам
  // handler НЕ импортирует isPathWritable / protectedPathBlock
};
```

| Тип объявления | Что видит enforcement | Пример |
|---|---|---|
| `caps: [{fs:"write"}]` | требуется write-право, rate-limit на записи | `write_file` |
| `pathArgs: ["path"]` | scope + protected-paths по каждому пути | `read_file`, `glob` (по результату) |
| `urlArgs: ["url"]` | SSRF-политика | `web_fetch`, `browser`, `attach_image` |
| `caps: [{proc:true}]` + `manual:{reason}` | видимое исключение с причиной | `bash` |

Тул без `caps` и без `manual` **не компилируется** (INV-10) — это проверка типами,
а не ревью.

---

## 5. Наблюдаемость: один позвоночник, три стока

```mermaid
flowchart LR
  subgraph PROD["Продюсеры"]
    P1["модуль"]
    P2["тул"]
    P3["ядро (фаза)"]
    P4["gate (fail-open)"]
  end

  D["Diagnostic {<br/>  source: module:lsp | tool:bash | core<br/>  operation: lsp.checkFile<br/>  kind: ok|degraded|failed|blocked<br/>  cause?: обязателен при kind≠ok<br/>  recoverable?: boolean<br/>}"]

  PROD --> D

  D --> OBS["Observability<br/>журнал + шина"]
  OBS --> L1["session.jsonl<br/>SessionLogEntry.module"]
  OBS --> L2["~/.mma/logs/*.log"]
  OBS --> L3["OutputBus → OutputChannel / SSE / --json<br/>OutputEvent.source"]

  L3 --> U1["терминал (STYLE.md)"]
  L3 --> U2["mma web: Trace"]
  L3 --> U3["--json: diagnostics[]"]
```

**Правило INV-12:** если `kind !== "ok"`, поле `cause` обязательно. Пустой `cause`
при `degraded` — это баг: без него поломка неотличима от успеха (именно это делает
критик и MoE-верификатор — аудит 5.6, 5.8).

**Правило деградации:** модуль в `degraded` обязан отдавать `PromptBlock.degraded` с
причиной. Модель должна видеть «модуль X работает частично: <reason>», а не пустой блок
(сейчас карта проекта просто исчезает — аудит 8.7).

---

## 6. Конфигурация: запись → эффекты

```mermaid
flowchart TB
  IN["set(key, value)<br/>из REPL · CLI · REST · модуля"] --> V

  V["валидация по ConfigKeyDef<br/>(владелец: модуль или ядро)"]
  V -->|invalid| ERR["cli.config_invalid ❌ запись НЕ пишется"]
  V -->|ok| W

  W["атомарная запись домена<br/>write temp + rename (аудит 7.4)"]
  W --> EV["ConfigChange { key, value, effects[] }"]

  EV --> E1["context.resize → ContextManager"]
  EV --> E2["provider.rebuild → ProviderManager + Agent"]
  EV --> E3["i18n.reload → команды + комплитер"]
  EV --> E4["module.<name>.* → onConfigChange модуля"]

  EV --> BUS["OutputBus: {type:'config'} + session.jsonl"]
  BUS --> UI["веб-панель / селекторы — обновляются сразу"]

  E1 --> OK["готово"]
  E2 --> OK
  E3 --> OK
  E4 --> OK
```

Сравнение с `[AS-IS]`: сегодня `setConfigValue` возвращает `reconfigure: boolean`,
а **что именно делать — решает поверхность**; плюс `applyProviderModelMemory` мутирует
`provider.entries[]` из слоя конфига (INV-19), а `WebUiState.config` держит снимок с
bootstrap и перезаписывает все домены (INV-20).

---

## 7. Матрица контрактов

Кто с кем говорит, каким контрактом и в каком направлении.

| Проводник | Откуда | Куда | Контракт | Направление |
|---|---|---|---|---|
| `ToolCall` | Agent (Observe) | `ToolExecutor` | `ToolCall { id, name, args }` | ядро → ядро |
| `ToolDefinition` | модуль | `ToolRegistry` | `{ name, caps, pathArgs, urlArgs, handler }` | модуль → ядро |
| `ToolResult` | хендлер | Agent | `{ success, output, errorMeta?, images? }` | модуль → ядро |
| `PromptBlock` | модуль | `PromptAssembler` | `{ content, source, priority, essential, degraded? }` | модуль → ядро |
| `ConfigKeyDef` | модуль | `ConfigStore` | `{ key, domain, type, validate }` | модуль → ядро |
| `ConfigChange` | `ConfigStore` | подписчики | `{ key, value, effects[] }` | ядро → модуль |
| `ModuleDef` | модуль | `ModuleHost` | `{ name, requires, critical, setup, teardown, health, … }` | модуль → ядро |
| `Diagnostic` | всё | `Observability` | `{ source, operation, kind, cause? }` | любое → ядро |
| `ModuleHealth` | модуль | баннер / `/status` | `{ state: ok\|degraded\|down, reason? }` | модуль → UI |
| `OutputEvent` | ядро | терминал / SSE / `--json` | `{ source, level, kind, text, data }` | ядро → поверхность |
| `AgentResult` | Agent | Host | `{ success, text, stopReason?, interrupted?, usage }` | ядро → поверхность |
| `HostBridge` | ядро | плагин | `{ isBusy, submit, interrupt, subscribeOutput }` | ядро → плагин |
| `TurnSummary` | Agent | плагин | `{ success, durationMs, toolCalls, interrupted? }` | ядро → плагин |

**Чего в таблице нет и не должно быть:**

| Запрещено | Почему | Инвариант |
|---|---|---|
| модуль → `core/agent/*` | ядро перестаёт быть заменяемым | INV-3 |
| модуль → чужой `tool.handler` мимо `ToolExecutor` | обходят allowlist, security, таймаут | INV-4 |
| хендлер тула → `isPathWritable`/`protectedPathBlock` | enforcement уедет обратно в хендлеры | INV-9 |
| `ToolRegistry.register` вне `ModuleHost` | снова три реестра | INV-2 |
| глобальные синглтоны состояния (`processRegistry`, rate-limiter) | общие между сессиями | INV-5 |

---

## 8. Пять проверок, которые закрывают весь этот каркас

| Проверка | Тип | Что падает |
|---|---|---|
| `check-arch: file-size` | скрипт + `.arch-allowlist.json` | файл >300 строк без записи с датой и причиной |
| `check-arch: import-direction` | AST | `src/modules/**` импортирует `core/agent/*` |
| `check-arch: tool-handler` | AST | `tool.handler(` вне `src/tools/` |
| `tests/arch/ownership.test.ts` | рефлексия | тул/промпт-блок без `owner`/`source` |
| `tests/arch/tool-capabilities.test.ts` | типы + AST | тул без `caps`/`pathArgs`/`urlArgs`/`manual` |

Все пять — в `bun run quality` (волна W1). До неё §1 спеки держится **на дисциплине**,
и это осознанный долг, а не норма.