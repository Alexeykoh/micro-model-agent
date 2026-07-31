# MMA v2 — Architecture Design

**Date:** 2025-07-28
**Status:** Approved
**Branch:** `easy_mma`
**Engine:** Bun + TypeScript
**Default model:** Qwen3.5 9B 32K (thinking)

---

## 1. Overview

MMA v2 — modular AI coding agent designed for 9B parameter models with 32K context.
Complete rewrite from MMA v1. Key differences:

- **KISS** — simple state machine loop, no god objects
- **Modular** — every feature is a self-contained module
- **Isolated** — each task/file operates in isolated context
- **Small files** — no file >300 lines (target)
- **Composable prompt** — system prompt built from module blocks
- **No TUI** — minimal CLI + REPL with markdown formatting

---

## 2. High-Level Architecture

```mermaid
graph TB
    subgraph CLI["CLI Layer"]
        MAIN["main.ts<br/>entry point"]
        CMD["commands.ts<br/>subcommands"]
        REPL["repl.ts<br/>readline loop"]
    end

    subgraph CORE["Core"]
        AGENT["agent.ts<br/>state machine loop"]
        PB["prompt-builder.ts<br/>system prompt assembly"]
        CTX["context.ts<br/>agent context types"]
    end

    subgraph LLM["LLM Layer"]
        LPROV["provider.ts<br/>interface"]
        OAI["openai-compat.ts<br/>REST provider"]
        TC["token-counter.ts"]
        RESP["response.ts<br/>parse + validate"]
        ORCH["orchestrator.ts<br/>optional planner<br/>(локально или API)"]
    end

    subgraph TOOLS["Tools"]
        REG["registry.ts<br/>single source of truth"]
        EXEC["executor.ts<br/>dispatch pipeline"]
        TOOL_FILES["bash, read-file, write-file,<br/>edit-file, glob, grep, ..."]
    end

    subgraph MODULES["Modules"]
        SKILLS["skills/"]
        PLUGINS["plugins/"]
        MCP["mcp/"]
        PIPELINES["pipelines/"]
        INDEXER["indexer/"]
        MEMORY["memory/"]
        SESSION["session/"]
        PROFILE["user-profile/"]
        CTXMOD["context/"]
        HALLUC["hallucination/"]
        UPDATER["updater/"]
        EXEC["execution/"]
        BROWSER["browser/"]
    end

    subgraph SUPPORT["Support"]
        CONFIG["config/"]
        I18N["i18n/"]
        LOGGER["logger/"]
        UI["ui/"]
    end

    MAIN --> CMD
    MAIN --> REPL
    CMD --> AGENT
    REPL --> AGENT
    AGENT --> LPROV
    AGENT --> TOOLS
    AGENT --> MODULES
    AGENT --> PB
    PB --> MODULES
    AGENT --> CTXMOD
    AGENT --> HALLUC
    EXEC --> PLUGINS
    EXEC --> TOOL_FILES
    LPROV --> OAI
    OAI --> TC
    OAI --> RESP
```

---

## 3. Core Layer

### 3.1 Agent Loop (`core/agent.ts`)

Simple **state machine** with 6 states:

```mermaid
stateDiagram-v2
    [*] --> INIT
    INIT --> THINK: build context
    
    THINK --> ACT: tool_call response
    THINK --> OUTPUT: text response
    
    ACT --> OBSERVE: execute tool
    ACT --> ERROR: tool failed
    
    OBSERVE --> THINK: more steps needed
    OBSERVE --> [*]: done
    
    OUTPUT --> [*]: wait for user input
    
    ERROR --> THINK: retry
    ERROR --> [*]: max retries exceeded
    
    THINK --> THINK: hallucination detected (retry)
```

```
States:
  INIT    → collect system prompt blocks from all modules → build context
  THINK   → call LLM → validate response (hallucination check)
  ACT     → parse tool_call → execute via ToolExecutor
  OBSERVE → process results → check termination → loop or done
```

No if-else nesting. Each state is a separate function.
Plugins hook into state transitions via `onBeforeThink`, `onAfterThink`, etc.

### 3.2 Prompt Builder (`core/prompt-builder.ts`)

Collects `PromptBlock[]` from all modules, sorts by priority, fits into 8K token budget:

```ts
interface PromptBlock {
  content: string
  priority: 'critical' | 'high' | 'normal' | 'low'
  essential: boolean       // never trimmed
  estimatedTokens: number
}

// Builder algorithm:
// 1. Gather all blocks from modules
// 2. Place essential blocks first
// 3. Sort non-essential by priority
// 4. Greedy fill until budget (8K tokens)
// 5. Return { prompt, excluded[] }
```

---

## 4. LLM Layer

### 4.1 Provider Interface (`llm/provider.ts`)

```ts
interface LLMProvider {
  chat(messages: Message[]): AsyncIterable<Chunk>
  countTokens(text: string): number
  model: string
  contextWindow: number
}
```

### 4.2 OpenAI-Compatible Provider (`llm/openai-compat.ts`)

Single provider for all backends:
- LM Studio
- Ollama
- vLLM
- Together AI
- Any OpenAI-compatible endpoint

Supports:
- Streaming SSE
- Reasoning mode (Qwen3 thinking tokens)
- Tool call format conversion
- **Exponential backoff retry** (configurable)

**Retry mechanism:**

Provider automatically retries failed requests with exponential backoff:

```typescript
interface RetryConfig {
  maxRetries: number    // default: 3
  baseDelay: number     // default: 1000ms
  maxDelay: number      // default: 30000ms
}
```

**Retry conditions:**
- Network errors (connection refused, timeout, DNS failure)
- HTTP 429 (rate limit)
- HTTP 5xx (server errors: 500, 502, 503, 504)

**Backoff formula:**
```
delay = min(baseDelay * 2^attempt, maxDelay) + jitter
jitter = random(0, baseDelay * 0.1)
```

Example with defaults:
- Attempt 0: immediate
- Attempt 1: ~1000ms + jitter
- Attempt 2: ~2000ms + jitter
- Attempt 3: ~4000ms + jitter

Non-retryable errors (4xx except 429) fail immediately without retry.

### 4.3 Model Auto-Loader (`llm/model-loader.ts`)

Автоматическая загрузка модели при старте MMA через LM Studio REST API.

**API Endpoints:**
- `GET /api/v1/models` — проверка загруженных моделей
- `POST /api/v1/models/load` — загрузка модели с параметрами

