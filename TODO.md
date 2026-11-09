# TODO — Micro Models Agent

> **Актуально на 2026-11-09** (сверено с кодом; `dev`).
>
> Здесь только **открытая** работа. Закрытые пункты с обоснованиями и ссылками на
> гейты сохранены снимками в [`docs/archive/`](./docs/archive/) — последний
> полный снимок [`todo-2026-11-04.md`](./docs/archive/todo-2026-11-04.md);
> архивы закрытых 1.1–1.14 (вкл. webui-UX 1.13 и harness 1.14, закрыты 2026-11-09)
> — в git-истории TODO.md и по спеке
> [`2026-11-06-webui-pause-resume`](./docs/specs/2026-11-06-webui-pause-resume-design.md) /
> [`2026-11-08-agent-harness`](./docs/specs/2026-11-08-agent-harness-design.md) /
> [`2026-11-09-nested-agents-md`](./docs/specs/2026-11-09-nested-agents-md-design.md).
> Долгосрочная история — `CHANGELOG.md` и [`docs/agents/feature-history.md`](./docs/agents/feature-history.md).
> Отложенные решения — [`docs/agents/debt.md`](./docs/agents/debt.md) (правило 9, pay-once).
>
> **Проверка 2026-11-09:** все пункты ниже сверены с кодом. Частично сделанное
> отмечено (`уже есть: … / осталось: …`), чтобы не делать дважды.

---

## 1. Открыто сейчас

> Ранее 1.1–1.4, 1.6 (Learning Phase B — удалена решением пользователя 2026-11-09),
> 1.7–1.11, 1.12 (mma web хвосты), 1.13 (mma web UX), 1.14 (harness) — закрыты и
> убраны в архив 2026-11-09. Нумерация `§1.5` сохранена, чтобы не ломать ссылки
> вида `TODO §1.12` в коде/спеках/тестах (старые ссылки ищите в архиве).

### 1.5 Мелкие хвосты исполненных планов

- [ ] Режим компакции `llm`: `contextBudget.compactionSummary` допускает только
      `off|ledger` (`src/config/registry-extra-provider.ts:35`,
      `src/config/types-budget.ts:50`). Файл
      `src/core/compaction-summary.ts` **есть и используется** в `ledger`-режиме
      (`src/core/session-log-telemetry.ts:9`) — не хватает именно LLM-режима
      (сводка моделью) и его проводки в конфиг.
      ⚠️ **Застряло:** план LLM-суммаризации описан ещё в
      [`2026-10-06-harness-reliability-fixes`](./docs/plans/2026-10-06-harness-reliability-fixes.md)
      (`off|ledger|llm`, кэш по hash), но не реализован за месяц. Нужна отдельная
      ветка по правилу 3, а не «попутно».
- [ ] Живая приёмка леджера контекста: повторный прогон `hard-multi-extreme` с acceptance
      «`NEEDLE_A_111`/`B_222`/`C_333`, decoy 0, `exit=0`, notes-файл с `path:line`, блок
      с `[Notes:`» (план [`2026-10-14-context-ledger`](./docs/archive/plans/2026/2026-10-14-context-ledger.md), Task 6).
      ⚠️ **Ручная задача, не код:** нечего проверить в репозитории, нужен живой прогон;
      без него пункт не закроется.

---

## 3. Дорожная карта до продакшена

> Полный gap-анализ: [`docs/archive/specs/2026/2026-09-28-production-readiness-design.md`](./docs/archive/specs/2026/2026-09-28-production-readiness-design.md).
> Пункты — отдельные ветки от `dev`; каждый требует зелёных `bun test` + `bun run quality`.
> `master` не коммитим/не пушим (ветка релиза).

### P0 — без этого в прод нельзя

- [ ] **Изоляция исполнения.** Enforcement уже в одной точке (`ToolExecutor.execute()`):
      allowlist, protected-пути, SSRF, теги, rate-limit; `bash` — `manual` + jail.
      **Уже есть:** jail/workdir-scope, write-allowlist, symlink/device-escape.
      **Осталось:** профиль исполнения `local-trusted | sandbox` (Docker: deny-by-default
      egress, `--read-only`, лимиты, фиксированный образ), файловые тулы под jail,
      egress-правила для web-тулов, cert-сценарии приёмки.
      При `sandbox` и недоступном Docker ход **падает**, а не деградирует.
      ⚠️ **Изменилось:** в репо нет ни `Dockerfile`, ни упоминаний `sandbox`-профиля в
      конфиге — пункт целиком открыт, «частично» его не делает enforcement.
- [ ] **Durable state.**
      **Уже есть:** `session.jsonl` + ротация/prune (`tests/session/rotate-and-prune.test.ts`,
      auto-prune порог 1000 сессий, архив >30 дней), service-retention
      (`service.resultRetentionDays`, `tests/service/retention.test.ts`).
      **Осталось:** опциональный checkpointer, стабильный `thread_id` <255,
      long-term store с TTL. Краш посреди хода по-прежнему теряет текущую итерацию.
- [ ] **Observability (OTel).**
      **Уже есть:** `session.jsonl`/`app.jsonl`, `context.diff`, `CostTracker`,
      честные `health()` у 6 модулей (`tests/arch/health-coverage.test.ts`),
      W0–W4 наблюдаемость (`docs/specs/2026-11-05-observability-gaps-design.md`).
      **Осталось:** GenAI-спаны (`gen_ai.*` v1.41), OTLP-экспорт, метрики
      faithfulness/drift/bypass, связка trace↔session↔cost↔approvals.
      ⚠️ **Изменилось:** OTel встречается только в `docs/ideas/*` и gap-спеке —
      кода спаанов/OTLP в `src/` нет. Остаток W5/W6 вынесен в долг
      `observability-w5-w6`, а не в этот пункт.
