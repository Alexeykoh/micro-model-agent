# TODO — Micro Models Agent

> **Актуально на 2026-10-26** (`master` @ 0.12.6).
>
> Этот файл — только **открытая** работа. Закрытые пункты здесь не хранятся:
> история — в `CHANGELOG.md`, `docs/agents/feature-history.md` и коммитах.
> Отложенные решения — единым списком в [`docs/agents/debt.md`](./docs/agents/debt.md)
> (правило 9, pay-once); выполненные планы — в [`docs/plans/`](./docs/plans).

---

## 1. Открыто сейчас

### 1.1 WebUI

- [x] **Показ действий субагента по клику** — клик по субагенту переключает вид чата
      на ход работы субагента с возможностью вернуться назад. Одновременно может
      работать много субагентов: переключение между ходами + возврат в родительский
      чат без потери состояния. _(0.11.0: SSE `subagent`, `GET
      /api/sessions/:id/subagents`, спека `2026-10-23-subagent-run-view-design`.)_
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
      регистр — сделано; TOCTOU — сделано 2026-10-26: `pathGuard.recheck` перед
      операцией во всех мутирующих файловых тулах, гейт
      `tests/tools/enforcement-path.test.ts`) ·
      ~~allowlist записи в `delete-file`/`move-file`/`create-dir`~~ (сделано) ·
      ~~`glob-tool.ts` не фильтрует по scope/protected~~ (сделано) ·
      ~~`processRegistry.get(id)` без `sessionId`~~ (сделано) ·
      ~~нет `src/ui/sanitize-output.ts`~~ (сделано) ·
      ~~нет `certutil`/`bitsadmin`/`takeown`/`wscript`/`shred` в
      `security-policies.ts`~~ (сделано: единый `security-lists.ts`) ·
      маркера `[APPROVED]` нет — `DEBT(approve-marker-not-authoritative)`.
- [x] **W6 — web-сервис:** сделано 2026-10-21 — security-заголовки и auth на
      статику, капы тела по маршруту (1 МБ / 768 МБ для сообщений), кап записи
      памяти, SSRF-защита проб провайдера + rate-limit, честные коды ошибок
      (413/400/504/500), безопасный SVG, отмена вопроса при закрытии вкладки,
      троттл по сессиям, LRU/idle-вытеснение раннеров, инкрементальное чтение
      лога, таймеры/параллельный busy/зависший вопрос, XSS-guard, гонка
      активной сессии.
- [x] **W7 — конфиг:** сделано 2026-10-21 — v1-конфиг конвертируется (не удаляется),
      атомарная шифрованная запись доменов со слиянием чужих изменений, `/config
      reset` для json/list, failover с моделью целевого провайдера и общие лимиты
      запросов, гейт занятости в веб-настройках, реальные коды возврата CLI,
      честный setup-мастер, ротация лога/оборванный хвост/prune без живых
      раннеров, гашение фоновых детей при выходе.
- [x] **W4 — web-тулы:** сделано 2026-10-21 — `web_search` проверяет HTTP-статус,
      добавлены `web-errors.ts` (единый формат ошибок) и `web-content.ts`
      (фрейминг недоверенного контента), `web_browse` проверяет статус и
      сохраняет структуру строк, SSRF-политика (в т.ч. DNS-резолв) в браузере и
      `attach_image`, детект JS-шелла, предполёт Chromium, скиллы,
      `max_tokens` субагента.
- [x] **W8 — LSP и индексатор:** сделано 2026-10-21 — LSP-сервер получает pid и его
      дерево убивается, stderr сервера читается, лимиты провайдера не
      выдумываются, версии диагностик/устаревший exit, `lsp_check` честен про
      «не проверено», индекс пересобирается инкрементально (карта проекта не
      гаснет на время сборки), резолв спецификаторов ограничен.
- [x] **W9 — терминал/i18n/комплитер:** сделано 2026-10-21 — меню вопроса видно
      сразу, Ctrl+D завершает сессию чисто, ширина перемеряется при resize,
      i18n-паритет ключей и плейсхолдеров, терминальный markdown как в вебе,
      таблицы влезают в ширину терминала, комплитер работает по токену под
      курсором и знает абсолютные пути, длинные списки ограничены 20+«ещё N».
- [x] **Живой прогон на 9B:** сделано 2026-10-22 — карта проекта держится снимком
      на ход (изменение карты после записи рвало KV-кеш: префикс 51% → 99%),
      холодный старт LSP больше не блокирует запись (30 с → 0.1–4 с: проверка
      только на тёплом соединении, прогрев в фоне, бюджет проверки 4 с).