**Параметры загрузки:**
```typescript
interface ModelLoadConfig {
  autoLoad: boolean           // включить автозагрузку (default: false)
  flashAttention?: boolean    // оптимизация attention (default: true)
  evalBatchSize?: number      // размер батча для evaluation
  offloadKvCacheToGpu?: boolean // KV cache на GPU (default: true)
}
```

**Логика работы:**
1. При старте bootstrap вызывает `ModelLoader.ensureModelLoaded()`
2. Проверяет через `/api/v1/models`, загружена ли нужная модель с правильным `context_length`
3. Если не загружена или context_length отличается — вызывает `/api/v1/models/load`
4. При ошибке загрузки — warning в лог, но агент продолжает работу (модель может быть загружена вручную)

**Пример запроса:**
```bash
POST /api/v1/models/load
{
  "model": "qwen3.5-9b",
  "context_length": 32768,
  "flash_attention": true,
  "offload_kv_cache_to_gpu": true
}
```

**Конфигурация:**
```json
{
  "modelLoad": {
    "autoLoad": false,
    "flashAttention": true,
    "offloadKvCacheToGpu": true
  }
}
```

Если `autoLoad: false` — модель не загружается автоматически (полезно для удалённых провайдеров).

### 4.3 Response Parsing (`llm/response.ts`)

Parse LLM response into typed result:
```ts
type LLMResponse =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; calls: ToolCall[] }
  | { type: 'reasoning'; content: string }
```

### 4.4 Orchestrator Model (`llm/orchestrator.ts`)

Опциональная модель-оркестратор для планирования и сложных решений.
Orchestrator использует **тот же `LLMProvider` интерфейс** — может быть как через API, так и локально. 
Это просто другой экземпляр провайдера с другой моделью.

```ts
// config
orchestrator: {
  model: 'qwen3-70b-414k',    // может быть локальным
  provider: {
    baseUrl: 'http://localhost:1234/v1'  // или API эндпоинт
  }
}
// или через API:
orchestrator: {
  model: 'gpt-4o',
  provider: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-...'
  }
}
```

Если настроен — agent loop делегирует часть задач на orchestrator:

```mermaid
flowchart LR
    subgraph ORCH["Orchestrator"]
        ORCHPROV["provider.ts<br/>любой OpenAI-compat"]
        ORCHCTX["контекст: до 414K<br/>полный проект"]
    end
    subgraph WORK["Worker"]
        WORKPROV["provider.ts<br/>любой OpenAI-compat"]
        WORKCTX["контекст: 32K<br/>только шаг"]
    end
    
    AGENT["agent.ts"] -->|plan create| ORCH
    AGENT -->|stuck / conflict| ORCH
    AGENT -->|final audit| ORCH
    AGENT -->|сложный вопрос| ORCH
    ORCH -->|план / решение| AGENT
    
    AGENT -->|execute step| WORK
    WORK -->|result| AGENT
    WORK -->|plan update done| AGENT
```

**Что делает orchestrator:**
- Создание плана (разбивка на шаги)
- Решение конфликтов (off-track, stuck)
- Ответы на сложные вопросы
- Audit завершённой задачи

**Что делает worker:**
- Выполнение каждого шага плана
- Чтение/запись файлов, запуск команд
- Обычная agent loop

Если `orchestrator.model` не указан — все операции делает основная модель.

---

## 5. Tools System

### 5.1 Registry (`tools/registry.ts`)

Single source of truth — no duplicate definitions:

```ts
interface ToolDefinition {
  name: string
  description: string
  parameters: JSONSchema  // for LLM function calling
  handler: (ctx: ToolContext, args: unknown) => Promise<ToolResult>
}
```

### 5.2 Executor (`tools/executor.ts`)

Dispatch pipeline:

```
Plugins:onBeforeTool → validate args → handler() → Plugins:onAfterTool
                                                      ↓
                                           builtin plugins (lint-on-write)
                                                      ↓
                                           log to session history
```

**Builtin plugins:**
- `lint-on-write` — после `write_file` / `edit_file` проверяет синтаксис TS/JS и запускает `npm run lint` если есть
- `notify` — базовые lifecycle уведомления

### 5.3 Tool Descriptions

Каждый инструмент — отдельный файл `tools/<name>.ts`. Интерфейс:

```ts
interface ToolDefinition {
  name: string                    // snake_case, уникальное
  description: string             // для LLM (что делает, когда использовать)
  parameters: JSONSchema          // OpenAI function calling schema
  tags?: string[]                 // для MoE фильтрации
  interactive?: boolean           // true = обход 60s таймаута (question, approve)
  handler: (ctx: ToolContext, args: unknown) => Promise<ToolResult>
}
```

**Инструменты файловой системы:**

| Tool | Parameters | Что делает | Когда использовать |
|------|-----------|------------|-------------------|
| `read_file` | `{ path: string, offset?: number, limit?: number }` | Читает файл, опционально с offset/limit | Для чтения исходников, конфигов |
| `write_file` | `{ path: string, content: string }` | Создаёт/перезаписывает файл | Для создания новых файлов |
| `edit_file` | `{ path: string, old: string, new: string }` | Find-replace в существующем файле | Для целенаправленных правок |
| `glob` | `{ pattern: string }` | Поиск файлов по glob-паттерну | Для поиска файлов по имени/расширению |
| `grep` | `{ pattern: string, include?: string }` | Поиск содержимого regex | Для поиска вхождения, импортов |
| `list_dir` | `{ path: string }` | Список содержимого директории | Для навигации по проекту |
| `create_dir` | `{ path: string }` | Создаёт директорию | Перед созданием файла в новой папке |
| `delete_file` | `{ path: string }` | Удаляет файл | Для очистки |
| `move_file` | `{ from: string, to: string }` | Перемещает/переименовывает | Для рефакторинга |
| `file_info` | `{ path: string }` | Метаданные файла (размер, дата) | Для проверки существования |

**Инструменты выполнения:**

| Tool | Parameters | Что делает | Когда использовать |
|------|-----------|------------|-------------------|
| `bash` | `{ command: string, workdir?: string }` | Выполняет shell команду | Для запуска тестов, билда, git |
| `subagent` | `{ task: string, tools?: string[] }` | Запускает изолированного субагента с ограниченным набором инструментов | Для parallel задач, исследования без изменения контекста |
| `web_search` | `{ query: string }` | Поиск в интернете | Для поиска документации |
| `web_fetch` | `{ url: string }` | HTTP GET с HTML-очисткой и лимитом 15K символов, timeout 15s | Для чтения документации, API |
| `web_browse` | `{ action: string, ... }` | Headless browser (навигация, клики, скриншоты) | Для E2E тестов, отладки UI |

