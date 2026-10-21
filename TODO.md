# TODO — Micro Models Agent

> **Актуально на 2026-10-20** (`master` @ 0.9.1).
>
> Этот файл — только **открытая** работа. Закрытые пункты здесь не хранятся:
> история — в `CHANGELOG.md`, `docs/agents/feature-history.md` и коммитах.
> Отложенные решения — единым списком в [`docs/agents/debt.md`](./docs/agents/debt.md)
> (правило 9, pay-once); выполненные планы — в [`docs/plans/`](./docs/plans).

---

## 1. Открыто сейчас

### 1.1 WebUI

- [ ] **Показ действий субагента по клику** — клик по субагенту переключает вид чата
      на ход работы субагента с возможностью вернуться назад. Одновременно может
      работать много субагентов: переключение между ходами + возврат в родительский
      чат без потери состояния.
- [ ] **Trace: поп-ап системного промпта** — кнопка в трассировке открывает поп-ап
      с текущим системным промптом и его составом (из каких блоков/секций он собран).

> Остальные WebUI-пункты (очередь сообщений, кнопки «отправить сейчас»/«отменить»,
> Files-tab, event-sourced состояние, модуляризация) — **закрыты**, см. `CHANGELOG.md`.

### 1.2 Corporate data policy (план `docs/plans/2026-10-19-corporate-data-policy-plan.md`)

- [x] **W1–W4 исполнены** — слиты в `master` 2026-10-19 (`41916e2b`): движок
      `data-policy` + `EgressGuard`, egress к провайдеру (E1), web/serve-фильтр (E2),
      404 на скрытые пути, DLP-вебхук. Гейты: `tests/security/data-policy*.test.ts`,
      `tests/providers/sanitizing-provider.test.ts`, `tests/webui/egress-filter.test.ts`,
      `tests/service/egress-filter.test.ts`.
- [ ] **Остаточные векторы вне плана** (отдельная задача, нужен шов/спека):
      payload `tools/web-search.ts:66` (запрос уходит в DuckDuckGo как есть),
      payload `modules/mcp/client.ts`, обход через base64/split известного значения,
      DNS-подмена trust (документировать IP/CIDR), NER (ФИО/адреса).
      Долги по теме — в `docs/agents/debt.md` (`at-rest-pii`, `file-content-taint`,
      `api-hidden-globs-text-scope`, `file-content-bypass-non-path-tools`,
      `data-policy-projection-lifecycle`, `streaming-tail-holdback`,
      `research-by-checksum`, `dlp-cli-redaction-notice`).

### 1.3 Аудит модулей harness (план `docs/plans/2026-10-12-harness-module-audit-fixes.md`)

Исполнен частично — волны architecture-v2 закрыли часть находок, но сам план в `master`
не слит. Открытые пункты (список с обоснованием — в шапке плана):

- [ ] **W3 — безопасность путей и вывода:** ~~`validateWorkdir`~~ (сделано 2026-10-21:
      workdir-jail в `bash`) · ~~ADS/регистр/TOCTOU в `matchProtectedPath`~~ (ADS и
      регистр — сделано; TOCTOU-двойная проверка `escapesViaSymlink` — осталась) ·
      ~~allowlist записи в `delete-file`/`move-file`/`create-dir`~~ (сделано) ·
      ~~`glob-tool.ts` не фильтрует по scope/protected~~ (сделано) ·
      ~~`processRegistry.get(id)` без `sessionId`~~ (сделано) ·
      ~~нет `src/ui/sanitize-output.ts`~~ (сделано) ·
      ~~нет `certutil`/`bitsadmin`/`takeown`/`wscript`/`shred` в
      `security-policies.ts`~~ (сделано: единый `security-lists.ts`) ·
      маркера `[APPROVED]` нет — `DEBT(approve-marker-not-authoritative)`.
- [ ] **W6 — web-сервис:** security-заголовки на статику (`X-Frame-Options` и пр.);
      кэпы тела по маршруту; SVG; LRU/GC пула; инкрементальные логи; таймеры фронта;
      видимость ошибок slash-команд; XSS-guard-тесты; гонка активной сессии.
- [ ] **W7 — конфиг:** атомарная запись (`src/config/config.ts:366` — обычный `writeFileSync`);
      `/config reset`; не-деструктивная миграция; busy-гейт веб-настроек; ротация/prune сессий.
- [x] **W4 — web-тулы:** сделано 2026-10-21 — `web_search` проверяет HTTP-статус,
      добавлены `web-errors.ts` (единый формат ошибок) и `web-content.ts`
      (фрейминг недоверенного контента), `web_browse` проверяет статус и
      сохраняет структуру строк, SSRF-политика (в т.ч. DNS-резолв) в браузере и
      `attach_image`, детект JS-шелла, предполёт Chromium, скиллы,
      `max_tokens` субагента.
- [ ] **W1/W2 — петля:** директивы, переживающие компакцию; `stopReason="duplicate"`;
      привязка evidence к ходу; `overcommitted`; `imageTokenCost`; `skipped_no_reduction`;
      `hardDropOldest` по `this.compactedBlock`.
