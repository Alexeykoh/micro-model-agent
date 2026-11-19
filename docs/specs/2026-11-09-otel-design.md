# Спека: Observability OTel (P0, 1/2 — адаптер+экспорт)

Дата: 2026-11-09. Ветка: `feat/otel-observability` (ветка 1/2:
адаптер `gen_ai.*` + OTLP-экспорт + метрики; W5/W6-сигналы и
faithfulness-судья — 2/2).
Источник: `TODO.md §3 P0 Observability`,
[`2026-09-28-production-readiness`](../archive/specs/2026/2026-09-28-production-readiness-design.md) §5.

## Что неправильно

Наблюдаемость существует (session.jsonl, diagnostic-каталог, CostTracker),
но уйти в трейсы не может: нет Span-адаптера, нет OTLP-экспортёра, метрик
faithfulness/drift/bypass нет, trace↔session↔cost↔approvals не связан конвенцией.

## Контракт

1. **Конфиг:** `otel.enabled` (false), `otel.endpoint` ("") — OTLP/HTTP
   endpoint (`/v1/traces`), `otel.serviceName` ("mma").
   При `enabled:false` адаптер — no-op поверх существующего позвоночника
   (без fetch, без спавнов).
2. **Адаптер** `src/modules/otel/`:
   - `OtelAdapter`: `startSpan(name, attrs)` → `ended({status, attrs})`,
     `incMetric(name, value, labels)` (в памяти, flush каждые 30с или
     по размеру батча), `setThread(threadId, sessionId)`.
   - Семантика OTel GenAI (имена — Development, смена = правка адаптера):
     * `agent.run` (workflow) — атрибуты `gen_ai.system = "mma"`,
       `mma.thread_id`, `mma.session_id`, `gen_ai.agent.name`.
     * `llm.chat` (model) — `gen_ai.provider.name`, `gen_ai.request.model`,
       `gen_ai.usage.input_tokens`/`output_tokens`, `gen_ai.usage.cache_*`
       (если есть), статус/ошибка.
     * `tool.call` (tool) — `gen_ai.tool.name`, `gen_ai.tool.call.*`,
       `success`, длительность.
   - Все имена атрибутов — в одном адаптер-модуле (константы), не размазаны.
3. **OTLP-экспортёр:** JSON POST на `POST {endpoint}/v1/traces`
   (`resourceSpans`, ресурс `service.name`), fail-silent (нет сети —
   диагностика, не падение хода), timeout 5с, без retry-шторма.
4. **Метрики:** счётчики `tool.execute{success|failed}`,
   `llm.chats`, `executor.denied` (bypass-контр-прецедент: denied
  ToolExecutor), `checkpoint.received`? Нет — только то, что реально
   эмитится: faithfulness/drift-хуки приходят с judge (волна 2/2),
   здесь — их слоты контракта фиксируются в адаптере.
5. **Связка:** `threadId` (из durable 1) + `sessionId` резолвятся в адаптер
   при создании; каждый span несёт их атрибутами автоматически.
6. **Wire (минимум, без двойных проводов):**
   - `agent.run` span — вокруг `executeAgentLoop` (loop-run);
   - `llm.chat` — декоратор `OtelProvider` поверх провайдера в `buildActiveProvider`;
   - `tool.call` — декоратор вокруг `ToolExecutor.execute`.
   Декораторы — тонкие обёртки, поведение/ошибки те же (stat passthrough).

## Приёмка

- Тест: реквизиты spans (`gen_ai.request.model`, tokens) на fake провайдере;
  `enabled:false` — ноль вызовов fetch (spy на exporter).
- Тест: denied/failed tool даёт span со `success=false`.
- Live-проверка провайдера: сбор тестов `tests/arch/` + `tests/modules/otel/`.
- LangSmith/Phoenix/Langfuse — на стороне пользователя (endpoint), не вендорим.