**Инструменты планирования:**

| Tool | Parameters | Что делает | Когда использовать |
|------|-----------|------------|-------------------|
| `plan` | `{ action: 'create', title: string, steps: string[] }` | Создаёт многошаговый план. Показывает пользователю checklist `[x]` / `[ ]`. | На старте комплексной задачи |
| `plan` | `{ action: 'update', step: number, status: 'done' | 'failed' | 'skipped', note?: string }` | Обновляет статус шага. Показывает обновлённый checklist. | После выполнения шага |
| `plan` | `{ action: 'abort' }` | Отменяет текущий план | Если задача больше не актуальна |
| `todo` | `{ action: 'add', step?: number, items: string[] }` | Добавляет подзадачи к шагу | Для детализации шага |
| `todo` | `{ action: 'done', id: string }` | Отмечает подзадачу выполненной | Для трекинга прогресса внутри шага |
| `verify` | `{ step?: number }` | Запускает верификацию шага: проверка файлов, синтаксис, тесты. | Для явной проверки шага |

**Инструменты взаимодействия:**

| Tool | Parameters | Что делает | Когда использовать |
|------|-----------|------------|-------------------|
| `question` | `{ questions: Array<{question, header?, options?, multiple?, custom?}> }` | Интерактивный опрос: вопросы с вариантами ответов или свободный текст. Поддержка множественных вопросов в одном вызове. Блокирует выполнение до ответа. | Для уточнений, выбора опций, сбора предпочтений |
| `approve` | `{ action: string }` | Интерактивное подтверждение (Да/Нет). Возвращает success:false при отказе. | Для rm -rf, массовых удалений |

**Инструменты расширения:**

| Tool | Parameters | Что делает | Когда использовать |
|------|-----------|------------|-------------------|
| `load_skill` | `{ task: string }` | Загружает SKILL.md по описанию задачи | Когда агенту нужны специфические знания |
| `pipeline_run` | `{ name: string, params: Record<string, string> }` | Запускает task workflow пайплайн | Для повторяющихся процессов |
| `mcp_call` | `{ server: string, tool: string, args: unknown }` | Вызывает инструмент внешнего MCP сервера | Для доступа к внешним API, БД |
| `search_history` | `{ query: string, max_results?: number }` | Поиск в истории прошлых сессий | Для вспоминания деталей |

---

## 6. Modules

Every module follows a standard interface:

```ts
interface AgentModule {
  name: string
  getSystemPromptBlock?(): PromptBlock | null
  getToolDefinitions?(): ToolDefinition[]
  getPlugin?(): AgentPlugin
}
```

### 6.1 Skills (`modules/skills/`)

**Loading:** 3 sources — builtin `modules/skills/builtin/`, global `~/.mma/skills/`, project `.mma/skills/`

**Matching by description (not name):**
- Each skill has `name`, `description`, `keywords[]` in YAML frontmatter
- On startup: keyword overlap between task prompt and skill keywords
- At runtime: LLM calls `load_skill`, system matches description overlap

**Auto-loading:**
- Plugin `onBeforeThink` analyzes user message and auto-loads best matching skill
- Loaded skill content injected into context as system message: `[Auto-loaded Skill: name]\n<content>`
- Respects budget limit — skips if skill would exceed remaining budget
- Same skill not loaded twice
- Agent can also call `load_skill(task="...")` manually if needed

**Prompt integration:**
- `[Available Skills]` — list of all available skills with short descriptions, so agent knows what can be loaded
- `[Loaded Skills]` — list of currently loaded skills (auto-loaded or manually)
- Agent can also call `load_skill(task="...")` manually if needed

**Format in prompt:**
```
[Available Skills]
Use load_skill tool with task parameter to load relevant skill before answering domain-specific questions.
- git-expert: Git branching, merge conflict resolution, workflow strategies
- typescript-expert: TypeScript type system, generics, advanced patterns

[Loaded Skills]
- git-expert: Git branching, merge conflict resolution
```

### 6.2 Plugins (`modules/plugins/`)

**Interface:**
```ts
interface AgentPlugin {
  name: string
  priority?: number          // higher = runs first
  onBuildPrompt?(): string | null
  onBeforeThink?(ctx: AgentContext): void
  onAfterThink?(ctx: AgentContext, response: LLMResponse): void
  onBeforeTool?(ctx: AgentContext, call: ToolCall): boolean  // false = block
  onAfterTool?(ctx: AgentContext, result: ToolResult): void
  onError?(ctx: AgentContext, error: Error): void
  onSessionStart?(ctx: AgentContext): void
  onSessionEnd?(ctx: AgentContext): void
}
```

**Loading:** Builtin → global `~/.mma/plugins/` → project `.mma/plugins/`
**Execution:** All plugins run for each hook. `onBeforeTool` short-circuits if any returns `false`.
**Error isolation:** Plugin error → logged, other plugins continue.

### 6.3 MCP Client (`modules/mcp/`)

- Connects to MCP servers via stdio or SSE (remote)
- Configurable via `config.mcpServers` in global (`~/.mma/config.json`) or project (`.mma/config.json`) config
- `MCPServerConfig`: `name`, `command`/`args` (stdio), `url`/`headers` (SSE), `enabled`, `timeout`
- MCPRegistry populated at runtime from config on first `mcp_call` invocation
- SSE transport uses `fetch` for POST requests + ReadableStream for event parsing
- Tool calls proxied: `mcp_call { server, tool, args }`

```
LLM → mcp_call("server-a", "read-file", {path: "/x"}) 
     → MCP client → server-a process → result → LLM
```

### 6.4 Pipelines (`modules/pipelines/`)

**Definition (YAML):**
```yaml
name: implement-feature
steps:
  - id: research
    agent: explore
    prompt: "Изучи код для {feature}"
  - id: plan
    agent: plan
    depends_on: [research]
    prompt: "Составь план на основе {{steps.research.output}}"
  - id: implement-web
    agent: code
    parallel: true
    depends_on: [plan]
    prompt: "Реализуй веб часть"
  - id: implement-api
    agent: code
    parallel: true
    depends_on: [plan]
    prompt: "Реализуй API часть"
  - id: verify
    agent: verify
    depends_on: [implement-web, implement-api]
    prompt: "Проверь всё"
```

