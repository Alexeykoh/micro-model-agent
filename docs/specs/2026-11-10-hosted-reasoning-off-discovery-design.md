# Спека: эмпирическое обнаружение выключателя reasoning у хостед-эндпоинтов

Дата: 2026-11-10 · Ветка: `fix/provider-context-reasoning` · Долг: `hosted-reasoning-discovery` (debt.md)

## Проблема

Декларативного выключателя reasoning у хостед-эндпоинтов нет: LM Studio отдаёт
`capabilities.reasoning.allowed_options: ["off","on"]`, llama.cpp — `/props`,
а OpenCode Zen/Go, OpenRouter и прочие OpenAI-совместимые шлюзы в `/models`
сообщают только `capabilities.reasoning: {supported: true, effort: [...]}` —
без признака «принимает `none`». Из-за этого `reasoningOff` неизвестен,
`normalizeReasoningEffort` не шлёт `"none"`, и thinking-модель жжёт маленькие
бюджеты (симптом из долга: именование сессии → truncation → `null`).

Проверено вживую 2026-11-10 на `opencode-go` (deepseek-v4.1-flash):
`POST /chat/completions {reasoning_effort:"none"}` → **200**; мусорное значение —
тоже 200 (шлюз ленient). Строгие OpenAI-совместимые серверы на неизвестный
`reasoning_effort` отвечают 400 — поэтому «послать none всем» нельзя, нужно
детектировать (долг: «послать none, 400 → strict»).

## Решение

Два источника, оба в синхронной discovery-фазе (до сборки провайдера —
`reasoningOff` запекается в экземпляр):

1. **Декларативные уровни** (`/models`): `capabilities.reasoning.supported === true`
   → `reasoningStrategy: "openai-effort"`; `effort: string[]` → `reasoningLevels`
   (INV-R7: показываем и шлём только объявленное). Без сетевых LLM-вызовов.
2. **Эмпирический выключатель** (только если стратегия — `openai-effort` и
   `reasoningOff` неизвестен): один минимальный `POST /chat/completions` с
   `reasoning_effort: "none"`, `max_tokens: 8`:
   - `200` → `reasoningOff: true`;
   - `400/422` **про сам параметр** (`reasoning`/`effort`/`param`/`unsupported`/
     `unknown`/…) → `reasoningOff: false` (строгий эндпоинт);
   - прочее (5xx/401/404/429/сеть/таймаут) и **несвязанный 400** → `null` =
     «не знаем», кэш не пишем, поведение не меняется (пресет). Несвязанный 400
     — живой случай opencode-go: «This Go model trains on request data» и
     «MissingSessionID»; ложный `false` там запретил бы `"none"` на сутки.
   - Кэш: память + диск `~/.mma/reasoning-off-cache.json`
     (`MMA_REASONING_OFF_CACHE` для тестов), TTL 24ч (true) / 1ч (false) —
     как у reasoning-пробы. Ключ `baseUrl|model`.

Известное значение меняет только то, что уже подтверждено: `true` — выключатель
существует, `false` — шлюз строгий (ни `"none"`, ни произвольные уровни вне
объявленных). `null` — пресет.

### Политика (чтобы не «слать none всем»)

- Проба гоняется только при `reasoningOff === undefined` у активной записи и
  резолвнутой стратегии `openai-effort` (prompt-tag/template-kwarg выключаются
  своим механизмом — их проба не касается).
- Только при `config.reasoning.mode !== "none"` (иначе reasoning и так выключен).
- Один раз на идентичность: результат кэшируется, повторные свитчи/старты —
  без сети.
- Fail-open: сбой пробы не блокирует ни старт, ни свитч (INV-15: диагностика,
  значение остаётся `undefined`).

### Куда встраивается

- `probeOpenAICompatCapabilities` (`src/llm/native-context.ts`) — декларативные
  уровни; `probeNativeCapabilities` мержит их с LM Studio/llama.cpp.
- `probeReasoningOffSwitch` (`src/llm/reasoning-off-probe.ts`) — эмпирика + кэш.
- `discoverCapabilities` (`src/core/agent/provider-probes.ts`) — композиция;
  вызывается из bootstrap-фазы провайдера и из `refreshCapabilitiesProbe`
  (смена идентичности). Провайдер собирается с уже известным `reasoningOff`.
- Существующая `probeReasoningSupport` (два ординала) остаётся валидацией
  механизма: при `reasoningOff: true` она проверяет, что «none» реально
  выключает рассуждение, а «high» — включает.

### Контракты, которые НЕ меняются

- Wire-формат (`buildRequestBody`/`normalizeReasoningEffort`) — без изменений:
  проба отправляет ровно ту форму, которой харнесс выражает off.
- `capabilitiesRef`/`ProviderProbesBox` — те же поля; `reasoningOff` уже был в
  `ModelCapabilities`.
- Локальные бэкенды (LM Studio/llama.cpp) по-прежнему узнают off нативно;
  эмпирика их не продвигается вперёд истины.

## Проверки (правило 5)

- `tests/llm/reasoning-off-probe.test.ts` — 200→true, 400→false, 500/401→null,
  кэш (второй вызов без сети), заголовок `x-opencode-session` для Zen/Go.
- `tests/llm/provider-context-probe.test.ts` — декларативные уровни из
  `/models`-capabilities.
- `tests/core/provider-switch-probes.test.ts` — хостед-заглушка отвечает 200 на
  off-пробу → `capabilitiesProbeRef.probe.reasoningOff === true` и экземпляр
  провайдера получает его; строгая заглушка (400) → `false`.
- Существующие гварды INV-R2/R7 и набора reasoning — регрессия.
