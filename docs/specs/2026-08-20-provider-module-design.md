# Provider Module — Стандартизация и расширяемость

> **Статус:** **Фазы 1–3 реализованы.** Остальные фазы — к реализации в будущих релизах.
> **Проблема:** провайдеры — это строки + `HOSTED_BASE_URLS`; один класс `OpenAICompatProvider`
> обслуживает все типы, некоторые пресеты (`anthropic`) сломаны, а создание провайдера
> продублировано в 4 местах.
> **Ключевое требование:** поддержка **нескольких провайдеров одновременно**, **горячая
> смена** провайдера и **модели** посреди сессии, и логирование **какой модели/провайдеру**
> отправлялось каждое сообщение и от кого пришёл ответ.

## Текущее состояние (аудит)

| Проблема | Где | Описание |
| -------- | --- | -------- |
| Только один класс провайдера | `src/llm/openai-compat.ts` (`OpenAICompatProvider`) | Все типы идут через OpenAI-совместимый wire-формат |
| Сломанный пресет | `src/cli/setup.ts` `HOSTED_BASE_URLS.anthropic = "https://api.anthropic.com"` | API Anthropic **не** OpenAI-совместимо (`/v1/messages`); пресет не может работать |
| Дублирование создания | `src/core/bootstrap.ts:171`, `src/core/agent.ts:1131`, `src/cli/commands.ts:135`, `src/llm/orchestrator.ts:76` | 4 места собирают провайдера вручную; риск рассинхрона |
| Плоский конфиг | `src/config/types.ts` `ProviderConfig { type, baseUrl, apiKey }` | Нет регистра, нет опций на провайдера, нет capabilities |
| Ретрай/rate-limit вшиты | `openai-compat.ts` `RetryConfig`, `RateLimiter` | Один класс владеет и wire-форматом, и ретраем, и rate-limit, и пайсингом |

## Цели

1. **Реестр провайдеров** — единый источник истины `type → фабрика`, чтобы добавить
   провайдера = одна регистрация, а не новый `if` в 4 файлах.
2. **Capability-aware** — провайдеры заявляют, что поддерживают (`streaming`, `tools`,
   `vision`, `reasoningEffort`, `listModels`, `requiresKey`), агент подстраивается
   (например, не шлёт `reasoning_effort` бэкендам, которые его отвергают).
3. **Корректная поддержка Anthropic** (опциональная фаза) — настоящий `AnthropicProvider`
   на `/v1/messages` вместо сломанного алиаса.
4. **Единая фабрика** — `createProvider(config)` используется везде (bootstrap,
   reconfigure, model list, orchestrator).
5. **Разделение ответственности** — wire-формат, ретрай/backoff, rate-limit и пайсинг —
   переиспользуемые части, в которые провайдер может встраиваться, а не хардкод в одном классе.
6. **Несколько провайдеров одновременно** — несколько записей провайдер/модель в конфиге;
   агент выбирает нужного на каждый вызов (по умолчанию или через промпт/CLI).
7. **Горячая смена провайдера и модели** — REPL-команды `/provider` и `/model` переключают
   активного провайдера/модель без перезапуска; новый провайдер собирается на лету.
8. **Логирование происхождения сообщений** — каждый вызов LLM и каждое сообщение фиксирует,
   какой `model` + `provider` отправлялось и от кого пришло; видно в логах сессии
   (`session.jsonl`), событиях `llm_usage` и в REPL.

## Дополнительные идеи (сверх заявленного требования)

- **Изоляция ключа/rate-limit на провайдера** — каждая запись несёт свой `apiKey`,
  `rateLimits`, `retry`, чтобы троттлинг одного не тормозил остальных.
- **Автоматический fallback** — если активный провайдер отдаёт 429/5xx, агент переключается
  на следующего из списка (`provider.fallback`) и логирует переключение.
- **Атрибуция стоимости по провайдеру** — CostTracker считает итоги по ключу
  `provider/model` (не единый бегущий итог), так что `--json`/контекст-бар показывают
  расход по каждому провайдеру и общий итог.
- **Тул `provider`** — модель может через тул сменить модель/провайдера или выбрать другого
  для подзадачи (как `enable_tools`), а не только через CLI-команды.
