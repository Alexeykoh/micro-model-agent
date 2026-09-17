# Prompt Caching, Cache Metrics & Provider Budget

> **Date:** 2026-09-17
> **Status:** Draft (к реализации)
> **Scope:** `src/llm/`, `src/modules/providers/`, `src/modules/pricing/`, `src/core/agent/`, `src/cli/`
> **Ключевое требование:** работать **везде** — облако (OpenAI, Anthropic, OpenRouter, DeepSeek, Gemini, xAI, OpenCode Zen/Go) **и локально** (LM Studio, llama.cpp, vLLM, Ollama), не привязываясь к одному вендору.

## 1. Проблема

Агентский цикл переотправляет **весь контекст** на каждой итерации (`system + tools + history`). Провайдеры умеют переиспользовать KV-кеш совпавшего префикса, но MMA:

1. **Не измеряет** кеш: поля `cached_tokens` / `cache_read_input_tokens` отбрасываются при парсинге usage.
2. **Завышает стоимость**: `CostTracker` считает все prompt-токены по полной input-цене, не зная, что часть — cache read.
3. **Не использует запросные рычаги**: нет `cache_prompt` (llama.cpp), `prompt_cache_key` (OpenAI), `session_id` (OpenRouter sticky routing), `cache_control` (Anthropic). При этом `x-opencode-session` уже отправляется всем — точечно, но без учёта провайдера.
4. **Не показывает бюджет** провайдеров, которые его отдают (OpenRouter), и не объясняет, почему для Zen/Go это невозможно по API-ключу.
5. **Не видит поломок префикса** — а именно они (смена набора тулов, compaction, volatile system-блок) чаще всего обнуляют кеш, и это проблема клиента, а не провайдера.

## 2. Цели

1. **Универсальное измерение кеша** — адаптеры под форматы ответов (OpenAI-совместимый, DeepSeek, Anthropic, Ollama) + **client-side prefix stability monitor**, который работает даже когда провайдер молчит.
2. **Корректная стоимость** — cache read/write учитываются по своим ценам; для локальных моделей деньги не считаются, показываются латентность и hit-rate.
3. **Максимизация hit-rate** — per-provider запросные подсказки (headers/body) под контролем capability-дескриптора; стабильный префикс как инвариант.
4. **Бюджет провайдера** — там, где API его отдаёт (OpenRouter); честная деградация там, где нет (Zen/Go).
5. **Наблюдаемость** — `cache %`, `saved $` (облако) / `TTFT`, hit% (локаль) / `prefix stable %` (фолбэк) в REPL, `--json` и `session.jsonl`.
6. **Ничего не ломать** — все запросные изменения строго за флагами провайдера; неподдерживающие бэкенды не получают новых полей.

### Не-цели

- Реализация `AnthropicProvider` на `/v1/messages` — отдельная спека (`docs/specs/2026-08-20-provider-module-design.md`, фаза Anthropic). Здесь только задел через capability.
- Парсинг баланса Zen/Go через браузерную cookie-сессию — хрупко, не делаем.
- Собственный серверный кеш/KV-offload — это зона провайдера (vLLM `--enable-prefix-caching`, NIM `NIM_ENABLE_KV_CACHE_REUSE`); MMA максимум предупредит.

## 3. Аудит текущего состояния

| Область | Файл | Состояние |
| ------- | ---- | --------- |
| Тип usage | `src/llm/provider.ts:47` | `Chunk.usage = { promptTokens, completionTokens, totalTokens }` — кеш-полей нет |
| Парсинг (stream) | `src/llm/openai-compat.ts:403` | Читает только `prompt_tokens/completion_tokens/total_tokens` |
| Парсинг (non-stream) | `src/llm/openai-compat.ts:639` | То же |
| Тело запроса | `src/llm/openai-compat.ts:62` (`buildRequestBody`) | Нет `cache_prompt` / `prompt_cache_key` / `session_id` / `cache_control` |
| Заголовки | `src/llm/openai-compat.ts:530` (`buildRequestSetup`) | `x-opencode-session` шлётся **всем** провайдерам при наличии sessionId |
| Учёт токенов | `src/core/agent/token-tracker.ts:63` (`logUsage`) | `costTracker.record(prompt, completion, provider)` — без кеша |
| Стоимость | `src/modules/pricing/index.ts:34` (`CostTracker.record`) | Нет разделения cached/uncached |
| Цены | `src/modules/pricing/prices.ts:9` (`ZEN_PRICES`), `:121` (`calculateCost`) | `ModelPrice { input, output }` — нет `cachedInput`/`cacheWrite` |
| Пресеты | `src/modules/providers/presets.ts` | Все — `openaiCompat`; Anthropic — заглушка |
| Capabilities | `src/modules/providers/types.ts:12` | Нет дескриптора кеша |
| Показ usage | `session-logger.ts:246`, `cli/run-result.ts:27`, `cli/repl.ts:692`, `cli/main.ts:119` | Только токены/стоимость, без кеша |
| `session show` | `src/cli/commands.ts:497` | Не агрегирует `llm_usage`/cost |
| Probe метаданных | `src/llm/model-loader.ts:33` (`getLoadedContextLength`) | Единственный поход к провайдеру за метаданными (LM Studio, context length) |

