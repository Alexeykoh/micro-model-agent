# Production readiness: что не хватает MMA до полноценного продакшена

Дата: 2026-09-28
Статус: draft
Ветка: `docs/production-readiness-spec`
Источник: gap-анализ `master` @ 2.10.0 vs. отраслевые требования 2026 (MLflow «Building Production-Ready AI Agents in 2026», Alice Labs «Deployment Guide 2026», Arthur checklist, OWASP LLM01/AST10, EU AI Act, дедлайн high-risk 02.08.2026).

## 1. Проблема и цель

MMA v2.10.0 — зрелый **single-user dev-харнесс** (петля, MoE, critic, stuck-detector, audit, `mma web`, cert-харнесс, quality-gate), но не production-сервис. По определению Alice Labs агент production-ready только при 6 условиях: durable state, trace-observability, архитектурные guardrails, HITL-gates, cost caps upstream, rollback одним артефактом. В MMA нет ни одного из шести в полном виде.

**Цель спеки:** зафиксировать 10 разрывов, для каждого — текущее состояние в коде, целевое решение, non-goals, затронутые файлы, критерии приёмки. Реализация — отдельными ветками по фазам (P0 → P1 → P2), эта спека не меняет код.

## 2. Non-goals

- Не переписывать петлю/MoE/critic — только добавлять недостающие слои.
- Не вводить обязательную внешнюю инфраструктуру (Postgres/Redis/sandbox) как требование для локального dev-режима — production-слои опциональны, включаются конфигом.
- Не давать юридических заключений по EU AI Act — только инженерный скоуп (логи, oversight-UI, resilience).
- Не менять UX-стиль (`docs/design/ui/STYLE.md`) и i18n-контракт (en+ru для всего пользовательского).

## 3. Блок 1 (P0): изоляция исполнения

**Сейчас:** `bash` и файловые тулы исполняются напрямую на хосте (`execa`, `src/tools/bash.ts`, `src/modules/security/command-validator.ts` — фильтр, не граница; `path-validator.ts`, `network-validator.ts`, `protected-paths.ts` — точечные запреты). Успешный prompt-injection = RCE. «Sandbox» в коде — только temp-папки cert-раннера (`src/modules/certification/runner.ts`), не изоляция.

**Решение:**
1. Профиль исполнения `execution.profile: "local-trusted" | "sandbox"` (default `local-trusted`, поведение не меняется).
2. `sandbox`-профиль: запуск bash/file-тулов в контейнере (Docker как минимум; Firecracker/gVisor — позже), deny-by-default egress через `network-validator`, монтирование только `baseDir`.
3. Документировать угрозу в `docs/agents/security.md` + предупреждение в чат при untrusted-входе без sandbox.

**Затронутые файлы (ожидаемо):** `src/tools/bash.ts`, `src/tools/executor.ts`, `src/modules/security/*`, `src/config/registry-extra.ts`, `docs/agents/*`.

**Приёмка:** в `sandbox`-профиле `rm -rf /`, запись вне `baseDir`, egress к запрещённому хосту структурно невозможны (тесты как cert-сценарии); в `local-trusted` поведение 1:1 со старым.

## 4. Блок 2 (P0): durable state

**Сейчас:** состояние — `session.jsonl` на диске (`src/core/session-logger.ts`, `src/modules/session/`). Рестарт/краш посреди хода = потеря in-flight; resume — только истории, не точки прерывания. Ретеншн — только `rotateOldSessions` (30 дней).

**Решение:**
1. Опциональный durable checkpointer (Postgres-совместимый; интерфейс, не драйвер в core): сериализация полного состояния графа после каждого узла, resume с точки останова.
2. `thread_id` — стабильный бизнес-ID (<255 символов), не сырой текст.
3. Ночной prune завершённых чекпоинтов по retention-окну (конфиг, default выкл. для локального режима).
4. Long-term store (user facts/preferences) отдельно от per-thread checkpointer'а, с TTL.

**Затронутые файлы:** `src/modules/session/*`, `src/core/agent.ts`, `src/config/*`.

**Приёмка:** kill -9 посреди хода → рестарт → продолжение с последнего узла без повтора мутаций; MemorySaver-аналог (in-process) помечен non-production.

## 5. Блок 3 (P0): observability (OTel)

**Сейчас:** `session.jsonl`, `context.diff` (`--context-log`), cost-tracker, `session show`. Нет OTel-спанов, нет внешнего бэкенда, нет drift-метрик.

