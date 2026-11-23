# MMA — эффективность research-прогона (2026-11-23)

**Дата:** 2026-11-23 · **Статус:** target · **Ветка:** `fix/research-loop-efficiency`

## Проблема

Сессия `ses_mwt1gw9o_eyxsehbrwjrhdzsn` (запрос про цены GYM24) заняла 8 мин 10 с.
`web_fetch` вернул полный ответ за 142 мс, но агент:

1. повторил ту же страницу через `web_browse` и 6 раз через Playwright MCP;
2. после сброса страницы в `about:blank` не переключился на работавший тул;
3. запустил `chunk_query` на 247 932 символа — 22 чанка, 196 с, без прироста качества;
4. сжег 4 вызова на борьбу с одной строкой JSON-LD в выводе `grep`;
5. получил в схеме 44 тула (~7 464 токенов описаний) для простого веб-вопроса;
6. не оставил в журнале метрики дублирующих вызовов.

Сеть и сайт не были причиной: `web_fetch` — 142 мс, `curl` — 805 мс, HTTP 200.

## Решение

### 1. Early-exit в статическом блоке промпта

В `src/core/system-prompt-render.ts` рядом с правилом `Web research:` добавляется
одна короткая директива: если загруженная страница уже содержит ответ — отвечать
сразу, не перезапрашивать тот же источник другим тулом. Формулировка на английском
(ядро промпта), без i18n-ключа. Бюджет compact-core (≤910 токенов) и лимит строки
≤120 символов сохраняются: при необходимости остальные директивы сжимаются.

### 2. Circuit breaker для MCP

В `src/tools/mcp-call.ts` рядом с `lastMcpCall` добавляется счётчик последовательных
неудач на сервер и время запрета (cooldown). Порог — 2 неудачи подряд, cooldown —
60 000 мс (константы в файле, без нового ключа конфига). При срабатывании вызов
не spawning-ит транспорт, а возвращает честный отказ с i18n-строкой
`tool.mcp_circuit_open` (en/ru). Успех сбрасывает счётчик. fail-open-ветка
фиксируется в журнале через существующий `ToolResult` с `success: false`.

### 3. Ограничение `chunk_query`

В `src/tools/chunk-query.ts`:

- новый параметр `max_chunks` (по умолчанию 8); при превышении — отказ с ключом
  `tool.chunk_query_too_many_chunks` и подсказкой увеличить `chunk_chars` или
  сузить входной текст;
- описание тула прямо говорит, что если ответ уже получен `web_fetch`/`web_browse`,
  тул не нужен.

`timeoutMs` не меняется (guard timeout-relations).

### 4. Усечение длинных строк в `grep`

В `src/tools/grep-tool.ts` функция `truncateLines()` дополняется усечением каждой
строки до `MAX_PREVIEW_LINE_CHARS = 300` с пометкой `[line truncated]`, перед
учётом `MAX_PREVIEW_LINES`. Одна строка JSON-LD больше не съедает 4,5k токенов.

### 5. Суженная схема тулов для веб-вопросов

Новый тег `web` в `KNOWN_TOOL_TAGS`. Базовые веб-тулы (`web_search`, `web_fetch`,
`web_browse`, `download_file`) получают `tags: ["web", "research"]`. Тяжёлые
(`mcp_call`, `chunk_query`, `scan_corpus`, `search-history`) остаются только под
`research`. `inferExtraToolTags()` для веб-намерения добавляет `web`, а не
`research`; `research` добавляется только при явном признаке работы с большим
текстом/MCP/историей сессий. `enableOnDemand` и `defaultTags` не меняются.

### 6. Метрика напрасных вызовов

Расширяется существующее поле `progress` в `llm_usage` (session.jsonl) и в
типе `LlmUsageLogInfo`: добавляется необязательное поле `wastefulToolCalls`.
Источник — новый счётчик в `LoopState`, инкрементируемый в `recordBatchProgress()`
при дублирующем пакете и в `recordRepeatedToolFailure()` при неудаче тула.
Старые читателиигнорируют поле; обратной совместимости формат не нарушает.

## Инварианты

- INV-3/4: тулы не импортируют `core/agent/*`; circuit breaker живёт в `src/tools/`.
- INV-9/10: enforcement остаётся в `ToolExecutor.execute()`.
- INV-13/14/15: отказ circuit breaker — через `ToolResult` с причиной, без прямого
  `console.*`.
- Правило 5 AGENTS: каждое новое правило получает гейт в `tests/` / `tests/arch/`.
- CHANGELOG не трогается (правило 10).

## Проверка

- `bun test` и `bun run quality` зелёные.
- Тесты, которые падали бы без правки: early-exit-фраза, circuit breaker,
  `max_chunks`, усечение длинной строки, `web`-тег, `wastefulToolCalls`.