## 4. Внешняя реальность (проверено по докам, сентябрь 2026)

### 4.1 Механизмы и поля по провайдерам

| Провайдер | Механизм | Включает | Поля в ответе | Нужно от клиента |
| --------- | -------- | -------- | ------------- | ---------------- |
| OpenAI (GPT-5.6+) | prefix auto | сервер | `prompt_tokens_details.cached_tokens`, `cache_write_tokens` | опц. `prompt_cache_key`; write = **1.25×** для 5.6+ |
| OpenAI (старые) | prefix auto | сервер | `prompt_tokens_details.cached_tokens` | write бесплатен |
| Gemini / xAI | prefix auto | сервер | `cached_tokens` | — |
| DeepSeek | disk prefix auto | сервер | **`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`** | — |
| Anthropic | explicit breakpoints (или top-level auto) | **клиент** | `cache_read_input_tokens` / `cache_creation_input_tokens` | `cache_control`; read 0.1×, write 1.25×/2× |
| OpenRouter | proxy auto + explicit | сервер/клиент | `cached_tokens`, `cache_write_tokens`, `cost`, `cache_discount` | `session_id` для sticky routing |
| OpenCode Zen/Go | auto | сервер | ожидаемо `cached_tokens` (в прайсе есть Cached Read) | `x-opencode-session` — **уже шлётся** |
| llama.cpp / LM Studio | KV prefix | **сервер** | `prompt_tokens_details.cached_tokens` **и** `timings.cache_n` | иногда `cache_prompt: true` |
| vLLM | Automatic Prefix Caching | сервер (`--enable-prefix-caching`) | `cached_tokens` | — |
| Ollama | context cache | сервер | `prompt_eval_count` (прямого cached нет) | — |

### 4.2 Бюджет провайдера

| Провайдер | API баланса | Примечание |
| --------- | ----------- | ---------- |
| OpenRouter | `GET /api/v1/key` (обычный ключ), `GET /api/v1/credits` (management key) | Единственный стабильный вариант |
| OpenCode Zen | API-ключ не отдаёт баланс | только веб-дашборд (`server.queryBilling` требует cookie) |
| OpenCode Go | То же + лимиты $12/5ч, $30/нед, $60/мес | usage-эндпоинт требует консольной авторизации |

### 4.3 Ключевые факты, влияющие на дизайн

- **Минимум для кеша**: OpenAI 1024 токена (шаг 128), Anthropic 1024–4096 в зависимости от модели. Ниже — **молчаливый** промах.
- **TTL**: Anthropic 5 мин (обновляется хитом), 1 ч опционально; OpenAI 5–10 мин, до 1 ч в off-peak. Пауза в сессии обнуляет.
- **Sticky routing**: тёплый кеш живёт на конкретном endpoint. Без session-affinity ход 2 может уйти на холодный — платишь полную цену.
- **Компакция ломает префикс**, если делается с другим system/tools (Anthropic явно рекомендуют сохранять префикс родителя).
- **Смена набора тулов** (Tool Set Narrowing) инвалидирует весь кеш — прямой конфликт с оптимизацией токенов.
- **llama.cpp `cache_prompt`** исторически `false` и меняет детерминизм при `temperature:0` → включать только флагом.

## 5. Архитектура

Принцип: **capability-дескриптор кеша на провайдера + набор адаптеров + универсальный client-side монитор**. Облако получает метрики и деньги, локаль — метрики и латентность, неизвестные серверы — оценку стабильности префикса.