**Engine:**
1. Parse YAML → internal DAG
2. Resolve `depends_on` — step ready when all predecessors complete
3. Run ready steps in parallel (`Promise.all`, max 3 concurrent)
4. Template engine resolves `{{steps.<id>.output}}`
5. Error: fail-fast. Retry: up to 3 attempts with exponential backoff.

### 6.5 Indexer (`modules/indexer/`)

- **Walker:** Walk project files, detect language, extract exports/symbols
- **Cache:** Disk (JSON) + memory. Realtime: `fs.watch` for changes
- **Output:** Structured project map for system prompt (~2K tokens)
- **On change:** Only re-index changed files

### 6.6 Memory (`modules/memory/`)

Persistent markdown files in `.mma/memory/`:
- `conventions.md` — project conventions learned over time
- `decisions.md` — architectural decisions
- `errors.md` — recurring errors and solutions

Each entry: timestamp + description. Auto-learn from tool results.

### 6.7 User Profile (`modules/user-profile/`)

Collects:
- OS, shell, platform info
- Preferred tools, tech stack
- Coding style preferences
- Notes from user interactions

Persisted to `~/.mma/profile.json` (auto-collected and saved on every bootstrap).
Compressed to ~500 tokens for system prompt.

### 6.8 Context Manager (`modules/context/`)

**Бюджет вычисляется динамически** от `model.contextWindow` (32K / 64K / 128K и т.д.):

```
System prompt:    25%  от contextWindow (фикс, не сжимается)
Response reserve: 12%  зарезервировано под ответ модели
History:          63%  динамическая часть (сжимается)
```

Примеры:

| contextWindow | System prompt | Reserve | History |
|---------------|--------------|---------|---------|
| 32K | 8K | 3.9K | 20.6K |
| 64K | 16K | 7.7K | 40.3K |
| 128K | 32K | 15.4K | 80.6K |

**Compaction (sliding window + structured extraction):**
- Срабатывает когда **history** превышает **75% своего бюджета** (не хардкод)
- Или каждые **15 итераций** (эвристика, настраивается)
- Keep last 6 turns **in full**
- Older turns → extract: facts, decisions, tool results, errors → compressed block
- Preserve causality chains (read X → decided Y → wrote Z)
- No second LLM call — pattern extraction only

**Защита контекста от переполнения (multi-layer defense):**

1. **Ограничение размера tool results** (`agent.ts:truncateToolOutput`):
   - Максимум 30% от history budget на один tool result
   - Максимум 50% от оставшегося контекста
   - Абсолютный лимит: 15,000 символов (~3,750 токенов)
   - Формула: `min(budget.history * 0.3 * 2, remainingBudget * 0.5 * 2, 15000)` символов
   - При превышении: обрезка + маркер `[Truncated: N tokens removed]`

2. **Pre-flight check перед LLM-вызовом** (`agent.ts:83-87`):
   - Проверка `currentTokens > budget.history` перед каждым LLM-вызовом
   - При превышении: принудительная компакция + warning в лог
   - Гарантирует, что в LLM никогда не отправляется контекст больше бюджета

3. **Post-tool compaction** (`agent.ts:157-160`):
   - Проверка `needsCompaction()` после добавления каждого tool result
   - Мгновенная компакция, если tool result превысил порог
   - Предотвращает накопление больших результатов между итерациями

4. **Улучшенный web_fetch** (`tools/web-fetch.ts`):
   - Лимит: 15,000 символов (вместо 50,000)
   - HTML-очистка: удаление `<script>`, `<style>`, тегов, HTML-entities
   - Timeout: 15 секунд (AbortSignal.timeout)
   - Проверка content-type для определения необходимости HTML-очистки

**History recording (no duplication):**
- Every message appended once to `~/.mma/sessions/<id>/history.jsonl`
- Full detailed log appended to `~/.mma/sessions/<id>/session.jsonl` (tool calls, args, results, duration, errors)
- Context compaction writes only the compacted summary message; old messages are not re-appended
- Tool `search_history` searches across `history.jsonl` files

### 6.9 Hallucination Detection (`modules/hallucination/`)

Две точки проверки:

1. **Response validation** — в agent loop после `THINK`, перед показом ответа пользователю
2. **Result validation** — в tool executor после `Plugins:onAfterTool`, проверка фактов

**Response validation pipeline:**
```
LLM response → confidence check → consistency check → pass/fail
```

**1. Factual (`factual.ts`):**
- Track known paths from `read_file`, `glob`, `grep`, `write_file` results
- Cross-check paths mentioned in response against known set
- Flag paths that don't exist and weren't read

**2. Consistency (`consistency.ts`):**
- Track sets: `created_files`, `deleted_files`, `decisions`
- Flag contradictions (file said created but no tool call, decision reversal)

**3. Confidence (`confidence.ts`):**
- Empty/short responses (<10 tokens) → fail
- Repetitive responses (>50% overlap with previous) → fail
- Uncertainty markers ("I think", "maybe", "probably") → warn

**Reactions:**
- `pass` → show to user
- `warn` → show with `[⚠️ Uncertainty]` prefix
- `retry` → DON'T show, re-call LLM with context of problem
- `block` (3+ retries exhausted) → interrupt, ask user

### 6.10 Updater (`modules/updater/`)

- Async check npm registry for newer version
- Runs in background (non-blocking)
- On next session start: suggest update if available

### 6.11 Task Execution Guarantees (`modules/execution/`)

Модуль, отвечающий за гарантию выполнения задачи агентом.
Без этого модуля агент с 9B моделью легко теряет цель, забывает шаги, уходит в сторону.

**Основные механизмы:**

#### 6.11.1 План в system prompt

План создаётся инструментом `plan` и **всегда** отображается в system prompt как отдельный блок:

```
[Plan: implement-oauth]  (steps: 1/5 done, current: step 2)
[x] 1. Изучить текущую структуру auth
[ ] 2. Создать OAuth роуты (src/routes/oauth.ts)
[ ] 3. Создать OAuth сервис (src/services/oauth.ts)
[ ] 4. Написать тесты
[ ] 5. Проверить что тесты проходят
```