- [x] **W1/W2 — петля и контекст:** сделано 2026-10-22 (`fix/harness-audit-w1w2-loop`) —
      жёсткий стоп по повторяющемуся status-тулу даёт `stopReason=duplicate` и
      форс-ответ (а не успех с пустым текстом); улики фейлов живут в окне
      `recentOutcomes` (успех чужого тула их не отменяет); директивы харнесса
      переживают компакцию (реестр `id→текст` в `ContextManager`); сброс
      per-step состояния и кулдаун recovery/stuck-варнинга — внутри хода
      (`turnSeq` прокинут в плагины); файлы памяти капнуты (24k), recovery-директива
      и правило в память троттлятся; evidence галлюцинаций — только текущий ход;
      `overcommitted` виден в breakdown/терминале/сайдбаре; флор усечения вывода
      тула (400 символов) + пересчёт бюджета в символы; токены картинки — по
      пикселям (`imageTokenCost`); очередь картинок капнута (6) с дедупом и
      обнуляется в `clear()`; несжимаемый overflow → `skipped_no_reduction` без
      вооружения кулдауна; сводка hard-drop — из выброшенного head. Гейты:
      `tests/core/loop-duplicate-stop.test.ts`, `tests/core/directive-survives-compaction.test.ts`,
      `tests/core/tool-batch-recovery-throttle.test.ts`, `tests/core/context-w2.test.ts`,
      `tests/core/compaction-no-reduction.test.ts`,
      `tests/modules/execution/stuck-turn-scope.test.ts`, `tests/agent-tool-output.test.ts`.
      Второй заход той же ветки: research-стрик не сбрасывается одним не-web
      тулом (§1.4); blocked-батчи входят в honest-stop (§1.7); `sawSecurityBlock`
      живёт весь ход (§1.8); повторный вызов — по канонической подписи (§1.9);
      пороги компакции сравнивают историю с бюджетом истории (§3.1); леджер
      тулов ограничен и освобождает вытесненные ключи (§3.9). Гейты:
      `tests/core/tool-batch-research-convergence.test.ts`,
      `tests/core/loop-repeat.test.ts`, `tests/core/history-budget-threshold.test.ts`,
      `tests/core/tool-ledger-bounds.test.ts`, `tests/core/tool-batch-honest-stop.test.ts`.
      Осталось вне объёма: ресайз веб-аттачей (§2.4 плана) и калибровка >2×
      (§3.8 — сознательный отказ).
- [x] **W10 — service API и updater:** сделано 2026-10-22 — тенант — свойство процесса
      (`service.tenant`, `X-Mma-Tenant` только сверяется), идемпотентность скоупится
      тенантом и principal'ом (канонический хэш тела), ответ только для вопроса своей
      задачи (TTL 30 мин, кап 100), retention/prune и кап `task.events`, webhook: https +
      SSRF до и во время доставки, timing-safe `verifySignature` с окном replay, один
      timestamp на доставку, 3xx терминален; `/v1/ready` кэшируется и троттлится, SSE
      капнут/идли-таймаут/backpressure, strict-схема structured output и `attempt` у
      retry; установка апдейта: обязательные sha256+size, staged->rename->flip, проверка
      членов tar, кап скачивания, `stop()` резолвит idle, конкурентная установка
      отклоняется; id сессий — `crypto.randomBytes` без цифровых серий (иначе DLP
      принимал id за паспорт). Долги: `service-tier-scopes-control-plane`,
      `dlp-iso-timestamp-false-positive`. Гейты: `tests/service/tenant-authz.test.ts`,
      `idempotency-tenant.test.ts`, `retention.test.ts`, `webhook-ssrf.test.ts`,
      `output-strict.test.ts`, `output-attempt.test.ts`, `sse-limits.test.ts`,
      `tests/updater-install-atomic.test.ts`, `tests/session/session-id.test.ts`.
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
- [x] `session-phase.ts` пишет живую модель (`config.model`), а не модель пробника.
      _(Исправлено 2026-10-26.)_
- [ ] `src/core/system-prompt.ts`: 14 строк длиннее 120 символов (канон системного промпта).
- [ ] StuckDetector: нет классификации `scope_drift`/`empty_output` — надёжного сигнала нет
      (`src/modules/execution/stuck-detector.ts` знает только `timeout`/`repeat`/`error_loop`).
- [x] `src/core/hallucination/factual.ts`: пункт был устаревшим — тёплый кэш
      (`checkIndex`/`indexHas`) консультируется **до** cooldown-ветки (код с 2026-10-01),
      рескан остаётся rate-limited. Отдельная правка не нужна. _(Проверено 2026-10-26.)_

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

### 1.7 Субагенты — находки живой сессии `ses_mvoac9q9_ukjrorvcgjrkhyrv`

Сессия: `~/.mma/sessions/ses_mvoac9q9_ukjrorvcgjrkhyrv` (174 сообщения, проект
`C:\Users\Alexe\Desktop\mma_test`, Vite + React + Tailwind). Источник —
`history.jsonl` (строки 55–59, 82–88, 108–114, 144–170).