```
┌──────────────────────────────────────────────────────────────────┐
│ ProviderSpec.cache (capability)                                  │
│  mechanism: auto | explicit | local | none                       │
│  report:    openai | deepseek | anthropic | ollama | none        │
│  requestHints: cachePrompt | promptCacheKey | sessionId          │
│  pricing?: { cachedInput, cacheWrite }                           │
└───────────────┬──────────────────────────────────────────────────┘
                │
   ┌────────────▼────────────┐   ┌──────────────────────────────┐
   │ Request layer           │   │ Response normalizer          │
   │ (openai-compat headers  │   │ (openai/deepseek/anthropic/  │
   │  + body hints, за флагом)│  │  ollama → CacheUsage)        │
   └────────────┬────────────┘   └──────────────┬───────────────┘
                │                               │
                │              ┌────────────────▼───────────────┐
                │              │ Prefix stability monitor        │
                │              │ (client-side, работает всегда)  │
                │              └────────────────┬───────────────┘
                │                               │
   ┌────────────▼───────────────────────────────▼───────────────┐
   │ CostTracker / TokenTracker → session.jsonl → REPL / JSON   │
   └────────────────────────────────────────────────────────────┘
```

### 5.1 Capability-дескриптор

`src/modules/providers/types.ts`:

```ts
export type CacheMechanism = "auto" | "explicit" | "local" | "none";
export type CacheReportFormat =
  | "openai"    // prompt_tokens_details.cached_tokens / cache_write_tokens
  | "deepseek"  // prompt_cache_hit_tokens / prompt_cache_miss_tokens
  | "anthropic" // cache_read_input_tokens / cache_creation_input_tokens
  | "ollama"    // prompt_eval_count vs оценка длины промпта
  | "none";

export interface CacheCapability {
  mechanism: CacheMechanism;
  report: CacheReportFormat;
  /** Слать ли session-affinity заголовок (x-opencode-session). */
  sessionHeader?: boolean;
  /** Тело запроса: cache_prompt:true (llama.cpp). */
  requestCachePrompt?: boolean;
  /** Тело запроса: prompt_cache_key = sessionId (OpenAI). */
  requestPromptCacheKey?: boolean;
  /** Тело запроса: session_id = sessionId (OpenRouter sticky). */
  requestSessionId?: boolean;
  /** Явные breakpoints (Anthropic). */
  requestCacheControl?: boolean;
}
```

`ProviderCapabilities` расширяется `cache?: CacheCapability`. Дефолты задаются в `presets.ts` по типу, переопределяются в конфиге на запись провайдера (как остальные capabilities).

### 5.2 Нормализованный `CacheUsage`

`src/llm/provider.ts`:

```ts
export interface CacheUsage {
  cachedTokens: number;      // прочитано из кеша
  cacheWriteTokens: number;  // записано в кеш
  /** Сколько prompt-токенов НЕ из кеша (для стоимости). */
  uncachedTokens: number;
  source: "api" | "derived" | "none";
}

export interface Chunk {
  // ...
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cache?: CacheUsage;
  };
}
```

### 5.3 Адаптеры форматов

Новый `src/llm/cache-usage.ts` — чистая функция без I/O:

```ts
export function parseCacheUsage(
  usage: unknown,
  format: CacheReportFormat,
  estimatedPromptTokens?: number,
): CacheUsage | undefined;
```

- `openai`: `prompt_tokens_details.cached_tokens` (+ `cache_write_tokens`); `uncached = prompt - cached`.
- `deepseek`: `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`; при отсутствии — `cached=hit`, `uncached=miss`.
- `anthropic`: `cache_read_input_tokens` / `cache_creation_input_tokens`; `uncached = input_tokens`.
- `ollama`: оценка `cached = max(0, estimatedPromptTokens - prompt_eval_count)`, `source: "derived"`.
- `none`: `undefined`.

Вызывается в `openai-compat.ts` в обоих местах (`:403` stream, `:639` non-stream), формат берётся из активного `CacheCapability` (пробросить в `OpenAICompatConfig`).

### 5.4 Prefix stability monitor

Новый `src/core/agent/prefix-monitor.ts`. Не зависит от провайдера — считает по промптам, которые агент и так строит.

```ts
export interface PrefixDelta {
  prevTokens: number;
  currTokens: number;
  commonPrefixTokens: number;   // по токенам, а не символам
  stableRatio: number;          // commonPrefix / currTokens
  /** Что первым изменилось после общего префикса. */
  cause:
    | "none" | "system" | "tools" | "history" | "volatile" | "unknown";
}

export function diffPrefix(prev: Message[], curr: Message[]): PrefixDelta;
```