- [ ] **Evals в контуре + staged rollout.**
      **Уже есть:** сертификация моделей (`src/modules/certification/`,
      сценарные факт-чеки, `mma model certify`), реплей-инварианты в CI
      (`.github/workflows/quality.yml`: `bun test tests/replay`).
      **Осталось:** eval-набор с trajectory-оценкой, ensemble-судья + human-gold,
      eval-gate в CI (сейчас в `quality.yml` только typecheck/lint/test/fallow —
      нет ни eval-гейта, ни coverage-threshold), shadow→canary→percentage→full,
      скоркард (success/cost/p95/safety).
      ⚠️ Сертификация ≠ evals в контуре: это разовые прогоны на песочнице, а не
      гейт на каждое изменение.

### P1 — управляемость

- [ ] **Cost/LLM-gateway.**
      **Уже есть:** `CostTracker` (+per-provider breakdown), `mma usage` (OpenRouter),
      prompt-cache capability/resolver, prefix-monitor, `iterMaxTokensOverride=16384`.
      **Осталось:** per-run бюджет, `max_turns` hard-stop, per-tenant caps до вызова
      модели, intent-routing. Cache-anchoring: кэш-метрики есть, стабильного
      префикса как enforcement нет (только диагностика `prefix-monitor`).
- [ ] **MCP/plugin supply-chain.**
      **Уже есть:** allowlist серверов (`mcp.allowedServers`, гвард
      `tests/arch/outbound-policy.test.ts`), DLP-egress на MCP, plugin-permissions как
      декларация.
      **Осталось:** OAuth 2.1 per-user, gateway с rate-limit, signed skill-манифесты/SBOM,
      актуализация спеки MCP. Disable плагина ≠ sandbox (код уже загружен,
      зафиксировано в `AGENTS.md`).
- [ ] **HITL + kill-switch.**
      **Уже есть:** тулы `question`/`approve`, `ApprovalStore` одноразовыми токенами
      (`tests/tools/approve-token.test.ts`), пауза/возобновление в памяти
      (см. 1.13, спека `2026-11-06-webui-pause-resume-design.md` — явно не durable),
      `Host.interrupt()` в памяти.
      **Осталось:** durable `interrupt()`, escalation по impact, oversight-панель,
      глобальный kill-switch (`question`/`approve` не переживают рестарт).
- [ ] **Поставка и эксплуатация.**
      **Уже есть:** `/v1/health` + `/v1/ready` (`src/modules/service/server.ts`,
      без auth для LB/k8s), релиз через GitHub Actions (`.github/workflows/release.yml`),
      silo-модель «1 процесс = 1 тенант» (`tests/service/tenant-authz.test.ts`).
      **Осталось:** Dockerfile/K8s, `/healthz` как имя (сейчас `/v1/health` —
      переименовать или алиас), манифест (prompt+model+tools+evals), откат одной
      командой, RBAC/тенанты сверх silo, SLO + runbook.

### P2 — зрелость

- [ ] **Compliance (EU AI Act).**
      **Уже есть:** `context.diff` append-only, `memory/*.md` append-only,
      `session.jsonl` зашифровывается при `sessionEncryption.enabled`.
      **Осталось:** tamper-evident audit-лог (append-only + подпись), high-risk
      артефакты (risk file, lineage, oversight-панель, adversarial-лог Art.15),
      retention ≥6 мес. (сейчас: архив сессий 30 дней, service 7 дней).
- [ ] **Внутренние хвосты.**
      **Уже есть (частично закрыто):** остаток раздутых файлов — **закрыт**:
      `.arch-allowlist.json` пуст с 2026-11-03, каждый файл ≤300 строк
      (долг `split-bloated-files` оплачен, `tests/arch/file-size.test.ts`).
      **Осталось:** `noExplicitAny` warn (`biome.json:34`) → error ratchet'ом,
      coverage-threshold в CI (в `quality.yml` отсутствует).

---

## 4. Бэклог

- [ ] Подобрать литературу по верификации/критикам (вторая половина пункта
      «контр-агент для проверки работы»; сам контр-агент сделан — `src/modules/critic/`).
      ⚠️ **Изменилось:** `docs/literature.md` существует (2026-08-11), но разделов
      по верификации/критикам в нём нет (только harness-общее:
      Sources / Principles / Gaps / Recommendations) — пункт всё ещё актуален.
- [ ] Долги из [`docs/agents/debt.md`](./docs/agents/debt.md) — каждый оплачивается
      по своему триггеру (правило 9). Активных сейчас ~22 записи (реестр сверялся
      2026-10-20; оплата — только вместе с якорем `DEBT(<id>)` и выполненным
      критерием выхода).

---

## 5. Релиз

- Публикация — **только через GitHub Releases** (npm publish не используется).
- Версии в бете — только `0.x.y` (`1.0.0` запрещён, гвард `tests/version-beta.test.ts`).
- Релиз = обновление `CHANGELOG.md` + `package.json` → тег `vX.Y.Z` → GitHub Actions
  (`.github/workflows/release.yml`, артефакты на 5 платформ).