- [ ] **Изучить сессию `ses_mvoac9q9_ukjrorvcgjrkhyrv`** _(отложено: сессия лежит на
      другом устройстве в `~/.mma/sessions`; нужен доступ к логам)_ — разобрать по `session.jsonl` /
      `history.jsonl` / `audit.jsonl`: цепочку вызовов `subagent`, отказы
      `[SECURITY BLOCKED]` (неизвестный `expert_tag`), падения по лимиту токенов и
      реакцию пользователя («позакрывай ненужных субагентов», «вот висит три субагента»).
      Цель — список дефектов с воспроизведением, а не пересказ диалога.
- [x] **Дать инструмент работы с субагентами.** _(Сделано: `subagent_list` +
      `subagent_stop` поверх процессного реестра `src/tools/subagent-registry.ts`;
      `subagent_list` показывает `expert_tag` из конфига; `process_list` в описании
      прямо отделён от субагентов.)_ Сейчас у модели нет способа увидеть и
      закрыть субагентов: пользователь просил «позакрывай ненужных субагентов» и показывал
      «три висящих субагента», а модель могла показать только `process_list` (shell-процессы
      `bun install` / `bun dev`) и в итоге убеждала, что субагентов в фоне нет. Нужен
      явный тул (список / статус / остановка конкретного прогона, например
      `subagent_list` + `subagent_stop`) поверх уже существующего учёта прогонов
      (`src/modules/webui/session/subagent-runs.ts`), и чтобы `process_list` не выглядел
      как список субагентов. Плюс доступные `expert_tag` (`code`, `research`, `browser`,
      `vision`) должны быть видны в описании тула, а не только в тексте ошибки.
- [ ] **Проверить, почему не завершается работа с субагентами.** _(нужны логи
      сессии с другого устройства — без них воспроизведения нет; см. первый пункт)_ В сессии 4 падения подряд:
      «Субагент упал: Ответ упёрся в лимит токенов генерации (8192 / 3000 / 2500 / 900) и
      был обрезан до какого-либо содержимого», `Частичный вывод:` пуст. Задача каждый раз была
      «прочитай N файлов → верни отчёт». Проверить: (1) почему внутренние чтения съедают
      бюджет генерации и падение выглядит как «обрезано до пустого»; (2) правильно ли
      считается/прокидывается `max_tokens` субагента
      (`src/tools/subagent-limits.ts`); (3) почему успешный субагент без чтения вернул
      «работает», а с файлами — падал на любом лимите; (4) нет ли зависших прогонов и как
      они снимаются (связано с пунктом выше). Нужен тест, падающий на текущем поведении.
- [x] **Стоимость сессии считается по оценке и без кеша.** _(Исправлено:
      `usage` читается независимо от `choices`, `opencode.list_cost` — авторитетная
      стоимость, кеш — из `prompt_tokens_details`/`opencode.tokens.cache_read`.)_ Показанные `$1.2164` —
      арифметически верная сумма по прайсу ($0.15/$0.60 за 1M), но по **оценочным**
      токенам: все 90 вызовов `opencode-go/deepseek-v4.1-flash` в этой сессии имеют
      `origin: estimate` (ни одного `api`), `cacheSaved: 0`, событий с `cachedTokens` нет.
      Причина: OpenCode Go присылает usage на чанке, где **есть** `choices`
      (`finish_reason: "stop"`), а `src/llm/openai-compat.ts:528` читает usage только
      при `!choice` → `done` без usage. Провайдер при этом отдаёт в каждом ответе
      `prompt_tokens_details.cached_tokens`, `opencode.tokens.cache_read`,
      `opencode.list_cost` и `allowance` — MMA не читает ничего из этого.
      Живая проверка: два одинаковых запроса дали `cached_tokens 0 → 1664`, а
      `list_cost` второго — $0.00001414 (53×0.15 + 1664×0.003 + 2×0.6). При 85/90
      вызовах с `cacheStable = 1.0` стоимость с кешем была бы ≈ $0.046, то есть
      оценка завышает ~25×. Исправить: читать usage независимо от наличия `choices`,
      брать `opencode.list_cost` как авторитетную стоимость, добавить тест на фикстуру
      чанка `choices + usage`. Долг — в `docs/agents/debt.md` (`cost-estimate-not-usage`).

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
      по своему триггеру (правило 9). Активных записей: 21.

---

## 5. Релиз

- Публикация — **только через GitHub Releases** (npm publish не используется).
- Версии в бете — только `0.x.y` (`1.0.0` запрещён, гвард `tests/version-beta.test.ts`).
- Релиз = обновление `CHANGELOG.md` + `package.json` → тег `vX.Y.Z` → GitHub Actions.