- Сериализует сообщения в детерминированную строку (стабильный `JSON.stringify` по ключам) и ищет общий префикс токенов через `TokenCounter`.
- `cause` определяется по тому, на каком участке префикса разошлось: `system` (начало), `tools` (до system?) — уточнить по реальному порядку сборки промпта, `history` (середина), `volatile` (timestamp/UUID/пути в первых N токенах).
- Хранит предыдущий промпт в состоянии агента; сбрасывается при смене модели/провайдера/сессии.
- Работает **всегда**, в т.ч. на Ollama, экзотических прокси и `report: "none"`.

### 5.5 Стоимость

`src/config/types.ts`: `ModelPrice { input; output; cachedInput?; cacheWrite? }`.

`src/modules/pricing/prices.ts`:
- Заполнить `cachedInput` для Zen/Go из таблицы Cached Read (MiniMax 0.06; GLM 0.20/0.26 и т.д.), для OpenAI/Anthropic — по их множителям, где известны.
- `calculateCost(model, usage, config)` — новая сигнатура, принимающая `CacheUsage`:
  ```
  cost = uncached/1e6 * input
       + cached/1e6   * (cachedInput ?? input)
       + write/1e6    * (cacheWrite ?? 0)
       + completion/1e6 * output
  ```
- Старую сигнатуру `calculateCost(model, prompt, completion, config)` сохранить как обёртку (для обратной совместимости тестов).

`src/modules/pricing/index.ts`: `CostTracker.record(usage, provider)` пишет `_total`, а также `_saved` (разница с «без кеша»), `breakdown()` дополняется `saved`.

Важно: `TokenTracker.logUsage` (`token-tracker.ts:63`) сейчас получает только prompt/completion. Пробрасываем `CacheUsage` из состояния цикла (новое поле `LoopState.cacheUsage`).

### 5.6 Бюджет провайдера (опционально)

Новый `src/llm/provider-budget.ts`:

```ts
export interface ProviderBudget {
  provider: string;
  balanceUsd?: number;      // remaining
  totalCredits?: number;
  totalUsage?: number;
  keyLimitUsd?: number;     // per-key cap
  keyRemainingUsd?: number;
  source: "openrouter" | "none";
}

export async function fetchBudget(
  provider: string, baseUrl: string, apiKey: string, timeoutMs?,
): Promise<ProviderBudget | null>;
```

- OpenRouter: `GET /api/v1/key` (per-key `limit`/`limit_remaining`/`usage`); если доступен management key — `GET /api/v1/credits`.
- Zen/Go: возвращаем `null` и документируем «API-ключ не отдаёт баланс».
- Вызывается только по явной команде/флагу (`mma usage`, конфиг `provider.budgetProbe: false` по умолчанию), не в горячем цикле.

### 5.7 Показ

- Облако: `cache 87% · saved $0.42` (`cli/run-result.ts:27`, `cli/repl.ts:692`, `cli/main.ts:119` — добавить `cache` и `saved` в JSON).
- Локаль (`mechanism: "local"` или нет цены): `cache 91% · TTFT 0.4s`.
- Нет телеметрии: `prefix stable 93%` (+ `cause: tools changed` при промахе).
- `session.jsonl`: событие `llm_usage` дополняется `cachedTokens`, `cacheWriteTokens`, `cacheSource`, `stableRatio`, `cause`.
- `session show` (`cli/commands.ts:497`): агрегировать `llm_usage` — суммарные prompt/completion/cached, hit-rate, стоимость, savings.

## 6. Фазы и план работ

### Фаза 0 — Capability-дескриптор

**Файлы:** `src/modules/providers/types.ts`, `presets.ts`, `src/config/types.ts`.
**Задачи:**
- Добавить `CacheCapability` и `ProviderCapabilities.cache?:`.
- Заполнить дефолты по пресетам: openai-compat (local → `local`/`openai`, `requestCachePrompt` — под вопросом, см. открытые), openai (`auto`/`openai`, `requestPromptCacheKey`), deepseek (`auto`/`deepseek`), anthropic (`explicit`/`anthropic`, `requestCacheControl`), openrouter (`auto`/`openai`, `requestSessionId`), opencode-zen/go (`auto`/`openai`, `sessionHeader`), ollama (если есть отдельный тип; иначе `openai` с флагом).
- Разрешить переопределение `cache` в `ProviderEntry`.