- **Маршрутизация по capabilities** — выбор провайдера по совпадению с задачей (vision →
  vision-провайдер; длинный контекст → модель с большим окном).
- **Health-проверка провайдеров** — на старте прозондировать каждого (listModels / мини-chat)
  и показать ✓/✗ на провайдера в баннере REPL.
- **Sticky-происхождение в сессии** — REPL `/status` показывает, какая модель/провайдер
  ответил на последние N ходов.

## Предлагаемая архитектура

```
src/modules/providers/
├── registry.ts        # ProviderRegistry: type → фабрика, поиск capabilities
├── types.ts           # ProviderCapabilities, ProviderSpec, ProviderFactory
├── create.ts          # createProvider(config): LLMProvider (единая точка входа)
├── manager.ts         # ProviderManager: активный провайдер, switch(), list(), fallback()
└── presets.ts         # Пресеты: type → {baseUrl, requiresKey, label, capabilities}
```

### Схема конфига (мульти-провайдер)

Обратно-совместимая эволюция `ProviderConfig`:

```typescript
interface ProviderEntry {
  type: string;            // "openai-compat" | "openrouter" | "anthropic" | ...
  label?: string;          // имя для пользователя (по умолчанию = type)
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  retry?: RetryConfig;
  rateLimits?: RateLimitConfig;
  capabilities?: Partial<ProviderCapabilities>; // переопределение на запись
  priority?: number;       // порядок fallback (меньше = пробуем первым)
}

interface ProviderConfig {
  active?: string;                          // label/type активного провайдера
  entries?: ProviderEntry[];                // все настроенные провайдеры
  fallback?: boolean;                       // авто-failover на 429/5xx (по умолч. false)
  // legacy-поля одного провайдера продолжают работать:
  type?: string;
  baseUrl?: string;
  apiKey?: string;
}
```

- `config.provider.entries[].active` выбирает текущего провайдера.
- `config.model` остаётся активной моделью; переопределение модели на провайдера — через
  запись entry.
- `/provider <name>` ставит `active`; `/model <m>` ставит `config.model` и пересобирает
  активного провайдера через `createProvider()`.

### Менеджер провайдеров (runtime)

```typescript
class ProviderManager {
  constructor(config: ProviderConfig, opts: ProviderOptions);
  get active(): LLMProvider;
  get activeName(): string;      // "openrouter"
  get activeModel(): string;
  list(): ProviderSpec[];
  switch(name: string, model?: string): LLMProvider;  // горячая смена, ошибка на неизвестный
  setModel(model: string): LLMProvider;               // пересборка активного с новой моделью
}
```

`Agent.reconfigure()` (и новые `/provider`, `/model`) зовут менеджер, а не собирают
провайдера вручную.

### Логирование происхождения сообщений

Каждый вызов LLM и каждое сообщение несёт происхождение. Два уровня:

1. **В цикле стрима** — захват активного провайдера/модели на старте вызова:

```typescript
// в итерации agent.ts
const caller = { provider: this.providerManager.activeName, model: config.model };
```

2. **В логах** — расширяем выдаваемые записи:
   - событие `llm_usage` в `session.jsonl` получает поля `provider` + `model`
     (расширяется сигнатура `slog.logLlmUsage`).
   - события `context` и записи тулов наследуют активные `provider`/`model` на свой ts.
   - `logger.logLLMResponse` получает `provider` + `model`.
   - События тулов (`ToolEvent`) несут `caller`, чтобы футер тула в REPL показывал
     `model/provider`, когда тул породил LLM-вызов (например, `chunk_query`).

**Помощник:** небольшая структура `Caller { provider, model }`, проброшенная через цикл
агента и логгер сессии, чтобы строка провайдера/модели никогда не угадывалась постфактум.

### Интеграция с CLI / setup

- `mma provider list` — зарегистрированные пресеты + capabilities + флаги «сломано».
- `mma provider use <type>` — baseUrl из реестра; отказ от заведомо сломанных пресетов
  (например, предупреждение, если `anthropic` ещё не настоящий провайдер).
- Мастер настройки строит меню из реестра (не из хардкод-массива).
- REPL: `/provider <name>` и `/model <m>` — горячая смена через ProviderManager.