**Решение:**
1. OTel GenAI-семантика (v1.41): спаны `agent/workflow/tool/model` + latency/tokens на хоп, adapter-слой поверх `gen_ai.*` (имена Development, могут меняться).
2. Экспортёр настраиваемый (OTLP endpoint; бэкенды LangSmith/Phoenix/Langfuse — на стороне пользователя, не вендорим).
3. Метрики: faithfulness/completeness/sufficiency hooks, drift vs. baseline на запуске, счётчики guardrail-bypass/PII-leak.
4. Связка trace ↔ session ↔ cost ↔ approvals по одному run-id.

**Затронутые файлы:** `src/core/agent/*`, `src/llm/*`, `src/tools/executor.ts`, новый `src/modules/observability/`.

**Приёмка:** прогон открывает иерархический трейс (какие тулы рассмотрены/вызваны, с какими аргументами, сколько токенов/мс на хоп); смена имени OTel-атрибута = правка одного адаптера.

## 6. Блок 4 (P0): evaluations в контуре + staged rollout

**Сейчас:** cert-сценарии проверяют harness, не качество продукта; нет LLM-as-judge, нет порога, блокирующего CI; релиз = прямой `npm publish`.

**Решение:**
1. Eval-набор (ordinary/difficult/known-failures) с trajectory-оценкой (порядок и число tool-вызовов, не только финальный ответ); судья — ensemble + периодическая калибровка по human-gold.
2. `eval-gate` в CI: падающий offline-eval блокирует merge (как unit-тест).
3. Стадии rollout: shadow (дубль трафика, 24–48ч) → canary 1–5% (soak часы, не минуты) → percentage → full; авторолбэк при дрейфе >2σ от 7-дневной базы.
4. Четырёхметричный скоркард: task success, cost/resolved-case, p95 latency, safety-violations/10K.

**Затронутые файлы:** `certification/*`, `tests/`, `.gitea/workflows/*`, новый `src/modules/eval/`.

**Приёмка:** PR, роняющий eval-score ниже порога, не мержится; регресс ответа «тот же текст, но 10 вызовов вместо 3» ловится trajectory-оценкой.

## 7. Блок 5 (P1): cost/LLM-gateway

**Сейчас:** `CostTracker`, `mma usage` (только OpenRouter), подсчёт cached/cached-write. Нет enforcement: per-run бюджетов, жёсткого `max_turns`-стопа, per-tenant caps, routing'а.

**Решение:**
1. Gateway-слой (внутренний middleware, внешний LiteLLM-совместимый — позже): per-run token budget, `max_turns` hard-stop, per-tenant дневные лимиты с `BudgetExceeded` до вызова модели.
2. Intent-routing: разведка → малая модель, работа → средняя, план/критика → старшая (конфиг-таблица, default single-model = текущее поведение).
3. Cache-anchoring системного промпта + tool-схем (где провайдер поддерживает), метрика cost/resolved-case в `session show`.

**Затронутые файлы:** `src/llm/*`, `src/modules/providers/*`, `src/core/agent.ts`, `src/config/*`.

**Приёмка:** runaway-ран останавливается бюджетом/turn-капом до вызова модели; немодифицированный baseline-конфиг ведёт себя как раньше.

## 8. Блок 6 (P1): MCP/plugin supply-chain

**Сейчас:** MCP-клиент есть (`src/modules/mcp/`, `src/tools/mcp-call.ts`), но без OAuth 2.1 per-user, без централизованного gateway (allowlist/rate-limit/логирование в одной точке), без signed skill-манифестов/SBOM.

**Решение:**
1. MCP-gateway: терминация OAuth 2.1, per-user attribution каждого вызова, per-tenant tool-allowlist (deny by default), rate-limit, единый audit-лог.
2. Подпись skill-манифестов + проверка цепочки поставок плагинов; неподписанное = явный consent/deny.
3. Миграция на актуальный MCP-спек (stateless core, Tasks, authorization hardening).

**Затронутые файлы:** `src/modules/mcp/*`, `src/modules/plugins/*`, `src/modules/skills/*`, `src/modules/security/*`.

**Приёмка:** вызов вне allowlist структурно невозможен (тест как cert); аудит показывает *чей* агент сделал *какой* tool-call.

## 9. Блок 7 (P1): HITL + kill-switch

**Сейчас:** `question`/`approve` — интерактив живого процесса (терминал/web), без durability: рестарт = потеря ожидания; нет эскалации в Slack/Jira, нет панели супервизора, нет глобального kill-switch.

**Решение:**
1. Durable `interrupt()`: пауза графа с персистом, resume с точки прерывания; TTL ожидания + эскалация.
2. Confidence-based escalation: порог impact/confidence → auto vs. approval (суммы, PII, внешние comms, деструктивные действия).
3. Панель oversight (web): review/override/halt в полёте (задел под EU AI Act Art.14).
4. Глобальный kill-switch + rate-limit на агента (конфиг + API).