- Шаги автоматически загружаются в блок `getSystemPromptBlock()` модуля execution
- Модель видит план в каждом THINK — не может «забыть»
- `[x] status` обновляется после каждого шага
- Если модель делает что-то вне плана — следует `[Outside plan: explain or return to plan]`

#### 6.11.2 Создание плана

План создаётся по решению модели, подкреплённому сильной директивой в system prompt (когда `autoPlan: true`).
Система **не использует keyword matching** для определения multi-step задач — это антипаттерн (design rule #10).

```mermaid
flowchart LR
    TASK["Пользователь:<br/>\"реализуй OAuth\""] 
    TASK --> PROMPT["system prompt:<br/>создай план для multi-step"]
    PROMPT --> MODEL_CREATE["модель вызывает<br/>plan action=create"]
    
    MODEL_CREATE --> ORCH_OR_DIRECT{"есть orchestrator.model?"}
    ORCH_OR_DIRECT -->|да| ORCH["orchestrator создаёт план<br/>worker только исполняет"]
    ORCH_OR_DIRECT -->|нет| WORKER["основная модель<br/>создаёт и исполняет"]
    
    ORCH --> SAVE["план сохранён<br/>в system prompt"]
    WORKER --> SAVE
    
    SAVE --> SHOW_USER["показать план<br/>пользователю [x]/[ ]"]
    SHOW_USER --> EXEC["выполнять"]
```

- План виден модели в system prompt на каждой итерации
- При создании и обновлении плана пользователю показывается checklist `[x]` / `[ ]`
- Модель должна вызывать `plan update <step> done` после каждого шага
- Execution module автоматически продвигает план, если все файлы из описания шага созданы
- Если настроен `orchestrator.model` — планирование и сложные решения уходят на orchestrator, а основная модель только исполняет шаги

#### 6.11.3 Инструменты

| Tool | Description |
|------|-------------|
| `plan` | `create` / `show` / `update <step> done` / `abort` |
| `todo` | `add` / `list` / `done` (подзадачи внутри шага) |
| `verify` | Запустить проверку (test/lint) для текущего шага |

#### 6.11.4 Execution loop с проверками

```mermaid
stateDiagram-v2
    direction TB
    
    [*] --> START_STEP: перейти к следующему шагу
    
    START_STEP --> EXECUTE: выполнить шаг
    EXECUTE --> VERIFY: проверить результат
    VERIFY --> SUCCESS: проверка пройдена
    VERIFY --> FAIL: проверка не пройдена
    
    SUCCESS --> MARK_DONE: отметить шаг [x]
    MARK_DONE --> HAS_NEXT: есть ещё шаги?
    HAS_NEXT --> START_STEP: да → следующий
    HAS_NEXT --> AUDIT: все шаги готовы → финальная проверка
    AUDIT --> AUDIT_PASS: проверка пройдена
    AUDIT --> AUDIT_FAIL: тесты не прошли / файлов нет
    AUDIT_PASS --> DONE: задача выполнена ✓
    AUDIT_FAIL --> FIX_STEP: добавить шаг «починить» / «создать файлы»
    FIX_STEP --> START_STEP: повторный цикл
    
    FAIL --> RETRY: повторить шаг
    RETRY --> RETRY_CHECK: попыток < 3?
    RETRY_CHECK --> EXECUTE: да, с контекстом ошибки
    RETRY_CHECK --> SKIP: нет → спросить пользователя
    SKIP --> MARK_DONE: пропустить шаг
    SKIP --> ABORT: отменить задачу
```

#### 6.11.5 Верификация шагов

После каждого `write_file` / `edit_file` автоматически запускается builtin plugin `lint-on-write`:

1. **Проверка синтаксиса** изменённых файлов:
   - `.ts/.tsx`: `npx tsc --noEmit --skipLibCheck <file>`
   - `.js/.jsx`: `node --check <file>`
2. **Project lint:** если в `package.json` есть скрипт `lint`, он тоже запускается
3. **Результат:** ошибки синтаксиса/линта добавляются к результату tool call, чтобы модель сразу исправила
4. **По команде `verify`:** проверка файлов, упомянутых в описании шага

#### 6.11.6 Stuck detection

- **N итераций без прогресса:** если модель не завершила текущий шаг за X вызовов LLM (по умолчанию `stuckThreshold: 8`, настраивается в конфиге) → `execution` модуль вставляет в system prompt recovery message
- **Повторяющиеся tool calls:** 3 одинаковых вызова подряд с теми же аргументами → recovery message
- **Повторяющиеся ошибки:** один и тот же инструмент падает > 2 раз → recovery message
- **Off-track:** модель вызывает write/edit/bash для файлов, не упомянутых в текущем шаге → warning в system prompt

#### 6.11.7 Финальный аудит

Когда все шаги `[x]`:

1. Проверить что каждый файл, упомянутый в шагах, существует
2. Запустить `npm test` или `bun test` (если есть тесты)
3. Показать пользователю: `[✓] Task complete: создано 3 файла, изменено 2 файла, тесты проходят`
4. Если тесты не проходят → новая итерация: «починить тесты»

#### 6.11.8 Error recovery protocol

```mermaid
flowchart LR
    FAIL["Инструмент упал"] -->{"ошибка<br/>повторяется?"}
    -->|1-2 раза| RETRY["retry с контекстом ошибки"]
    -->|3+ раза| ESCALATE["escalate: показать пользователю"]
    ESCALATE --> CHOICE{"пользователь решил"}
    CHOICE -->|"пропустить шаг"| SKIP["[x] step skipped"]
    CHOICE -->|"решить вручную"| MANUAL["ждать ручного исправления"]
    CHOICE -->|"продолжить"| RETRY
```

Механизмы:
- На каждый `plan` шаг создаётся подзадача с лимитом попыток
- После 3 неудач — `question` пользователю
- Пользователь может: пропустить, исправить вручную, отменить задачу
- Все ошибки пишутся в `memory/errors.md` для будущих сессий

#### 6.11.9 Интеграция с hallucination модулем

- Если hallucination детектор выдал `block` на шаге N → execution модуль помечает шаг как требующий повторения
- Если выдал `warn` → записывает в лог шага, но продолжает выполнение

### 6.12 Session Management (`modules/session/`)

Модуль для multi-session поддержки:

**Файлы:**
- `types.ts` — `SessionMeta` (id, name, timestamps, counts, model, contextWindow, projectDir), `SessionMessage` (role, content, timestamp)
- `store.ts` — `SessionStore`: JSONL-персистентность на диск (`~/.mma/sessions/<id>/meta.json` + `history.jsonl`)
- `manager.ts` — `SessionManager`: lifecycle (create, list, switch, delete, rename, autoName, maxSessions enforcement)
- `module.ts` — `AgentModule`: `PromptBlock` с инфо о сессии + `AgentPlugin` с `onSessionStart/onSessionEnd`

**CLI (`commands.ts`):**
```bash
mma session list              # список сессий
mma session show <id>         # детали сессии
mma session delete <id>       # удалить
```

**REPL (`repl.ts`):**
```
/sessions    /ls       — список (* active)
/new <name>  /create   — создать
/resume <id> /switch   — переключиться
/rename <name>         — переименовать
/delete <id> /rm       — удалить
```

**Интеграция:**
- `PluginManager.onSessionStart` / `onSessionEnd` дёргаются при старте/завершении
- `ContextManager.onCompact` сохраняет compaction в сессию
- `search_history` ищет по всем `history.jsonl` в sessions/
- ToolContext.sessionHistory пишет результаты tool в active сессию

## 7. CLI + REPL

### 7.1 CLI (`cli/main.ts`)

```bash
mma <prompt>                          # single run
mma init                              # interactive setup wizard
mma config set <key> <value>
mma config show
mma model list | use
mma provider list | use
mma session list | show <id> | delete <id>   # session management
```

### 7.2 REPL (`cli/repl.ts`)

Readline loop with:
- **Colored output:** `You:` (cyan) for user messages, `Agent:` (green) for model responses
- **Context bar:** After each response, shows `████░░░░░  40%  (8192 / 20480 tokens)` — remaining history budget
- **REPL banner:** On startup shows model, provider, context budget breakdown, skills, plugins, MCP servers, active session
- **Slash commands:** `/help`, `/sessions`, `/new`, `/resume`, `/rename`, `/delete`, `/run`, `/config`, `/status`, `/exit`
- **Deep tab completion** (see 7.4)
- **Fast navigation** (see 7.5)
- **Persistent history** across sessions (`~/.mma/repl-history`)
- **Markdown output** with ANSI syntax highlighting via `ui/md-formatter.ts`

### Session Management

Sessions persist conversation history to `~/.mma/sessions/<id>/` as `meta.json` + `history.jsonl`.

| Command | Aliases | Description |
|---------|---------|-------------|
| `/sessions` | `/ls` | List all sessions (* active) |
| `/new <name>` | `/create` | Create a new session |
| `/resume <id\|name>` | `/switch`, `/use` | Switch to a session |
| `/rename <name>` | | Rename current session |
| `/delete <id>` | `/rm` | Delete a session |

**Data layout:**
```
~/.mma/sessions/
├── ses_abc123/
│   ├── meta.json        # SessionMeta (name, model, counts, timestamps)
│   └── history.jsonl    # JSONL of SessionMessage[]
└── ses_def456/
    ├── meta.json
    └── history.jsonl
```

Messages persisted to history.jsonl on each iteration (tool calls, assistant responses). `search_history` tool searches across all sessions.

No TUI — no status bars, no themes, no spinners.

### 7.3 Interactive Setup Wizard (`cli/setup.ts`)

Запускается через `mma init` или при первом запуске (если нет конфига — создаётся автоматически с defaults).

**Discovery flow:**
1. Scan localhost for LLM servers (ports 1234, 11434, 8080, 4891)
2. Show detected servers → user picks one
3. Fetch model list from `/v1/models` → user picks model
4. Test chat with selected model
5. Configure context window (default 32768)
6. Configure max tool iterations (default 25)
7. Select locale (en/ru)

```mermaid
flowchart TD
    START["mma init"] --> SCAN["Scan localhost ports"]
    SCAN --> FOUND{"Servers found?"}
    FOUND -->|Yes| LIST["Show detected:\n• LM Studio :1234\n• Ollama :11434\n• vLLM :8000"]
    FOUND -->|No| MANUAL["Enter custom URL"]
    LIST --> PICK["User picks server"]
    MANUAL --> PICK
    PICK --> TEST["Test /v1/models endpoint"]
    TEST --> MODELS["Fetch model list"]
    MODELS --> SEL["User picks default model"]
    SEL --> TESTCHAT["Quick test: chat('hello')"]
    TESTCHAT -->|Success| CONFIG["Save to ~/.mma/config.json"]
    TESTCHAT -->|Fail| RETRY["Show error → retry or change"]
    CONFIG --> ORCH{"Orchestrator model?"}
    ORCH -->|Yes, add| ORCH_INPUT["Enter model + provider<br/>(локально или API)"]
    ORCH -->|No| NEXT["Continue"]
    ORCH_INPUT --> NEXT
    NEXT --> MORE{"Configure more?"}
    MORE -->|Yes| MCP["MCP servers?"]
    MORE -->|Yes| SKILLS["Skill dirs?"]
    MORE -->|No| DONE["Done ✓"]
```

**Implementation notes:**
- Port scanning: simple `fetch` to common ports (no nmap, no external deps)
- Timeout per port: 2 seconds
- Each step is a separate question via readline prompt
- Config saved atomically (write to temp → rename)
- Orchestrator model optional — если не указана, всё работает на одной модели

### 7.4 Deep Tab Completion (`cli/completer.ts`)

**Multi-level completion:**

```
/                          → /help, /model, /config, /plan, /todo, /session, /exit
/model <TAB>               → list, use, info, add, remove
/model use <TAB>           → qwen3.5-9b, llama-3.2-3b, ... (from config)
/config set <TAB>          → model, provider.baseUrl, provider.apiKey, locale, logLevel
/config set model <TAB>    → qwen3.5-9b, llama-3.2-3b, ... (from config)
/plan create <TAB>         → (no completion, expects free text)
```

**Architecture:**

```ts
// cli/completer.ts

interface CompletionContext {
  line: string           // full input line
  cursor: number         // cursor position
  tokens: string[]       // whitespace-split tokens
  partial: string        // current word being typed (token at cursor)
  tokenIndex: number     // which token the cursor is on
}

interface CompletionProvider {
  name: string
  match(ctx: CompletionContext): boolean
  complete(ctx: CompletionContext): string[]
}

class Completer {
  private providers: CompletionProvider[] = []

  registerProvider(provider: CompletionProvider): void
  async complete(line: string): Promise<[string[], string]>
}
```

**Built-in providers:**

| Provider | When | Completes |
|----------|------|-----------|
| `SlashCommandProvider` | `line.startsWith('/')` and `tokenIndex === 0` | Command names: `help`, `model`, `config`, ... |
| `SubcommandProvider` | After a command match | Subcommands from command tree |
| `ModelArgProvider` | After `/model use`, `/model info` | Model names from config |
| `ConfigKeyProvider` | After `/config set` | Config key paths (`model`, `provider.baseUrl`, ...) |
| `FilePathProvider` | Any token with `/` or `\` | File system paths from CWD |
| `ProviderArgProvider` | After `/provider use` | Provider names from config |

**Integration with REPL:**
```ts
// cli/repl.ts
import { Completer } from './completer'

const completer = new Completer()
completer.registerProvider(new SlashCommandProvider())
completer.registerProvider(new SubcommandProvider())
completer.registerProvider(new ModelArgProvider(config))
// ...

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  completer: (line) => completer.complete(line)
})
```

### 7.5 Fast Navigation

Standard readline keybindings — встроены в Node/Bun readline:

| Binding | Action |
|---------|--------|
| `Ctrl+A` / `Home` | Начало строки |
| `Ctrl+E` / `End` | Конец строки |
| `Ctrl+←` / `Alt+B` | Слово назад |
| `Ctrl+→` / `Alt+F` | Слово вперёд |
| `Ctrl+U` | Вырезать до начала |
| `Ctrl+K` | Вырезать до конца |
| `Ctrl+W` | Вырезать слово назад |
| `Ctrl+Y` | Вставить из буфера |
| `↑` / `↓` | История команд |
| `Ctrl+R` | Reverse history search |
| `Ctrl+L` | Очистить экран |
| `Ctrl+C` | Прервать (cancel current) |
| `Ctrl+D` | Выход (если строка пуста) |
| `Ctrl+Z` | Suspend (Unix) |

**Persistent history:**
- История сохраняется в `~/.mma/repl-history` (постоянная между сессиями)
- `Ctrl+R` — fuzzy search по всей истории
- Максимум 1000 записей, ротация (tail)

**Multi-line input:**
- Если строка заканчивается на `\` → продолжение на следующей строке
- Если вставлен код с `{ }` → auto-detect multi-line режим
- Enter на пустой строке → завершить ввод, выполнить

---

## 8. Configuration (`config/`)

**3-layer merge:**
```
defaults.ts → ~/.mma/config.json (global) → .mmrc (project)
```

**Single defaults source** (`config/defaults.ts`):
```ts
export const DEFAULTS = {
  model: 'qwen3.5-9b',
  provider: {
    type: 'openai-compat',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'not-needed'
  },
  // Опциональная модель-оркестратор для планирования и сложных решений.
  // Может быть как локальной (qwen3-70b на том же сервере), так и API (gpt-4o).
  // orchestrator использует свой provider (может отличаться от основного).
  // Если не указана — все операции выполняет основная модель.
  orchestrator: {
    model: undefined,      // например: 'gpt-4o' или 'qwen3-70b-414k'
    provider: undefined    // если отличается от основного
    // provider не указан → используется основной provider
    // model не указана → orchestrator отключён
  },
  contextWindow: 32768,
  contextBudget: {
    systemPrompt: 0.25,   // 25% от contextWindow
    responseReserve: 0.12, // 12% под ответ
    compactionThreshold: 0.75 // 75% от history budget
  },
  modelLoad: {
    autoLoad: false,          // автозагрузка модели через LM Studio API
    flashAttention: true,     // оптимизация attention computation
    offloadKvCacheToGpu: true // KV cache на GPU
  },
  retry: {
    maxRetries: 3,            // максимум повторных попыток при ошибке
    baseDelay: 1000,          // базовая задержка в мс (экспоненциальный backoff)
    maxDelay: 30000           // максимальная задержка в мс
  },
  maxToolIterations: 25,
  stuckThreshold: 8,        // итераций без прогресса до stuck-detector
  autoPlan: true,           // авто-создание плана для multi-step
  logLevel: 'info',
  locale: 'en',
  session: {
    autoSave: true,          // сохранять сообщения в history.jsonl
    maxSessions: 50,         // максимум сессий (старые удаляются)
    isolateMemory: false     // изолировать memory/ внутри сессии
  }
}
```

No duplication — `defaults.ts` is the one source imported everywhere.

---

## 9. i18n (`i18n/`)

Only for **user-facing messages** from the agent.
CLI, logs, internal messages — always English.

```ts
t('file.created', { path: 'src/index.ts' }) // → "Created src/index.ts"
t('error.timeout')                           // → "Request timed out"
```

Default locale: `en`. Switch via `config.set('locale', 'ru')`.

---

## 10. Logging

### App Logger (`logger/app-logger.ts`)
- Debug/info/warn/error to console + file (`~/.mma/logs/app.jsonl`)
- Log rotation: appends, no truncation
- Filters: `MMA_LOG_LEVEL` env var
- Used for development and debugging of the agent itself

### Session History (`modules/context/history.ts`)
- Per-project: `~/.mma/sessions/<project>/<session-id>.jsonl`
- Every message dumped raw (user, assistant, tool_call, tool_result)
- **Rotation:** sessions >30 days → `.gz` archive
- **Searchable:** via `search_history` tool

---

## 11. Data Flow

```mermaid
sequenceDiagram
    participant U as User
    participant C as CLI/REPL
    participant A as Agent Loop
    participant PB as Prompt Builder
    participant LLM as LLM Provider
    participant H as Hallucination Detector
    participant TE as Tool Executor
    participant P as Plugins
    participant M as Modules
    participant SH as Session History

    U->>C: prompt
    C->>A: run(prompt)
    A->>PB: build system prompt
    PB->>M: getPromptBlocks()
    M-->>PB: blocks[]
    PB-->>A: assembled prompt
    
    A->>SH: append(user_message)
    A->>A: state = THINK
    
    loop Agent Loop
        A->>LLM: chat(messages)
        LLM-->>A: response
        
        A->>H: validate(response)
        H-->>A: pass | warn | retry | block
        
        alt retry
            A->>LLM: chat with retry context
        else block
            A->>U: intervention required
        else pass or warn
            A->>SH: append(assistant_response)
            
            alt tool_call
                A->>TE: execute(tool_call)
                TE->>P: onBeforeTool
                P-->>TE: proceed/block
                TE->>TE: handler()
                TE->>P: onAfterTool
                TE->>SH: append(tool_result)
                TE-->>A: result
                A->>A: state = OBSERVE
            else text
                A->>U: output
                U->>A: next prompt
                A->>SH: append(user_message)
            end
        end
    end