### Ключевые типы

```typescript
interface ProviderCapabilities {
  streaming: boolean;       // SSE delta streaming
  tools: boolean;           // function calling
  vision: boolean;          // image_url content parts
  reasoningEffort: boolean; // параметр reasoning_effort
  listModels: boolean;      // GET /models
  requiresKey: boolean;     // apiKey обязателен
  auth?: "bearer" | "header"; // как передаётся ключ (будущее: имя/значение заголовка)
}

interface ProviderSpec {
  type: string;
  label: string;            // для мастера / списка провайдеров
  baseUrl: string;          // пресет по умолчанию ("" = пользователь вводит сам)
  capabilities: ProviderCapabilities;
  create: (opts: ProviderOptions) => LLMProvider; // фабрика
}
```

### Контракт реестра

```typescript
const registry = new ProviderRegistry();
registry.register({ type: "openai-compat", ...OpenAICompatSpec });
registry.register({ type: "openrouter", ...OpenRouterSpec });
// будущее: registry.register({ type: "anthropic", ...AnthropicSpec });

const spec = registry.get("openrouter");            // ProviderSpec | undefined
const provider = createProvider(config, registry);  // ошибка на неизвестный/неверный тип
```

### ProviderOptions (что получают фабрики)

```typescript
interface ProviderOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow: number;
  retry?: RetryConfig;
  rateLimits?: RateLimitConfig;
  capabilities?: Partial<ProviderCapabilities>; // переопределения из конфига
}
```

## Рефакторинг wire-формата (разделение ответственности)

Вынести из `openai-compat.ts` переиспользуемые примитивы, чтобы будущий AnthropicProvider
использовал ту же «обвязку»:

| Часть | Сейчас | Новое место |
| ----- | ------ | ----------- |
| Ретрай/backoff + `Retry-After` | `fetchWithRetry` (приватный) | `src/llm/http/retry.ts` `fetchWithRetry(url, init, retryConfig)` |
| Rate-limit | `createRateLimiter` (security) | переиспользуется как есть (уже самостоятельный) |
| Подсчёт токенов | `TokenCounter` | переиспользуется как есть |
| Парсер стрима | инлайн в `doStream` | `src/llm/http/stream-parser.ts` `parseSSE(reader, onChunk)` |
| Сборка тела запроса | `buildRequestBody` | `src/llm/http/body.ts` (OpenAI-совместимая форма) |

`OpenAICompatProvider` собирает их; `AnthropicProvider` собирает те же ретрай + rate-limit +
парсер со своими body/URL.

## Путь миграции (обратная совместимость)

- `ProviderConfig { type, baseUrl, apiKey }` остаётся без изменений.
- Добавляется опциональный `config.provider.capabilities` для переопределений.
- `createProvider()` для неизвестного типа падает на `OpenAICompatProvider` (как сегодня),
  так что существующие конфиги (`type: "openai-compat"` / кастомный baseUrl) продолжают работать.
- 4 места ручного создания заменяются на `createProvider()`.
- `HOSTED_BASE_URLS` в `setup.ts` выводится из пресетов реестра (единый источник истины).

## Критерии приёмки

1. `createProvider()` — единственная точка создания; нет `new OpenAICompatProvider` в
   core/cli/orchestrator.
2. Добавить провайдера = один `registry.register(...)` + фабрика; цикл агента не меняется.
3. `provider list` показывает capabilities на каждый тип.
4. Все существующие конфиги (кастомный baseUrl, openai-compat) работают без изменений.
5. `bun test` зелёный, `tsc --noEmit` чистый.
6. (Опционально) настоящий AnthropicProvider проходит round-trip `chat` против messages API.

## Вне рамок (эта итерация)

- Wire-формат Anthropic (отдельная фаза, если попросят).
- Различия tool-call у провайдеров сверх capability-флагов.
- Автоматический пайсинг на провайдера (по-прежнему через `pricing.overrides`).

## Приоритеты реализации

> План разбит на фазы. Каждая фаза самодостаточна, работает без последующих и проходит
> `bun test` + `tsc --noEmit`. Версионность по AGENTS.md: фаза 1 = PATCH (рефакторинг без
> нового поведения), фазы 2–3 = MINOR (новые команды/конфиг), фаза 4 = MINOR (новый тул).