**Затронутые файлы:** `src/tools/user-input.ts`, `src/core/agent/*`, `src/modules/webui/*`, `src/config/*`.

**Приёмка:** approval переживает рестарт процесса; halt останавливает in-flight мутации; rubber-stamping фиксируется (кто/когда approve).

## 10. Блок 8 (P1): поставка и эксплуатация

**Сейчас:** нет `Dockerfile`/K8s/systemd, нет `/healthz`, релиз = `npm publish` + тег; auth — один токен (non-loopback); нет multi-user/RBAC/тенантов; нет SLO/runbook.

**Решение:**
1. `Dockerfile` + пример compose/K8s, `/healthz` (liveness/readiness), graceful shutdown.
2. Версионированный манифест артефакта (prompt-hash + model-id + tool-schema-hash + eval-thresholds); деплой = продвижение манифеста, откат = одна команда.
3. Multi-user задел: RBAC-роли, per-tenant изоляция состояния и бюджетов (поверх блоков 2/5).
4. SLO: success ≥92% (customer-facing)/≥85% (exploratory), p95 latency, cost/case; runbook на 6 классов (injection, tool-loop, budget, provider-outage, checkpointer-corruption, bypass) с canned-mitigations.

**Затронутые файлы:** корень репо (Dockerfile/compose), `src/modules/webui/server.ts`, `src/cli/*`, `docs/agents/*`.

**Приёмка:** `docker build/run → /healthz 200`; откат на предыдущий манифест одной командой; немонотенантский локальный режим без изменений.

## 11. Блок 9 (P2): compliance (EU AI Act)

**Сейчас:** логи редактируемые без подписи, нет risk file/lineage/adversarial-лога как артефактов.

**Решение (инженерный скоуп, не юрконсультация):**
1. Tamper-evident audit-лог (append-only + подпись, retention ≥6 мес.).
2. Артефакты high-risk деплоя: risk file (Art.9), dataset lineage (Art.10), human-oversight панель (Art.14, поверх блока 7), adversarial-resilience лог (Art.15, покрывает MCP/tools/third-party APIs).
3. Граница compliance: каждый агент в цепочке, выполняющий high-risk функцию, — внутри периметра (наследования compliance нет).

**Затронутые файлы:** `src/modules/security/audit-log.ts`, `src/modules/session/*`, `docs/*`.

**Приёмка:** подмена строки в audit-логе детектируется проверкой подписи; high-risk деплой без 4 артефактов помечается non-compliant.

## 12. Блок 10 (P2): внутренние хвосты

1. `docs/mma-features-overview.md` зафиксирован на 2.6.0 при 2.10.0 — обновить или пометить superseded каноном AGENTS.md.
2. 5 файлов >>300 строк (agent 1582, repl 1450, line-editor 1162, stuck-detector 927, execution/module 866) — Plan-ступени только по чистым швам, иначе не трогать (исключения уже в AGENTS.md).
3. Linux watcher не рекурсивен (`walker.ts:140`) — чинить только если Linux в целевых платформах.
4. `noExplicitAny` warn (186) → error ratchet'ом; русские комменты (81 файл) — по слоям core→cli; coverage-threshold в CI.

## 13. Фазы

- **P0 (безопасность/надёжность):** блоки 1–4. Без sandbox + durable state + OTel + eval-gate в прод нельзя.
- **P1 (управляемость):** блоки 5–8. Gateway, MCP-gateway, durable HITL, Docker/манифест/SLO.
- **P2 (зрелость):** блоки 9–10. Compliance-пакет, хвосты.

Каждый блок — отдельная ветка `feat/`/`fix/`/`docs/` от актуального `master`, зелёные `bun test` + `tsc --noEmit`, запись в CHANGELOG по релизу.

## 14. Источники

- MLflow «Building Production-Ready AI Agents in 2026» (28.05.2026) — архитектура, governance, eval-probes, skill-boundary security.
- Alice Labs «Production AI Agents Deployment Guide 2026» (03.08/16.09.2026) — six-layer stack, checkpointers, OTel GenAI v1.41, cost 50×/экономия 70–85%, 5-layer injection defense, HITL 9–26%, Firecracker vs gVisor, shadow/canary, MCP OAuth 2.1 + NSA 06.2026, trajectory-evals, EU AI Act 02.08.2026.
- Arthur «Checklist to Launch a Production-Ready Agent» (06.05.2026) — traces/evals/guardrails/governance.
- Splunk/Cisco Agent Observability, AWS CloudWatch Omni (09.2026) — eval→guardrail, unified traces.