```

---

## 12. Directory Structure

```
E:\projects\micro-models-agent\
├── src/
│   ├── core/
│   │   ├── agent.ts
│   │   ├── prompt-builder.ts
│   │   ├── types.ts
│   │   └── index.ts
│   ├── llm/
│   │   ├── provider.ts
│   │   ├── openai-compat.ts
│   │   ├── token-counter.ts
│   │   ├── response.ts
│   │   ├── orchestrator.ts          # Optional orchestrator model
│   │   └── index.ts
│   ├── tools/
│   │   ├── registry.ts
│   │   ├── executor.ts
│   │   ├── bash.ts
│   │   ├── read-file.ts
│   │   ├── write-file.ts
│   │   ├── edit-file.ts
│   │   ├── glob.ts
│   │   ├── grep.ts
│   │   ├── list-dir.ts
│   │   ├── create-dir.ts
│   │   ├── delete-file.ts
│   │   ├── move-file.ts
│   │   ├── file-info.ts
│   │   ├── subagent.ts
│   │   ├── search-history.ts
│   │   ├── web-search.ts
│   │   ├── web-fetch.ts
│   │   ├── web-browse.ts
│   │   ├── plan.ts
│   │   ├── todo.ts
│   │   ├── question.ts
│   │   ├── approve.ts
│   │   ├── user-input.ts
│   │   └── index.ts
│   ├── modules/
│   │   ├── skills/
│   │   │   ├── loader.ts
│   │   │   ├── matcher.ts
│   │   │   ├── index.ts
│   │   │   └── builtin/
│   │   ├── plugins/
│   │   │   ├── manager.ts
│   │   │   ├── loader.ts
│   │   │   ├── types.ts
│   │   │   ├── index.ts
│   │   │   └── builtin/
│   │   │       ├── lint-on-write.ts
│   │   │       └── notify.ts
│   │   ├── mcp/
│   │   │   ├── client.ts
│   │   │   ├── registry.ts
│   │   │   └── index.ts
│   │   ├── pipelines/
│   │   │   ├── engine.ts
│   │   │   ├── parser.ts
│   │   │   ├── template.ts
│   │   │   └── index.ts
│   │   ├── indexer/
│   │   │   ├── walker.ts
│   │   │   ├── cache.ts
│   │   │   └── index.ts
│   │   ├── memory/
│   │   │   ├── store.ts
│   │   │   ├── search.ts
│   │   │   └── index.ts
│   │   ├── user-profile/
│   │   │   ├── profile.ts
│   │   │   ├── compressor.ts
│   │   │   └── index.ts
│   │   ├── context/
│   │   │   ├── manager.ts
│   │   │   └── index.ts
│   │   ├── session/
│   │   │   ├── types.ts
│   │   │   ├── store.ts
│   │   │   ├── manager.ts
│   │   │   ├── module.ts
│   │   │   └── index.ts
│   │   ├── hallucination/
│   │   │   ├── detector.ts
│   │   │   ├── factual.ts
│   │   │   ├── consistency.ts
│   │   │   ├── confidence.ts
│   │   │   └── index.ts
│   │   ├── updater/
│   │   │   ├── checker.ts
│   │   │   └── index.ts
│   │   └── execution/
│   │       ├── planner.ts
│   │       ├── tracker.ts
│   │       ├── verifier.ts
│   │       ├── stuck-detector.ts
│   │       ├── auditor.ts
│   │       └── index.ts
│   ├── cli/
│   │   ├── main.ts
│   │   ├── commands.ts
│   │   ├── repl.ts
│   │   ├── completer.ts          # Deep tab completion
│   │   ├── setup.ts              # Interactive setup wizard
│   │   └── index.ts
│   ├── config/
│   │   ├── config.ts
│   │   ├── types.ts
│   │   ├── defaults.ts
│   │   └── index.ts
│   ├── i18n/
│   │   ├── en.json
│   │   ├── ru.json
│   │   └── index.ts
│   ├── ui/
│   │   ├── md-formatter.ts
│   │   ├── output.ts
│   │   └── index.ts
│   ├── logger/
│   │   ├── app-logger.ts
│   │   └── index.ts
│   └── index.ts
├── docs/
│   └── specs/
│       └── 2025-07-28-mma-v2-design.md
├── node_modules/
├── package.json
├── tsconfig.json
├── bun.lock
└── .gitignore
```

~74 source files. Target: no file >300 lines.

---

## 13. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent loop | State machine | Predictable, testable, no if-else nesting |
| Plugins | Simple hook list | No event bus overhead, KISS |
| Tool definitions | Single registry | No duplication, single source of truth |
| Config defaults | One `defaults.ts` | No sync issues across 3 files |
| Prompt assembly | Block collection from modules | Each module owns its prompt content |
| Context compaction | Sliding window + pattern extraction | Fast, no second LLM call |
| Hallucination check | Pre-output pipeline | Catches errors before user sees them |
| Skill discovery | Keyword overlap + LLM selection | No embeddings, no external API |
| MCP | Client only | Simpler, covers use cases |
| Pipelines | DAG-based | Supports parallelism, clear dependencies |
| i18n | User messages only | CLI stays English, minimal scope |
| History | JSONL on disk | Full fidelity, searchable |
| UI | Markdown → ANSI | No TUI, no themes, no status bars |
| Tab completion | Provider-based registry | Each command registers its arg completer |
| Setup wizard | Port scan + test prompt | No external deps, pure fetch/readline |
| REPL history | File `~/.mma/repl-history` | Persistent, fuzzy-searchable via Ctrl+R |
| Task execution | Plan in system prompt block | Always visible, off-track guard, auto-verify |
| Error recovery | 3 retry → user question | All errors logged to memory for future |
| Orchestrator | Optional separate model | Plan + decisions on larger model, execution on 9B |
| Plan creation | Forced for multi-step | Not model's choice — system heuristic |
| Progress display | Per-step terminal output | `[Plan] 2/5 ██░░░ 40%` — видно всегда |
| Model auto-load | LM Studio REST API | Auto-load model with correct context on startup |
| Context defense | Multi-layer truncation | Tool results limited, pre-flight check, post-tool compact |
