# Failover по 403 и передача HTTP-статуса из провайдера (design)

**Дата:** 2026-10-27 · **Ветка:** `fix/provider-failover` · **Статус:** принято

## Проблема

Долг `llm-provider-error-invisible-to-user` писался по живой сессии `ses_mvoac9q9`:
два хода умерли на `403 RegionError` («This model is not available in your
country»), пользователь трижды вручную отправлял одну фразу, `provider.json` без
`fallback` — переключения не было.

Разбор кода уточнил картину:

1. **Видимость уже есть.** CLI печатает `result.error` красной строкой
   (`src/cli/repl.ts:854-855`), веб получает `turn_end` с `success:false` и
   рисует ошибку (`webui/assets/app.ts:337`), в `session.jsonl` пишется событие
   `error` (`loop-llm-errors.ts`). Не хватало **не строки**, а переключения:
   без него ход просто умирает, и пользователь повторяет запрос руками.
2. **Failover по HTTP-статусу сломан.** `FallbackProvider` переключается по
   `LlmError.llmStatus` (`providers/fallback.ts:isFailoverError`), но статус
   выставляется только в `fetchWithRetry` для ретраибельных 429/5xx. Для
   остальных ответов `streamOnce` бросает `LlmError` **без** `llmStatus`
   (`openai-compat.ts`), а `doNonStreaming` — вообще голый `Error`. То есть
   `404`/`403`/`400` до политики failover не доходят.
3. **403 не считается переключаемым.** Для активного провайдера это
   детерминированный отказ модели (регион/лицензия) — второй провайдер того же
   пользователя может работать.

## Решение

### 1. Статус всегда доезжает до ошибки (`src/llm/openai-compat.ts`)

- `streamOnce`: `!response.ok` → `LlmError(..., { terminal: true, llmStatus: response.status })`
  (плюс прежняя классификация `context_length`).
- `doNonStreaming`: `!response.ok` → `LlmError` с `llmStatus` вместо `Error`
  (failover работает и на non-stream-фолбэке).

Иначе `isFailoverError` не может принять решение — это и был скрытый дефект.

### 2. 403 — переключаемая ошибка (`src/modules/providers/fallback.ts`)

Критерий: `404` (модели нет) · `403` (регион/лицензия модели) · `429` · `5xx` ·
сетевые `errno`. **Не** переключаем `400/401/422` — это ошибка запроса/ключа,
смена провайдера её не лечит и маскирует настоящую причину.

### 3. Видимость переключения

Отдельного события не добавляем: переключение и так видно в журнале — следующий
`llm_usage` приходит с другим `provider`/`model`, а `FailoverListener`
(`providers/factory.ts`) пишет `provider failover: a -> b` в app-лог. Строку в чат
**не** добавляем: STYLE.md — quiet by default, ход продолжается.

Если переключиться некуда (`listNames().length <= 1`), `FallbackProvider` не
вмешивается: ошибка доходит до петли и видна как `result.error` (CLI — красная
строка, веб — `turn_end.success=false`, `session.jsonl` — событие `error`).

## Тесты

1. `tests/openai-compat.test.ts` — HTTP 403 (стрим) и 403 (non-stream) дают
   `LlmError.llmStatus === 403`.
2. `tests/providers/fallback-model.test.ts` — 403 переключает на следующую
   запись; 401/400 — нет; после `end` провайдер остаётся sticky.

## Вне скоупа

- Failover по содержимому ошибки (regex «not available in your country») — статуса
  достаточно, эвристики по тексту ломаются на локализациях.
- Дефолтное включение `provider.fallback` — это продуктовое решение: в конфиге
  пользователя провайдер один, переключать некуда. Долг закрывается тем, что при
  настроенном `fallback` 403 действительно переключает.