- [ ] **W0.2/W9:** метрика прогресса хода в `llm_usage`; `writeModal`/меню `question`;
      i18n-паритет терминального markdown.

### 1.4 Раздутые файлы (долг `split-bloated-files`)

- [ ] Опустить файлы из `.arch-allowlist.json` до ≤300 строк — **59 осталось**
      (было 84, разрезано 25). Полный список и приоритет:
      [`docs/plans/2026-10-13-split-bloated-files-progress.md`](./docs/plans/2026-10-13-split-bloated-files-progress.md).
      По 1–2 файла за задачу; гейт — `tests/arch/file-size.test.ts`.

### 1.5 Мелкие хвосты исполненных планов

- [ ] `web-fetch`: короткий hash извлечённого контента в `display`/`data` (WS4.5 плана
      `2026-10-06-harness-reliability-fixes`).
- [ ] Режим компакции `llm`: `contextBudget.compactionSummary` допускает только
      `off|ledger`, файл `compaction-summary.ts` не реализован (там же, WS5).
- [ ] Правило «systemic-сбой только при ≥3 различных падающих тулах» (там же, WS9a).
- [ ] Живая приёмка леджера контекста: повторный прогон `hard-multi-extreme` с acceptance
      «`NEEDLE_A_111`/`B_222`/`C_333`, decoy 0, `exit=0`, notes-файл с `path:line`, блок
      с `[Notes:`» (план `2026-10-14-context-ledger`, Task 6).
- [ ] `session-phase.ts:145` пишет `model=${probe.model}` (значение пробнера на момент
      старта, а не живой модели) — остаток Task 3 плана `2026-10-11-harness-runaway-session-fixes`.
- [ ] `src/core/system-prompt.ts`: 14 строк длиннее 120 символов (канон системного промпта).
- [ ] StuckDetector: нет классификации `scope_drift`/`empty_output` — надёжного сигнала нет
      (`src/modules/execution/stuck-detector.ts` знает только `timeout`/`repeat`/`error_loop`).
- [ ] `src/core/hallucination/factual.ts:124,187`: cooldown-ветка возвращает `false`, не
      консультируя тёплый кэш (`indexHas`); рескан синхронный на hot path (Task 12 плана
      `2026-08-26-model-control-fixes`).

### 1.6 Качество памяти и самообучение (план `docs/superpowers/plans/2026-08-12-memory-quality-and-learning.md`)

План **открыт** — ни одна из трёх фаз не реализована. Из плана выполнено одно:
`SessionManager.loadSessionLog`.

- [ ] **Фаза 1 — валидатор памяти:** `src/modules/memory/validator.ts` + `MemoryValidator`
      (запись не валидируется: `append()`/`appendRule()` не возвращают `ValidationResult`),
      интеграция в `remember`-тул (нет `tool.remember.rejected`), конфиг `memory.validator`.
- [ ] **Фаза 2 — обучение:** `src/modules/learning/**` (`types/trace/validator/generator/cli/module`),
      подкоманда `mma learn`, регистрация `LearningModule` в bootstrap.
- [ ] **Фаза 3 — языковые адаптеры:** `language-adapters.ts` — валидатор работает только
      по ветке TS (`src/modules/execution/verifier.ts:298`).

---

## 2. Действия пользователя (не задачи для агента)

- [ ] Вернуть `contextWindow 64000` в реальном конфиге (`~/.mma`) — сейчас 32768:
      `/config contextWindow 64000`.
- [ ] Перезапустить opencode — тогда подхватится Playwright MCP
      (прописан в `~/.config/opencode/opencode.jsonc`, инструменты появляются после рестарта).

---

## 3. Дорожная карта до продакшена

> Полный gap-анализ: [`docs/specs/2026-09-28-production-readiness-design.md`](./docs/specs/2026-09-28-production-readiness-design.md).
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
- [ ] **Поставка и эксплуатация.** Dockerfile/K8s/`/healthz`, релиз-артефакт,
      манифест (prompt+model+tools+evals), откат одной командой, RBAC/тенанты,
      SLO + runbook.

### P2 — зрелость

- [ ] **Compliance (EU AI Act).** Append-only логи + подпись, high-risk артефакты
      (risk file, lineage, oversight-панель, adversarial-лог Art.15), retention ≥6 мес.
- [ ] **Внутренние хвосты.** `noExplicitAny` warn-ratchet → error; coverage-threshold
      в CI; остаток раздутых файлов (п. 1.3).

---

## 4. Бэклог

- [ ] Подобрать литературу по верификации/критикам (вторая половина пункта
      «контр-агент для проверки работы»; сам контр-агент сделан — `src/modules/critic/`).
- [ ] Долги из [`docs/agents/debt.md`](./docs/agents/debt.md) — каждый оплачивается
      по своему триггеру (правило 9). Активных записей: 15.

---

## 5. Релиз

- Публикация — **только через GitHub Releases** (npm publish не используется).
- Версии в бете — только `0.x.y` (`1.0.0` запрещён, гвард `tests/version-beta.test.ts`).
- Релиз = обновление `CHANGELOG.md` + `package.json` → тег `vX.Y.Z` → GitHub Actions.