**Acceptance:** `mma provider list` показывает cache-возможности; конфиг валидируется; типы компилируются.

### Фаза 1 — Запросный слой

**Файлы:** `src/llm/openai-compat.ts` (`buildRequestBody`, `buildRequestSetup`), `presets.ts`.
**Задачи:**
- `cache_prompt: true` в body при `requestCachePrompt` (за флагом конфига, документировать nondeterminism).
- `prompt_cache_key = sessionId` при `requestPromptCacheKey`.
- `session_id = sessionId` в body при `requestSessionId`.
- `cache_control` breakpoints — только когда появится реальный AnthropicProvider; сейчас — no-op за флагом.
- `x-opencode-session` слать только при `sessionHeader` (сохранить текущее поведение для Zen/Go); обобщить имя через опцию.

**Acceptance:** запросы к не-поддерживающим бэкендам байт-в-байт прежние (тест на отсутствие новых полей); для Zen/Go добавление ключей не ломает 200.

### Фаза 2 — Парсинг и нормализация

**Файлы:** `src/llm/cache-usage.ts` (новый), `src/llm/provider.ts`, `src/llm/openai-compat.ts`, `src/llm/stream-state.ts`.
**Задачи:**
- Ввести `CacheUsage`, расширить `Chunk.usage`.
- `parseCacheUsage` со всеми форматами (см. 5.3).
- Пробросить `CacheReportFormat` через `OpenAICompatConfig`/`ProviderOptions`.
- Парсить в stream (`:403`) и non-stream (`:639`); при стриминге обрабатывать usage в финальном чанке.

**Acceptance:** тесты на каждый формат (фикстуры ответов OpenAI/DeepSeek/Anthropic/Ollama/llama.cpp); неизвестный формат → `undefined`, без ошибок.

### Фаза 3 — Prefix stability monitor

**Файлы:** `src/core/agent/prefix-monitor.ts` (новый), `src/core/agent/loop-state.ts`, `src/core/agent.ts`.
**Задачи:**
- Реализовать `diffPrefix(prev, curr)` и классификацию `cause`.
- Хранить предыдущий промпт, сбрасывать при смене модели/провайдера.
- Логировать `stableRatio`/`cause` в `llm_usage`.

**Acceptance:** синтетические промпты — стабильный, изменённый system, изменённые tools, изменённый хвост; корректный `cause`.

### Фаза 4 — Стоимость

**Файлы:** `src/modules/pricing/prices.ts`, `src/modules/pricing/index.ts`, `src/config/types.ts`, `src/core/agent/token-tracker.ts`, `loop-state.ts`.
**Задачи:**
- `ModelPrice.cachedInput`/`cacheWrite`; заполнить таблицу Zen/Go.
- Новая `calculateCost` с `CacheUsage`; сохранить обратную совместимость.
- `CostTracker`: `_saved`, `record(usage, provider)`, `breakdown()` c `saved`.
- `TokenTracker.logUsage` принимает `CacheUsage`, кладёт в `logLlmUsage`.

**Acceptance:** тесты кейсов cached/uncached/write/нет цены; стоимость не завышается при частичном кеше; локаль без цены — деньги не считаются.

### Фаза 5 — Показ

**Файлы:** `src/cli/run-result.ts`, `src/cli/repl.ts`, `src/cli/main.ts`, `src/core/session-logger.ts`, `src/modules/session/store.ts`, `src/cli/commands.ts`.
**Задачи:**
- Формат вывода для трёх режимов (облако / локаль / фолбэк).
- Поля в `llm_usage` и в JSON-результате.
- `session show` агрегирует usage + cache + savings.

**Acceptance:** snapshot/тесты форматирования; `session show` показывает hit-rate.

### Фаза 6 — Бюджет провайдера (опционально)

**Файлы:** `src/llm/provider-budget.ts` (новый), `src/cli/commands.ts`, `src/config/types.ts`.
**Задачи:**
- `fetchBudget` (OpenRouter only), команда `mma usage`, флаг `provider.budgetProbe`.
- Для Zen/Go — явное сообщение «не поддерживается по API-ключу».

**Acceptance:** мок OpenRouter `/api/v1/key`; отсутствие ключа/эндпоинта → тихий `null`.

### Фаза 7 — Документация

`docs/agents/modules.md` (Cost Tracking + Cache), `docs/agents/tools.md`/`architecture.md` при необходимости, `AGENTS.md` (Quick Reference), `CHANGELOG.md`, обновить статус этой спеки.

