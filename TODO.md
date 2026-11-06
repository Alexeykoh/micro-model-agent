# TODO — Micro Models Agent

> **Актуально на 2026-11-04** (`dev` @ 0.24.0).
>
> Здесь только **открытая** работа. Закрытые пункты с обоснованиями и ссылками на
> гейты сохранены снимком в [`docs/archive/todo-2026-11-04.md`](./docs/archive/todo-2026-11-04.md).
> Долгосрочная история — `CHANGELOG.md` и [`docs/agents/feature-history.md`](./docs/agents/feature-history.md).
> Отложенные решения — [`docs/agents/debt.md`](./docs/agents/debt.md) (правило 9, pay-once).

---

## 1. Открыто сейчас

> Разделы 1.1–1.4 и 1.7–1.11 закрыты и перенесены в архивный снимок. Нумерация
> оставшихся разделов сохранена, чтобы не ломать ссылки вида `TODO §1.12` в коде,
> спеках и тестах.

### 1.5 Мелкие хвосты исполненных планов

- [ ] Режим компакции `llm`: `contextBudget.compactionSummary` допускает только
      `off|ledger` (`src/config/registry-extra.ts:182`). Файл
      `src/core/compaction-summary.ts` **есть и используется** в `ledger`-режиме —
      не хватает именно LLM-режима (сводка моделью) и его проводки в конфиг.
- [ ] Живая приёмка леджера контекста: повторный прогон `hard-multi-extreme` с acceptance
      «`NEEDLE_A_111`/`B_222`/`C_333`, decoy 0, `exit=0`, notes-файл с `path:line`, блок
      с `[Notes:`» (план [`2026-10-14-context-ledger`](./docs/archive/plans/2026/2026-10-14-context-ledger.md), Task 6).

### 1.6 Качество памяти и самообучение (план [`docs/plans/2026-08-12-memory-quality-and-learning.md`](./docs/plans/2026-08-12-memory-quality-and-learning.md))

План **в работе**: Phase A (валидатор памяти) и Phase C (языковые адаптеры) закрыты
2026-11-03, Phase B (обучение) открыта.

- [ ] **Фаза 2 — обучение:** `src/modules/learning/**` (`types/trace/validator/generator/cli/module`),
      подкоманда `mma learn`, регистрация `LearningModule` в bootstrap.

### 1.12 mma web — хвосты тестовых прогонов 2026-11-02

Отчёт: [`docs/archive/reports/web-agent-test-report-2026-11-02.md`](./docs/archive/reports/web-agent-test-report-2026-11-02.md).
Остальные находки прогонов (MCP-теги, path-гейт, pre-write LSP, post-build, финальный
typecheck, loopback, `--isolated`, локальные заглушки) закрыты и перенесены в архив.

- [ ] **Вложенный `AGENTS.md` и `.mma/`** — mma не читает `site/AGENTS.md` Next 16, а
      `.mma/` в корне ломает `create-next-app .`. Долг F-01/F-06.

### 1.13 mma web — UX-задачи (добавлено 2026-11-04)

- [ ] **Пауза агента с возобновлением по кнопке** — остановить ход агента и
      продолжить его по нажатию кнопки в интерфейсе.
- [ ] **Сайдбар: компактный набор вкладок** — видимыми оставить вкладки
      «Сессия», «Файлы», «Субагенты»; остальные спрятать за кнопкой со
      «стрелочками вправо»: клик показывает все вкладки, кнопка переворачивается
      «влево», повторный клик скрывает раскрытое.
- [ ] **Вкладка «Файлы»: предпросмотр в основном окне** — перенести просмотр
      файлов из сайдбара в основное окно как вкладку (как в IDE).

---

## 2. Действия пользователя (не задачи для агента)

- [ ] Вернуть `contextWindow 64000` в реальном конфиге (`~/.mma`) — сейчас 32768
      (проверено 2026-10-30): `/config contextWindow 64000`.

---

## 3. Дорожная карта до продакшена

> Полный gap-анализ: [`docs/archive/specs/2026/2026-09-28-production-readiness-design.md`](./docs/archive/specs/2026/2026-09-28-production-readiness-design.md).
> Пункты — отдельные ветки от `master`; каждый требует зелёных `bun test` + `bun run quality`.

### P0 — без этого в прод нельзя

- [ ] **Изоляция исполнения.** Enforcement уже в одной точке (`ToolExecutor.execute()`,
      W2: allowlist, protected-пути, SSRF, теги, rate-limit; `bash` — `manual` + jail).
      **Осталось:** профиль исполнения `local-trusted | sandbox` (Docker: deny-by-default
      egress, `--read-only`, лимиты, фиксированный образ), файловые тулы под jail,
      egress-правила для web-тулов, cert-сценарии приёмки.
      При `sandbox` и недоступном Docker ход **падает**, а не деградирует.
- [ ] **Durable state.** `session.jsonl` не переживает краш посреди хода:
      опциональный checkpointer, стабильный `thread_id` <255, prune по retention,
      long-term store с TTL.
- [ ] **Observability (OTel).** GenAI-спаны (`gen_ai.*` v1.41), OTLP-экспорт,
      метрики faithfulness/drift/bypass, связка trace↔session↔cost↔approvals.
- [ ] **Evals в контуре + staged rollout.** Eval-набор с trajectory-оценкой,
      ensemble-судья + human-gold, eval-gate в CI, shadow→canary→percentage→full,
      скоркард (success/cost/p95/safety).

### P1 — управляемость

- [ ] **Cost/LLM-gateway.** Per-run бюджет, `max_turns` hard-stop, per-tenant caps
      до вызова модели, intent-routing, cache-anchoring промпта.
- [ ] **MCP/plugin supply-chain.** OAuth 2.1 per-user, gateway с allowlist/rate-limit,
      signed skill-манифесты/SBOM, актуализация спеки MCP.
- [ ] **HITL + kill-switch.** Durable `interrupt()`, escalation по impact,
      oversight-панель, глобальный kill-switch (`question`/`approve` не переживают рестарт).
- [ ] **Поставка и эксплуатация.** Dockerfile/`K8s`/`/healthz`, релиз-артефакт,
      манифест (prompt+model+tools+evals), откат одной командой, RBAC/тенанты,
      SLO + runbook.

### P2 — зрелость

- [ ] **Compliance (EU AI Act).** Append-only логи + подпись, high-risk артефакты
      (risk file, lineage, oversight-панель, adversarial-лог Art.15), retention ≥6 мес.
- [ ] **Внутренние хвосты.** `noExplicitAny` warn-ratchet → error; coverage-threshold
      в CI; остаток раздутых файлов (allowlist пуст с 2026-11-03).

---

## 4. Бэклог

- [ ] Подобрать литературу по верификации/критикам (вторая половина пункта
      «контр-агент для проверки работы»; сам контр-агент сделан — `src/modules/critic/`).
- [ ] Долги из [`docs/agents/debt.md`](./docs/agents/debt.md) — каждый оплачивается
      по своему триггеру (правило 9).

---

## 5. Релиз

- Публикация — **только через GitHub Releases** (npm publish не используется).
- Версии в бете — только `0.x.y` (`1.0.0` запрещён, гвард `tests/version-beta.test.ts`).
- Релиз = обновление `CHANGELOG.md` + `package.json` → тег `vX.Y.Z` → GitHub Actions.