### Фаза 1 — Фундамент: реестр + фабрика (PATCH) — ✅ РЕАЛИЗОВАНО
**Цель:** одна точка создания провайдера; подготовка к нескольким провайдерам.
- `src/modules/providers/{types,registry,presets,create,index}.ts` — `ProviderSpec`,
  `ProviderCapabilities`, `ProviderRegistry`, `createProvider()`.
- Зарегистрированы пресеты: `openai-compat`, `openrouter` (новый), `openai`, `anthropic`
  (флаг `capabilities` помечает не-OpenAI-совместимость), `opencode-zen`, `opencode-go`.
- Заменены 4 ручные конструкции (`bootstrap`, `agent/reconfigure`, `commands`, `orchestrator`)
  на `createProvider()`.
- `HOSTED_BASE_URLS` выводится из пресетов реестра (единый источник истины).
- Тесты: `tests/providers.test.ts` (8 случаев).

### Фаза 2 — Несколько провайдеров + горячая смена (MINOR) — ✅ РЕАЛИЗОВАНО
**Цель:** ключевое требование — несколько провайдеров одновременно и hot-swap.
- Конфиг `ProviderConfig.entries[]` + `active` (обратная совместимость с плоским объектом).
- `ProviderManager` — `switch()`, `setModel()`, `list()`, fallback-порядок.
- REPL `/provider <name>` и `/model <m>` через менеджер; баннер показывает активного.
- `mma provider list` / `mma provider use` читают реестр.
- **Критерий:** переключение провайдера/модели на лету без перезапуска.
- Реализация: `src/modules/providers/manager.ts`; `ProviderConfig.entries`/`active` в
  `src/config/types.ts`; `AgentDeps.providerManager` + `Agent.setProvider()`/`listProviders()`
  в `src/core/agent.ts`; инициализация через менеджер в `src/core/bootstrap.ts`;
  REPL `/provider list|use` и CLI `mma provider add|list|use`; тесты `tests/providers.test.ts`
  (14 случаев).

### Фаза 3 — Логирование происхождения сообщений (MINOR) — ✅ РЕАЛИЗОВАНО
**Цель:** ключевое требование — видно, какой модели/провайдеру шло и от кого пришло.
- Структура `Caller { provider, model }` в цикле агента и логгере сессии.
- Расширить `llm_usage`, `context`, `ToolEvent`, `logLLMResponse` полями `provider`/`model`.
- REPL: футер тула и `/status` показывают провайдера/модель ответа.
- **Критерий:** по `session.jsonl` однозначно восстанавливается провайдер/модель каждого вызова.
- Реализация: `Agent.callerProvenance()` (`src/core/agent.ts`) — живой источник `{provider, model}`
  (менеджер или legacy-конфиг); `SessionLogger` получает колбэк `getCaller` и пишет `provider`/`model`
  в `llm_usage`, `context`, `assistant`/`reasoning`/`tool_result` логи и в `history.jsonl`-сообщения
  (`SessionMessage.provider`/`model`); `ToolEvent` + футер тула в `renderer.ts` показывают
  `via provider·model`; `/status` и `/config` показывают активного провайдера из менеджера;
  `logLLMRequest`/`logLLMResponse` в file-логе получают провайдера вместо хардкода `"agent"`.
  Тесты: `tests/session-logger.test.ts` (4 случая).

### Фаза 4 — Доп. идеи по приоритету (MINOR, каждая отдельно)
Порядок внутри фазы — по ценности к усилиям:
1. **Cost-атрибуция по провайдеру** — CostTracker по ключу `provider/model` (быстро, тесно
   связано с фазой 3).
2. **Fallback на 429/5xx** — авто-failover на следующего провайдера с логированием.
3. **Изоляция rate-limit/ключа на запись** — каждый entry со своим `apiKey`/`rateLimits`.
4. **Тул `provider`** — модель сама выбирает провайдера для подзадачи.
5. **Health-проб + маршрутизация по capabilities** — баннер ✓/✗ и выбор по задаче.

### Опционально — отдельная фаза
- Настоящий `AnthropicProvider` на `/v1/messages` (чинит сломанный пресет `anthropic`).