## 7. Тесты

- Юнит: `parseCacheUsage` (5 форматов + мусор), `calculateCost`/`CostTracker` (cached/write/unknown price), `diffPrefix` (все `cause`).
- Интеграция: отсутствие новых полей тела/заголовков для провайдеров без флагов; парсинг usage из сохранённого SSE-снапшота.
- Не использовать `vi.mock` в Bun (глобальный на процесс) — применять test seams, как в MoE (`docs/agents/testing.md`).

## 8. Риски и меры

| Риск | Мера |
| ---- | ---- |
| `cache_prompt: true` меняет детерминизм llama.cpp | флаг по умолчанию off; документировать; включается явно |
| Новые поля ломают строгие бэкенды | всё за capability-флагами; тест «не-поддерживающий бэкенд не меняется» |
| `x-opencode-session` перестанет слаться куда нужно при сужении | сохранить текущее поведение Zen/Go; добавить тест на регресс |
| Prefix monitor даёт ложную уверенность | явно помечать источник (`api`/`derived`/`estimate`); не выдавать derived за факт |
| Правки набора тулов/Tool Set Narrowing обнуляют кеш | monitor делает это видимым; решение об изменении политики сужения — отдельно |
| Локальный провайдер без prefix caching (vLLM без флага) | hint/предупреждение, не считать багом MMA |

## 9. Открытые вопросы — решения

1. **Tool Set Narrowing vs кеш** — в рамках этой спеки политику сужения **не меняем**; Фаза 3 делает потерю видимой (`cause: "tools"`). Изменение политики — отдельная спека.
2. **`cache_prompt` для openai-compat** — дефолт **off**, только явный флаг (`CacheCapability.requestCachePrompt` / конфиг). Автодетект llama.cpp — кандидат на будущее, чтобы не менять детерминизм неожиданно.
3. **Компакция** — вне scope; фиксируем как связанную задачу и упоминаем причину промаха в мониторе (`cause`), не трогая саму компакцию.
4. **Порог отображения** — строку кеша показываем только при наличии сигнала: `cachedTokens > 0` **или** `stableRatio < 0.98` **или** `source !== "none"`. Иначе — не засоряем вывод.
5. **Ключ сессии** — все три (`x-opencode-session`, `prompt_cache_key`, `session_id`) используют **live session id** сессии MMA. Для агентского цикла это и есть правильная «группа префикса» (один разговор = один ключ), а детерминированный `provider:model:workspace` давал бы лишь межзапусковую стабильность, которая кешу TTL-провайдеров не нужна. Если понадобится переиспользование префикса между сессиями — добавим опциональный `cacheKey` поверх, без смены семантики по умолчанию.

## 10. Статус реализации

- [x] Фаза 0 — типы `CacheCapability`, `ProviderEntry.cache`, дефолты пресетов, resolver, проброс capabilities в `ProviderManager.build()`.
- [x] Фаза 1 — запросный слой: `cache_prompt` (за флагом), `prompt_cache_key` (OpenAI), `session_id` (OpenRouter), гейтинг `x-opencode-session` по `sessionHeader` с легаси-фолбэком при отсутствии capability. Фабрика `openaiCompat` прокидывает `opts.capabilities.cache` в провайдера. Тесты: `tests/provider-cache-request.test.ts`.
- [ ] Фаза 2 — парсинг/нормализация.
- [ ] Фаза 3 — prefix monitor.
- [ ] Фаза 4 — стоимость.
- [ ] Фаза 5 — показ.
- [ ] Фаза 6 — бюджет провайдера.
- [ ] Фаза 7 — документация.

## 11. Приложение — источники

- OpenAI Prompt Caching: https://developers.openai.com/api/docs/guides/prompt-caching
- Anthropic Prompt Caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- DeepSeek Context Caching: https://api-docs.deepseek.com/guides/kv_cache
- OpenRouter Prompt Caching: https://openrouter.ai/docs/guides/best-practices/prompt-caching
- OpenRouter Credits API: https://openrouter.ai/docs/api/api-reference/credits/get-credits
- llama.cpp server (timings, cache_prompt): https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- OpenCode Zen pricing (Cached Read): https://opencode.ai/docs/zen
- OpenCode Go (лимиты, endpoints): https://opencode.ai/docs/go
- Claude Code prompt caching lessons (compaction/prefix): https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything
