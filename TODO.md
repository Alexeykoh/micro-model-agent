# TODO — Micro Models Agent

> **Актуально на 2026-11-02** (`master` @ 0.23.0).
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
- [x] **Trace: поп-ап системного промпта** — кнопка `Prompt` в Trace открывает
      поп-ап с текстом, числом токенов и составом блоков. API
      `GET /api/sessions/:id/system-prompt` отдаёт `available:false`, пока у
      сессии нет живого раннера. _(2026-10-26, спека
      `docs/specs/2026-10-26-webui-system-prompt-popup-design.md`.)_

> Остальные WebUI-пункты (очередь сообщений, кнопки «отправить сейчас»/«отменить»,
> Files-tab, event-sourced состояние, модуляризация) — **закрыты**, см. `CHANGELOG.md`.

### 1.2 Corporate data policy (план `docs/plans/2026-10-19-corporate-data-policy-plan.md`)

- [x] **W1–W4 исполнены** — слиты в `master` 2026-10-19 (`41916e2b`): движок
      `data-policy` + `EgressGuard`, egress к провайдеру (E1), web/serve-фильтр (E2),
      404 на скрытые пути, DLP-вебхук. Гейты: `tests/security/data-policy*.test.ts`,
      `tests/providers/sanitizing-provider.test.ts`, `tests/webui/egress-filter.test.ts`,
      `tests/service/egress-filter.test.ts`.
- [x] **Payload `web_search`** — запрос проецируется до сети (`projectOutboundText`,
      маска без псевдонимов, fail-closed при ошибке классификатора). _(2026-11-02,
      гейт `tests/security/outbound-projection.test.ts`.)_
- [x] **Base64/hex/percent/fullwidth/гомоглифы/zero-width, split** — детекторы
      `detectors/encoded.ts` + `detectors/joined.ts` (значения и секреты в склейке,
      карта позиций обратно в оригинал). _(2026-11-02, гварды
      `tests/security/encoded-value.test.ts`, `tests/security/dlp-adversarial.test.ts`,
      `tests/providers/dlp-canary.test.ts`.)_ Произвольный текстовый паттерн,
      разорванный без разделителя, остаётся residual risk.
- [x] **Скрытый glob в тексте** — `apiHiddenGlobs`/`providerBlockGlobs` маскируют
      путь целиком в SSE args/output и истории, а не только на файловых эндпоинтах.
      _(2026-11-02, гейт `tests/security/api-hidden-globs.test.ts`.)_
- [x] **CLI: строка о редакции** — `◇ DLP: скрыто значений — N (классы)` после хода.
      _(2026-11-02, пассивный агрегат журнала.)_
- [x] **DNS-подмена trust** — задокументировано: доверие по конфигу и распарсенному
      хосту, IP/CIDR-записи как рекомендация (спека 2026-10-19, §«Остаточное»).
- [x] **Taint локального провайдера** — T1–T5 сделаны: метаданные по `seq`,
      наследование ответом локальной модели и сводкой компакции, маска `[FILE]` на
      внешнем egress (включая аргументы `tool_calls`), восстановление при resume с
      `taint_degraded`. Спека: `docs/specs/2026-11-02-local-provider-taint-design.md`.
      Остаётся вне объёма: плагины как источники taint и переменные/подстановки
      в `bash` (эвристика по токенам команды).
- [x] **bash и MCP как источники `file-content`** — вывод `bash` тегируется, если
      токен команды попадает под block-glob; MCP-тулы получают `pathArgs` из
      input-схемы. _(2026-11-02, гейты `tests/tools/file-content-tag-shell.test.ts`,
      `tests/modules/mcp/tool-security.test.ts`.)_
- [x] **Taint субагента** — ответ дочернего прогона, читавшего защищённые файлы,
      помечает родительский tool-результат tainted. _(2026-11-02,
      `tests/security/taint.test.ts`.)_
- [x] **Payload MCP** — аргументы тулов проецируются до сети, если сервер
      внешний (`http`/`sse` на не-loopback); `stdio` и приватная сеть — доверенные.
      _(2026-11-02, `projectOutboundDeep`, гейт `tests/modules/mcp/tool-security.test.ts`.)_
- [x] **NER (ФИО/адреса)** — строгие формы: ФИО только с отчеством, адрес только
      с маркером улицы и номером дома. _(2026-11-02,
      `tests/security/pii-natural.test.ts`.)_ Имя без отчества и адрес без номера —
      residual risk.
- [x] **At-rest (журнал сессий)** — opt-in `sessionEncryption`: `session.jsonl`,
      tail и history шифруются, чтение прозрачно. _(2026-11-02,
      `tests/security/at-rest-encryption.test.ts`.)_
- [x] **At-rest памяти (гибрид)** — авто-записи агента шифруются на месте
      (`[enc]…[/enc]`), ручные строки и `preferences.json` остаются открытыми;
      чтение и поиск расшифровывают. _(2026-11-02,
      `tests/modules/memory/at-rest.test.ts`.)_
- [x] **Перф: кеш проекции** — замер 4.7 → 0.007 мс на сообщение 1.9 КБ, ключ
      включает политику и glob-списки. _(2026-11-02,
      `tests/security/projection-cache.test.ts`.)_
- [x] **Плагины: контракт `pathArgs`** — вывод тегируется только при объявленных
      путях; контракт описан в `docs/agents/tools.md`. _(2026-11-02.)_
- [x] **Taint при спавне субагента** — если родитель tainted, ребёнок стартует
      tainted (seed переживает `beginTurn`). _(2026-11-02,
      `tests/security/taint.test.ts`.)_
- Остальные долги темы — [`docs/agents/debt.md`](./docs/agents/debt.md)
      (`file-content-bypass-non-path-tools` — плагины без объявления и подстановки
      `bash`, `streaming-tail-holdback`, `research-by-checksum`);
      `api-hidden-globs-text-scope`, `encoded-value-bypass`, `web-search-payload-dlp`,
      `dlp-cli-redaction-notice`, `file-content-taint`, `at-rest-pii`,
      `memory-at-rest`, `data-policy-projection-lifecycle` — оплачены.

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
- [x] **W0.2:** метрика прогресса хода в `llm_usage` — `progress` с
      `totalBatches`/`novelTools`/`duplicateBatches`, кумулятивно без сброса
      стриками. `writeModal`/меню `question` и паритет терминального markdown
      уже были сделаны. _(2026-10-26, гейт `tests/core/loop-progress.test.ts`.)_

### 1.4 Раздутые файлы (долг `split-bloated-files`)

- [ ] Опустить файлы из `.arch-allowlist.json` до ≤300 строк — **33 осталось**
      (было 84; снято 51: разрезано 48, уменьшено 3). Полный список и приоритет:
      [`docs/plans/2026-10-13-split-bloated-files-progress.md`](./docs/plans/2026-10-13-split-bloated-files-progress.md).
      По 1–2 файла за задачу; гейт — `tests/arch/file-size.test.ts`.

### 1.5 Мелкие хвосты исполненных планов

- [x] `web-fetch`: короткий hash извлечённого контента в `display`/`data`
      (`contentHash`, 8 hex; одинаковый текст с разных URL даёт один hash).
      _(2026-10-26, WS4.5; гейт `tests/tools/web-fetch.test.ts`.)_
- [ ] Режим компакции `llm`: `contextBudget.compactionSummary` допускает только
      `off|ledger` (`src/config/registry-extra.ts:182`). Файл
      `src/core/compaction-summary.ts` **есть и используется** в `ledger`-режиме —
      не хватает именно LLM-режима (сводка моделью) и его проводки в конфиг.
- [x] Правило «systemic-сбой только при ≥3 различных падающих тулах»: общий
      вывод в память гейтится `countDistinctFailingTools`, конкретные причины
      (`edit_file` anchor) пишутся отдельно. _(2026-10-26, WS9a;
      `tests/core/tool-batch-honest-stop.test.ts`.)_
- [ ] Живая приёмка леджера контекста: повторный прогон `hard-multi-extreme` с acceptance
      «`NEEDLE_A_111`/`B_222`/`C_333`, decoy 0, `exit=0`, notes-файл с `path:line`, блок
      с `[Notes:`» (план `2026-10-14-context-ledger`, Task 6).
- [x] `session-phase.ts` пишет живую модель (`config.model`), а не модель пробника.
      _(Исправлено 2026-10-26.)_
- [x] `src/core/system-prompt.ts`: директивы уложены в ≤120 символов (склейка `+`
      сохраняет текст); гейт `tests/core/system-prompt-line-length.test.ts`.
      _(Исправлено 2026-10-26.)_
- [x] StuckDetector: классификации `scope_drift`/`empty_output` **сняты как задача** —
      надёжного сигнала нет (в `src/modules/execution/stuck-signals.ts:21` зафиксировано,
      почему эти виды удалены). Возвращаться — только с новым источником улик.
      _(Проверено 2026-10-30.)_
- [x] `src/core/hallucination/factual.ts`: пункт был устаревшим — тёплый кэш
      (`checkIndex`/`indexHas`) консультируется **до** cooldown-ветки (код с 2026-10-01),
      рескан остаётся rate-limited. Отдельная правка не нужна. _(Проверено 2026-10-26.)_

### 1.6 Качество памяти и самообучение (план `docs/superpowers/plans/2026-08-12-memory-quality-and-learning.md`)

План **в работе**: Phase A (валидатор памяти) и Phase C (языковые адаптеры)
закрыты 2026-11-03; Phase B (обучение) открыта. Из плана ранее выполнено
`SessionManager.loadSessionLog`.

- [x] **Фаза 1 — валидатор памяти.** _(Сделано 2026-11-03, спека
      `docs/specs/2026-11-03-memory-validator-design.md`: `MemoryValidator` +
      гейт в `MemoryStore.append/appendRule` (`ValidationResult`, файл не
      трогается при отказе), `remember` отвечает `tool.remember.rejected`,
      ключи `memory.validator.*` в `DEFAULTS`/`registry-memory.ts`. Гейты:
      `tests/modules/memory/validator.test.ts`, `store-gate.test.ts`, `tests/i18n.test.ts`.)_
- [ ] **Фаза 2 — обучение:** `src/modules/learning/**` (`types/trace/validator/generator/cli/module`),
      подкоманда `mma learn`, регистрация `LearningModule` в bootstrap.
- [x] **Фаза 3 — языковые адаптеры.** _(Сделано 2026-11-03, спека
      `docs/specs/2026-11-03-language-adapters-design.md`: `adapterForExt` +
      `checkSyntax` — Python/Ruby/PHP/shell через компилятор, JSON через
      `JSON.parse`; отсутствующий бинарник деградирует fail-open, ошибка
      синтаксиса даёт `passed:false`. Гейты:
      `tests/modules/execution/language-adapters.test.ts`,
      `tests/verify-language-adapters.test.ts`.)_

### 1.7 Субагенты — находки живой сессии `ses_mvoac9q9_ukjrorvcgjrkhyrv`

Сессия: `~/.mma/sessions/ses_mvoac9q9_ukjrorvcgjrkhyrv` (174 сообщения, проект
`C:\Users\Alexe\Desktop\mma_test`, Vite + React + Tailwind). Источник —
`history.jsonl` (строки 55–59, 82–88, 108–114, 144–170).

- [x] **Изучить сессию `ses_mvoac9q9_ukjrorvcgjrkhyrv`** — разобрана по `session.jsonl` /
      `history.jsonl` / `audit.jsonl` (сессия оказалась на этой машине, не «на другом
      устройстве»). Результат — [`docs/plans/2026-10-27-subagent-live-session-analysis.md`](./docs/plans/2026-10-27-subagent-live-session-analysis.md):
      9 вызовов `subagent` (3 успеха, 2 блока по `expert_tag`, 4 падения по лимиту) и
      дефекты D1–D7 с воспроизведением. _(2026-10-27.)_
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
- [x] **Проверить, почему не завершается работа с субагентами.** _(сделано 2026-10-27 в ветке
      `fix/subagent-reliability`: спека
      [`2026-10-27-subagent-reliability-design`](../specs/2026-10-27-subagent-reliability-design.md) —
      джейл `bash` = `baseDir` (§A), обрыв до ответа восстанавливается одним повтором
      с выключенным reasoning и удвоенным бюджетом (§B). Гейты:
      `tests/tools/bash-scope.test.ts`, `tests/core/llm-truncation-recovery.test.ts`,
      `tests/openai-compat.test.ts`, `tests/tools/subagent-max-tokens.test.ts`.)_ В сессии 4 падения подряд:
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

### 1.8 Ошибки агента — живая сессия `ses_mvqwky8y_cjcjhgbdigannujp`

Сессия: `~/.mma/sessions/ses_mvqwky8y_cjcjhgbdigannujp` (mma 0.14.0, `lmstudio/qwen3.8-9b-distill`,
проект `E:\projects\micro-models-agent`, 2026-10-27 16:31–16:41, 5 прогонов субагентов).
Разбор дефектов агента (не модели) с доказательствами из лога и кодом —
[`docs/plans/2026-10-27-agent-errors-session-analysis.md`](./docs/plans/2026-10-27-agent-errors-session-analysis.md).
Порядок — по приоритету; каждый пункт отдельной веткой, с тестом, падающим до правки.

- [x] **A1 (P0) `allowed_files` с glob-формой закрывает субагенту весь доступ.** `…/**/*`
      не сопоставляется ни с чем: `matchesScopeEntry` (`src/tools/path-utils.ts:36`) сравнивает
      префиксы. В сессии 4 субагента не прочитали ни одного файла. _(Сделано 2026-11-02:
      спека [`2026-11-02-subagent-scope-entries-design`](../specs/2026-11-02-subagent-scope-entries-design.md),
      ветка `fix/subagent-scope-entries` — матчер скоупа в `src/modules/security/scope.ts`,
      `globToRegExp` переписан под честную грамматику `**`+суффикс, невалидные записи
      отвергаются с причиной, причина отказа называет состав скоупа. Гейты:
      `tests/security/scope-entries.test.ts`, `tests/security/scope-glob-entries.test.ts`,
      `tests/tools/subagent-scope.test.ts`, `tests/security/path-validator.test.ts`.)_
- [x] **A2 (P0) `glob` в субагенте врёт «Нет совпадений», скрыв всё скоупом.** 14/14 вызовов
      детей дали пустую выдачу при 780+ файлах у родителя. Причина жива: при
      `visible.length === 0` тул сразу возвращает `file.no_matches`
      (`src/tools/glob-tool.ts:60-62`), а счётчик `hidden` и строка `file.glob_hidden`
      появляются только в непустой ветке (`:67`). _(Сделано 2026-11-02 той же веткой:
      пустая выдача теперь несёт `glob_hidden`; гейт `tests/tools/glob-scope.test.ts`
      — «скрытое ≠ пусто».)_
- [x] **A3 (P1) Пустой `path` обходит enforcement.** `executor.ts:175` пропускал `""`, а
      `list_dir` резолвит `""` в корень проекта (`safeResolvePath`). _(Закрыто 2026-11-02:
      гвард «обязательный path-аргумент не пустой» из 1.12 (`enforcePathArgs` по
      `parameters.required`) уже закрывает это — пустая и пробельная строка блокируются
      до хендлера (`tool.path_arg_invalid`). Добавлен регресс-гейт:
      `tests/tools/enforcement-path.test.ts` — `path: ""`/`"   "` при закрытом скоупе
      → `blocked`, хендлер не вызван.)_
- [x] **A4 (P1) Журнал прогона субагента без аргументов тулов.** _(Сделано 2026-11-02:
      `subagentLogEntry` пишет запись `content:"tool_start"` с аргументами (`path` и др.)
      из события `tool_start`; строковые значения ужаты до 200 симв., секреты
      редактируются `redactContextSecrets`. Гейт
      `tests/tools/subagent-session-log.test.ts`. Раньше по журналу нельзя было понять,
      с каким путём упал вызов.)_
- [x] **A5 (P1) Счётчики антифлейлинга общие для родителя и детей.** _(Сделано 2026-11-02:
      `ToolExecutor.fork(pluginManager?)` — субагент получает свой менеджер плагинов и
      форк-контекст; счётчики `bash` по первому слову — `WeakMap` на контекст прогона,
      а не модульный Map процесса. Гейт `tests/tools/executor-fork-plugins.test.ts`.)_
      Раньше ребёнок накручивал «bash упал 14 раз» → 15 → 21 у родителя, у которого
      было 2 вызова.
- [x] **A6 (P1) Критик эскалирует числа без провенанса; его проверки невидимы в журнале.**
      _(Сделано 2026-11-03: спека
      [`2026-11-03-critic-evidence-provenance-design`](../specs/2026-11-03-critic-evidence-provenance-design.md),
      ветка `fix/critic-evidence-provenance`. `critical` с перечисленными жалобами без
      `evidence` понижается до `concern` (жалоба доходит советом, repair не тратится), в
      журнале — `critic_verdict { downgraded: "no_evidence" }`; `critic_check` несёт
      `evidence` — `tool(ключевой аргумент)`, до 8 событий. Гейты:
      `tests/modules/critic/provenance.test.ts`, `tests/core/critic-gate-evidence.test.ts`,
      `tests/arch/observability-coverage.test.ts`.)_
      «заявлен 1487, а на самом деле >4000» (индекс против диска с `node_modules`) дало
      `critical` и 3 лишние итерации. Живая сессия `ses_mvv8mr4z`: критик дважды дал
      `concern` «weather facts lack web grounding», хотя `web_browse` вызывался.
- [x] **A7 (P1) Результат субагента не несёт здоровья прогона.** _(Сделано 2026-11-03:
      `RunHealth` в `src/tools/subagent-health.ts` — `toolsOk/toolsFailed/filesRead/
      filesWritten/blocked`; попадает в `end`-событие, журнал и строку результата
      `[run health: …]`; аналитическая задача без единого чтения → `success:false` с
      причиной. Гейты: `tests/tools/subagent-session-log.test.ts`,
      `tests/tools/subagent-empty-run.test.ts`, `tests/tools/subagent-health.test.ts`.)_
      Раньше 5/5 прогонов отдавали `success:true` при 38 падениях из 60 вызовов и
      0 чтений у двух.
- [x] **A8 (P2) Заголовок сессии падает на reasoning-модели.** _(Сделано 2026-11-03:
      `generateSessionTitle` делает один повтор с удвоенным бюджетом
      (`TITLE_MAX_TOKENS * 2`) и `reasoningEffort: "none"`, если первая попытка вернула
      пустой текст (тот же recovery, что `truncated_no_content`); отказ после повтора
      пишется тихо (`logSilent`). `TitleChat` принимает опции бюджета/reasoning.
      Гейт `tests/session-auto-name.test.ts`.)_

### 1.9 Находки текущей сессии `ses_mvuy6zpc_otiooomxxrtseqcx` (0.18.6)

- [x] **A9 (P1) Инструмент плана не умеет смотреть за пределы рабочей директории — и это нужно
      честно чинить, потому что пользователь может отключать ограничение.** Проявилось
      вживую: шаг плана «убрать `--headless` из `mcpServers.playwright.args`» +
      проверка `file-exists:%USERPROFILE%/.mma/config.json` → `plan_step` ответил
      «указанные в нём файлы ещё не существуют: `/.mma/config.json`»; пришлось
      перепланировать шаги на `manual:`/`command:`, чтобы не врать о статусе.
      Причина — в проверках, а не в самих тулах: `file-exists` никак не учитывает
      `security.paths.enabled` и резолвит путь сам, минуя единую точку (INV-9/10).
      Требуется: (1) резолв и проверка пути в `file-exists:` — через тот же
      `path-validator`, что и у тулов, с тем же вердиктом; (2) при
      `security.paths.enabled=false` (ограничение выхода из `baseDir` снято) —
      `file-exists:` и `command:` проверяют путь за пределами `baseDir`, а не падают
      «файла нет»; (3) при включённом ограничении — внятная причина отказа
      («вне baseDir, ограничение включено»), а не «файл не существует».
      Ветка `fix/plan-check-path-scope`; спека контракта проверок — как A1.
      Гейты: `tests/security/path-validator.test.ts`, новый
      `tests/modules/execution/plan-check-outside-base.test.ts`.
- [x] **A10 (P1, после A9) Обязательно проверить, что отключение ограничения на выход из
      директории реально работает.** Сейчас связка не проверена целиком: в
      `path-validator.ts:58` проверка `isInsideDir(targetResolved, baseResolved)` стоит
      **до** ветки `if (!securityConfig?.enabled)`, то есть `security.paths.enabled=false`
      снимает `allowed`/`denied`-паттерны, но **не** снимает jail `baseDir` — это надо
      либо подтвердить как задуманное (и назвать ключ, который jail снимает), либо
      починить. Проверка обязана быть сквозной: конфиг с выключенным ограничением →
      `read_file`/`write_file`/`bash workdir`/`plan` с `file-exists:` по пути вне
      `baseDir` → операция проходит; и обратный кейс — с включённым ограничением →
      отказ с причиной. Гейт: `tests/tools/bash-scope.test.ts`,
      `tests/tools/enforcement-path.test.ts`, `tests/security/path-validator.test.ts`.
- [x] **A11 (P0) DLP, скорее всего, ломает запросы к провайдеру (400 Bad Request).**
      Живой лог: `Ошибка LLM: Ошибка LLM API 400 (Bad Request): Upstream request failed:
[invalid_request_error] Invalid 'tools[24].***.name': string does not match pattern.
Expected a string that matches the pattern '^[a-zA-Z0-9_-]+.`
      (request_id `85485dad-8344-4c2f-9b70-3cb46546d8fa`). Провайдер отвергает **имя
      инструмента**: вместо `^[a-zA-Z0-9_-]+$` пришло `***`. Механика подозревается
      явно: `sanitizeChat()` (`modules/security/data-policy/guard.ts:99`) гонит через
      `projectDeep` **и сообщения, и массив `tools`** (`guard.ts:117-121`), то есть
      проекция заходит в схему тула и правит его **имя**, а не только значения аргументов.
      Имя тула — структурный идентификатор, оно не должно редактироваться никогда
      (маскировать можно только `description`/значения). Требуется: (1) закрепить
      инвариант «имя тула и имена его полей-ключей неприкосновенны» в `projectDeep`
      и в спеке data-policy; (2) при редактировании значений следить, чтобы результат
      оставался валидным для JSON-схемы (`pattern`/`enum`), иначе запрос заведомо
      битый; (3) регресс-тест на реальной форме `tools[]` с именем из
      `[a-zA-Z0-9_-]`, падающий до правки. Ветка `fix/dlp-tool-name-integrity`;
      гейты: `tests/security/data-policy*.test.ts`,
      `tests/providers/sanitizing-provider.test.ts`, новый
      `tests/security/dlp-tool-name.test.ts`.
- [x] **A12 (P1) Переносы строк теряются на пути к модели и в `mma web`.**
      Нужно, чтобы текст уходил в модель **с сохранением переносов строк** (многострочный
      ввод из REPL и веба — как есть, без склейки в одну строку), и чтобы `mma web`
      **отображал** ответы и сообщения с переносами (включая списки/абзацы), а не одной
      простынёй. Проверить цепочку целиком: поле ввода веба → `POST /api/...` (тело,
      `\n` не схлопывается) → сборка промпта → провайдер; и обратно — SSE → рендер
      Markdown в вебе и в терминале (паритет `tests/ui/md-terminal-parity.test.ts`).
      Ветка `fix/multiline-fidelity`; гейты: новый
      `tests/webui/multiline-roundtrip.test.ts`, `tests/ui/md-terminal-parity.test.ts`.
- [x] **A13 (P0) Отзыв черновика гейтом критика не визуализирован: непонятно, где ответ и
      кто его отменил.** Сценарий пользователя: модель отдаёт ответ, он стримится в ленту →
      критик бракует → **ответ пропадает**, в трассировке повисает «черновик отозван» без
      объяснений. Не видно ни того, что это **критик** сработал, ни **почему**, ни того,
      что это штатная перепроверка, а не сбой.
      Факты из кода: отзыв шлётся из двух мест — `injectAdvice`
      (`src/core/agent/critic-gate.ts:273`) и `injectRepair` (`:286`) одной и той же
      меткой `t("ui.draft_retracted")` = «↳ черновик отклонён проверкой, уточняю…»
      (`src/i18n/ru.json:1127`). В ней **нет ни виновника, ни причины**.
      Веб ловит `kind === "retract"` (`src/modules/webui/session/forward.ts:176-178`) и
      отправляет SSE `retract` с `reason` — но `reason` = тот же самый текст без причины.
      В UI: лента стирает блок (`assets/js/feed/stream.ts:127`), маскот уходит в
      `faceEvent("error")` (`assets/app.ts:346`), а `loader.ts:107-109` маппит
      `retract → "error"` — то есть перепроверка выглядит как **ошибка**. В трассировке
      строка `web.sidebar.trace_retract` = «черновик отозван» (`assets/js/sidebar/trace.ts:34`)
      не связана со строкой вердикта `critic · {status}` (`trace.ts:36`) — связи
      «этот отзыв из-за этого вердикта» нет.
      Отдельная беда: для галлюцинаций та же метка отправляется из
      `retractDraft` (`src/core/agent/hallucination-claims.ts:62-63`), поэтому **два разных
      гейта (critic и hallucination) в UI неотличимы**.
      Требуется: (1) в `onMeta`-метке отзыва передавать **источник** (`critic` | `hallucination`)
      и **краткую причину** (issues/summary вердикта), а не голый текст; (2) отдельное
      состояние маскота MMART для «перепроверка/отзыв» вместо `error` — в `FaceState`
      (`assets/js/loader.ts:7-14`) его сейчас нет, а `error` читается как поломка;
      (3) в ленте — не молчаливое стирание, а видимая плашка «черновик отозван: <кто> —
      <почему>», чтобы ответ не исчезал бесследно; (4) в трассировке — связь отзыва с
      конкретным `critic_verdict` (итерация/id), а не две независимые строки.
      Ветка `feat/retract-visibility`; гейты: `tests/modules/critic/*`,
      `tests/arch/observability-coverage.test.ts`, `tests/webui-feed-lifecycle-dom.test.ts`,
      новый `tests/webui/retract-visible.test.ts` (лента + трассировка + состояние маскота
      при `retract`).
- [x] **A14 (P1) Трассировка: нет кнопки «наверх» и лента не перевёрнута (новое — внизу).**
      Сейчас `assets/js/sidebar/trace.ts` копит строки вниз и на **каждую** вставку
      докручивает `list.scrollTop = list.scrollHeight` — в `pushRow` (`:152`),
      `renderTrace` (`:117`), `replaceRow` (`:161`), `streamRow` (`:170`). Из-за этого
      при длинном ходе пользователь «приклеен» к низу: новое событие появляется снизу,
      а всё, что было выше, уезжает, и вернуться к началу хода нечем — кнопки «наверх»
      нет. Требуется: (1) **перевернуть** ленту — свежие строки сверху (новые входят в
      начало списка, `prepend`, автоскролл к верху/нулю, тумблер «свежие сверху/снизу»
      не обязателен, но поведение должно быть предсказуемым); (2) кнопка **«наверх»**,
      появляющаяся при уходе в глубину истории, с сохранением позиции, если пользователь
      сам отскроллил; (3) автоскролл **не должен** дёргать пользователя, который читает
      историю — приклеивание только когда он у нижней/верхней кромки; (4) виртуализация
      или батчинг: `TRACE_CAP` есть, но `appendChild` + `scrollHeight` на каждый чанк
      текста (`streamRow`) — это layout-триггер на каждый токен. Ветка `feat/trace-reverse`;
      гейты: `tests/webui-feed-lifecycle-dom.test.ts`, новый
      `tests/webui/trace-scroll.test.ts` (порядок новых сверху, кнопка наверх,
      автоскролл не дёргает при чтении истории).
- [x] **A15 (P0) Пост-обработка после ответа модели занимает ~120 с: пользователь смотрит
      на готовый ответ, который ещё не «утверждён».** Живое наблюдение: ответ виден в
      ленте, но финальный статус приходит только через ~120 с — это критик
      (`critic`), и он **блокирует** завершение хода. Факты из кода: шаг критика
      синхронный по ветке петли — `loop-gates.ts:123` `await inp.criticGate.evaluate(...)`,
      затем `auditGate.evaluate` (`:141`), и только потом `break` (`:151`); тот же
      `await` в форс-финале `loop-run.ts:156`. Бюджет критика по умолчанию —
      `DEFAULT_TIMEOUT_MS = LLM_REQUEST_TIMEOUT_MS` (`modules/critic/client.ts:52`), то
      есть десятки секунд на вызов, а вызовов за ход до `critic.maxCalls` +
      `maxRepairCycles` + `adviceCycles`; при «advice/repair» черновик **отзывается**
      (A13) и модель отвечает **заново** — суммарно и выходит ~2 минуты. Отдельно:
      комментарий в `client.ts:211` фиксирует, что провайдер, не слушающий `signal`,
      удерживает вызов 83–120 с даже при `timeoutMs=15000` — то есть задержка
      эмпирически уже наблюдалась.
      Разобраться и ускорить: (1) **измерить по фазам** — отдельные метки времени на
      `critic_check`/`critic_verdict`/`critic_escalation` в `session.jsonl` и агрегат
      «сколько ход стоит в каждом гейте», чтобы говорить о факте, а не о догадке;
      (2) рассмотреть **параллелизацию**: гейты `critic` и `audit` не зависят друг от
      друга на финальном тексте — запускать одновременно и брать худший вердикт
      (`Promise.all`), это снимает одну из двух последовательных задержек;
      (3) **показывать ответ пользователю сразу** (он уже в ленте) и не держать UI в
      состоянии «работаю», пока идёт проверка: плашка «проверяется критиком» с
      таймером вместо тишины; (4) ужать бюджет — отдельный `critic.timeoutMs` меньше
      `LLM_REQUEST_TIMEOUT_MS`, кап токенов вердикта, отказ от повторных вызовов на
      том же вердикте; (5) рассмотреть «критик после выдачи» (оптимистичная выдача +
      исправление постфактум), если проверка не может уложиться в бюджет.
      Ветка `perf/critic-latency`; гейты: `tests/modules/critic/*`,
      `tests/arch/timeout-relations.test.ts`, `tests/arch/llm-call-options.test.ts`,
      новый `tests/modules/critic/latency-budget.test.ts`.

### 1.10 UX-аудит WebUI (живой прогон 2026-11-02)

Живой прогон `mma web` через Playwright: десктоп 1280×800 и мобильный 390×844;
чат, Files (дерево/поиск/просмотр), LSP, Trace, дропдаун сессий, настройки,
drawer, клавиатура. Что работает (не трогать): кольцо фокуса у кнопок
(2px accent), стрелки в `role=tablist`, focus-trap диалога настроек (+возврат
фокуса), Escape закрывает drawer и настройки, горизонтального скролла на 390px
нет, `prefers-reduced-motion` учтён, консоль чиста кроме картинок README.
Пункты — отдельными ветками (правило 3), P1 = баг/блокер, P2 = заметная
недоработка, P3 = полировка. Скриншоты прогона в репозиторий не коммитились.

#### P1 — баги и блокеры

- [x] **U1. У поля ввода нет видимой индикации фокуса — вообще.** _(Сделано 2026-11-03,
      ветка `fix/webui-composer-focus`: тема console больше не задаёт `--input-shadow:
      transparent` (accent с alpha ~45% в тёмной и светлой), а reset темы
      (`body.console * { box-shadow: none !important }`) получил явное исключение для
      `:focus-within`/`:focus` композера, поля ввода и поиска настроек. Живая проверка
      в браузере: `box-shadow: rgba(208,206,204,0.45) 0 0 0 2px`. Гейт
      `tests/webui-focus-ring.test.ts` — кольцо не может быть прозрачным.)_
      Проверено: `.composer` совпадает с `:focus-within`, но вычисленные стили не
      менялись — `--input-shadow: transparent`.
- [x] **U2. Просмотр README ломает внешние картинки — 10 ошибок CSP.** _(Сделано
      2026-11-03, ветка `fix/webui-md-images`: внешние `<img>` не грузятся вовсе —
      в `md.ts` (SRC) картинка с чужого origin заменяется ссылкой-чипом
      `a.md-img-ext` с alt/хостом (CSP `img-src 'self' data: blob:` остаётся
      строгой, запросов к чужим хостам нет). Живая проверка: README показывает
      чипы «License: MIT» / «Status: beta», `<img>` — 0, ошибок консоли — 0.
      Гейт `tests/webui-md-render.test.ts`.)_
      Политика `img-src 'self' data: blob:` блокировала бейджи `img.shields.io`.
- [x] **U3. Trace пуст для исторических сессий.** _(Сделано 2026-11-03, ветка
      `fix/webui-trace-backfill`: при смене сессии курсор ставится в начало лога
      (`sb.logCursor = null`) и сразу вызывается `sidebarPullLog()` — история
      подтягивается до того, как пользователь откроет вкладку; live-режим
      остался догоняющим. Живая проверка в браузере: переключение на сохранённую
      сессию показывает 483 симв. строк (критик, usage, запросы) вместо
      «событий пока нет».)_
- [x] **U4. Мобильный: две верхние панели с дублирующими кнопками.** _(Сделано
      2026-11-03, ветка `fix/webui-mobile-topbar`: на ≤760px одна панель — вкладки +
      `+`, `≡`, `▤`, `⚙` в `.bar-top`; строка сессии скрыта и появляется только при
      2+ вкладках (`body.multi-tab`), где prev/next/close реально нужны. Живая
      проверка 390×844: одна полоса 41px вместо 80px, кнопки не дублируются,
      горизонтального скролла нет, drawer и настройки открываются с
      перемещённых кнопок; 1280px — прежний порядок без изменений.)_
- [x] **U5. Мобильный drawer без focus-trap и `inert`.** _(Сделано 2026-11-03, ветка
      `fix/webui-drawer-focus`: при открытии drawer контент `.chat` получает `inert`
      (фон не фокусируется и не читается скринридером), фокус уходит на активную
      вкладку панели, Tab циклится внутри `.sb`; при закрытии/Escape/resize `inert`
      снимается, фокус возвращается на `#toggleSidebar`; `aria-modal` ставится только
      на время открытия. Живая проверка 390×844: 8×Tab — всё внутри панели, после
      Escape фокус на переключателе.)_
- [x] **U6. Тач-таргеты меньше 44px — 77 элементов из 673 (390px).** _(Сделано
      2026-11-03, ветка `fix/webui-touch-targets`: при `@media (pointer: coarse),
      (max-width: 760px)` — `.icon-btn` ≥32×32, `.stab-x` 32×32 (было 18×18),
      `.sb-tab` ≥40px, чипы композера (`.sel > button`, `.chip`, `.linkbtn`) ≥32px.
      Живая проверка 390×844: интерактивных целей меньше 28×28 — **0** (было 77),
      горизонтального скролла нет; на 1280px размеры прежние.)_

#### P2 — заметная недоработка

- [x] **U7. Сайдбар: 8 иконочных вкладок по 34px без подписей.** _(Сделано 2026-11-03,
      ветка `feat/webui-sidebar-resize`: у каждой вкладки видимая текстовая подпись
      (`t web.sidebar.tab_*`), полоса переносится и больше не скроллится вбок; ширина
      колонки тянется за разделитель (`--sb-w`, 300–760px, чат не уже 420px), значение
      живёт в `localStorage` `mma-sidebar-w`, есть клавиатура (←/→, Home — сброс) и
      двойной клик; в drawer ≤1024px ручка скрыта, ширина остаётся CSS. Живая проверка
      1280×800: подписи «Сессия…Карта», drag 486→606px с переживанием перезагрузки,
      Home возвращает 486px; 390×844: drawer, ручки нет, горизонтального скролла нет.
      Гейт `tests/webui-sidebar-resize.test.ts`.)_
- [x] **U8. Вкладка «Файлы» — внутренний хэдер.** _(Сделано 2026-11-03, ветка
      `feat/webui-files-header`: у панели появился хэдер «файлы проекта» с тремя
      действиями дерева (свернуть всё / развернуть всё / обновить), а поиск вынесен
      на отдельную строку на всю ширину (`files-search-row`, 26px, поле 224px при
      дереве 240px) и получил видимую кнопку очистки — появляется только при
      непустом запросе, очищает и возвращает дерево (Escape работает как раньше).
      Живая проверка 1280×800: ввод «resize» → кнопка 24×24, клик → поле пустое,
      результаты скрыты, дерево вернулось; заголовок и кнопка локализованы.
      Гейт `tests/webui-files-header.test.ts` + `tests/webui-files-search-dom.test.ts`.)_
- [x] **U9. Дерево файлов: клавиатура «наполовину».** _(Сделано 2026-11-03, ветка
      `fix/webui-tree-a11y`: roving tabindex — ровно одна строка достижима Tab'ом
      (курсор, иначе первая), `paintCursor` двигает `tabindex` вместе с курсором,
      у строк появился `aria-level` (глубина+1), у папок — `aria-expanded`, у файлов
      — `aria-selected`. Живая проверка: 31 строка → `tabindex=0` ровно у одной,
      после раскрытия папки уровни `1/2`, `aria-expanded="true"`.)_
- [x] **U10. Тема не сообщается браузеру.** _(Сделано 2026-11-03, ветка
      `fix/webui-color-scheme`: `<meta name="theme-color">` объявлен до первой
      отрисовки, pre-paint-скрипт и `applyTheme` выставляют
      `documentElement.style.colorScheme` и цвет хрома по режиму (тёмная —
      `#0f0f10`, светлая — `#f7f7f4`). Живая проверка: переключение режима меняет
      и `color-scheme`, и meta; нативные скроллбары/адресная строка следуют теме.
      Гейт `tests/webui-color-scheme.test.ts`.)_
- [x] **U11. Нет skip-link и landmark `<main>`.** _(Сделано 2026-11-03, ветка
      `fix/webui-landmarks`: чат обёрнут в `<main class="chat" id="main">`,
      первым Tab-стопом идёт `a.skip-link` («skip to messages»), `#msgs` получил
      `tabindex="-1"` — Enter переносит фокус к сообщениям. Живая проверка: первый
      Tab — видимая ссылка (top 8px), Enter → `document.activeElement === #msgs`,
      ошибок консоли 0. Гейт `tests/webui-landmarks.test.ts`.)_
- [x] **U12. Подсказка над полем — только для десктопа.** _(Сделано 2026-11-03, ветка
      `fix/webui-hints-pointer`: добавлен `#hintTouch` («tap ↑ — send»); при
      `(pointer: coarse)` или ≤760px клавиатурные подсказки (Enter/Shift/Ctrl+V/Esc)
      скрыты, показывается тач-вариант. Живая проверка 390×844: видна только
      тач-подсказка; на 1280px — клавиши.)_
- [x] **U13. LSP: нет индикации выключенного состояния.** _(Сделано 2026-11-03, ветка
      `feat/webui-lsp-offline-badge`: вкладка LSP получает постоянную жёлтую точку
      `off`/`offline` и подпись «LSP · выключен / офлайн» в `title`/`aria-label`;
      в панели — видимый баннер с причиной и кнопкой «настроить» (открывает тот же
      info-диалог); отключённая проверка в ходе больше не притворяется поломкой —
      `[LSP disabled]` даёт спокойное dim-состояние `lspoff`, а `[LSP check failed]`
      остаётся `error`. Живая проверка (изолированный `MMA_CONFIG_DIR`): после
      `lsp.enabled=false` вкладка показывает «LSP · выключен» и баннер, после
      `lsp.offline=true` + doctor — «LSP · офлайн» и offline-баннер. Гейты
      `tests/webui-lsp-offline.test.ts`, `tests/webui-loader.test.ts`.)_
- [x] **U14. Сессии: 61 строка без виртуализации, без закрепления и групп.** _(Сделано
      2026-11-03, ветка `feat/webui-sessions-scale`: строки списка получили
      `content-visibility:auto`; появилась секция «закреплённые» — pin хранится в
      `localStorage` (`mma-pinned-sessions`) и переживает перезапуск сервера;
      при ≥60 сессиях показывается подсказка «В списке N сессий. Почистить каталог:»
      с командой `mma session prune --dry-run`. Группировка по проекту осталась вне
      объёма: в `/api/sessions` нет поля проекта. Живая проверка: 103 строки,
      pin → секция «закреплённые» с выбранной сессией, prune-баннер виден.
      Гейт `tests/webui-sessions-scale.test.ts`.)_
- [x] **U15. Trace: нет времени у событий и нет таблицы.** _(Сделано 2026-11-03, ветка
      `feat/webui-trace-time`: у каждой строки справа колонка `HH:MM:SS`
      (tabular-nums, время из `ts` записи `session.jsonl`, а не момента открытия —
      `appendLogEntry` проносит оригинальный timestamp), в `title` — относительное
      `+41.8s` от начала хода; заголовок хода несёт время старта («ход 0 · 00:15:27»).
      Живая проверка на исторической сессии: 11 строк, времена 00:15:27…00:16:09,
      смещения `+0.0s`…`+41.8s`. Гейт `tests/webui-sidebar-dom.test.ts`.)_
- [x] **U16. Нет глобальных горячих клавиш.** _(Сделано 2026-11-03, ветка
      `feat/webui-shortcuts`: `Ctrl/Cmd+K` открывает сессии и ставит фокус в поиск,
      `Ctrl/Cmd+P` — вкладку Files и поиск (на узком экране открывает drawer);
      Alt+1..9 и `/` не перехватываются. В подсказке композера появилась строка
      «Ctrl+K — сессии · Ctrl+P — файлы» (скрыта на тач/≤760px). Живая проверка:
      Ctrl+K → `#sessSearch` в фокусе, Ctrl+P → видимая вкладка Files с фокусом в
      `#filesSearch`. Гейт `tests/webui-shortcuts.test.ts`.)_

#### P3 — полировка

- [x] **U17. Кнопки копирования всегда видны.** _(Сделано 2026-11-03, ветка
      `fix/webui-copy-hover`: `.msg-actions` скрыт (`opacity:0`) и проявляется при
      hover по ленте, hover по самой строке и `:focus-within` (клавиатура); на
      `(pointer: coarse)` остаётся видимым — там hover нет. Живая проверка:
      вне ленты `opacity:0` у всех строк, при наведении — `1`. Гейт
      `tests/webui-copy-hover.test.ts`.)_
- [x] **U18. Пустой экран дублирует placeholder.** _(Сделано 2026-11-03, ветка
      `fix/webui-empty-state`: пустой экран показывает только «✦ новый чат»;
      строка-подсказка «введи сообщение ниже · / — команды · …» убрана из ленты —
      она и так есть в плейсхолдере композера. Живая проверка: `.empty` без `.hint`.
      Гейт `tests/webui-empty-state.test.ts`.)_
- [x] **U19. Композер: два ряда чипов.** _(Сделано 2026-11-03, ветка
      `fix/webui-composer-chips`: на ≤640px строка селекторов не переносится;
      подписи («провайдер/модель/контекст/рассуждения») скрыты через `font-size:0`
      (значения остаются), полное «label: value» ушло в `title`/`aria-label`;
      модель забирает остаток ширины и усекается, маскот композера на узком экране
      скрыт ради места. Живая проверка 390×844: одна строка 40px, `lmstudio`,
      `nvidia-nemot…`, `auto`, `auto`, без горизонтального скролла; на 1280px —
      прежний вид с подписями и маскотом. Гейт `tests/webui-composer-chips.test.ts`.)_

#### Вне аудита (из прошлой сессии)

- [x] **Скиллы в системном промпте — топ-10 по использованию.** _(Сделано 2026-11-03,
      ветка `feat/skill-usage-top`: `SkillUsage` пишет счётчики в
      `~/.mma/skills-usage.json` атомарной заменой и переживает рестарт; каталог
      в промпте — ровно топ-10 (count desc, затем имя; неиспользованные — по
      порядку сканирования), остальные доступны через `load_skill` с query и
      `/skills`. Спека `docs/specs/2026-11-03-skill-usage-top-design.md`, гейты
      `tests/modules/skills/usage.test.ts`, `catalog-top.test.ts`.)_

### 1.11 Прозрачность DLP в WebUI (что ушло провайдеру и что именно отредактировано)

> **Сделано 2026-11-02** в ветке `feat/dlp-transparency-and-coverage` (спека
> `docs/specs/2026-11-02-dlp-transparency-and-coverage-design.md`): U20/U21/U22
> реализованы и проверены живым прогоном `mma web` с провайдером `opencode-go`
> (снимок запроса, позиции редакции с переходом, вкладка «Безопасность»).
> Остаток направления — волна 2 (покрытие egress): §1.2 и долги
> `web-search-payload-dlp`/`encoded-value-bypass`.

Цель: пользователь **сам** убеждается, что безопасность работает — видит ровно тот
запрос, который ушёл провайдеру, и конкретные места редакции, а не только счётчики.
Оба пункта меняют контракт (форма события в `session.jsonl`, поля SSE, форма
агрегата) → каждому нужна спека `docs/specs/<дата>-…-design.md` (правило 2), и
оба обязаны соблюдать INV-DLP-1/6/8: **оригиналы и token id в UI и лог не попадают**,
только маскированные значения, классы и позиции.

- [x] **U20 (P1) Trace: поп-ап «Запрос провайдеру» — что реально ушло в модель.**
      Сейчас Trace показывает события хода, но не сам request/response-пакет: нельзя
      проверить ни состав промпта, ни то, что DLP действительно вычистил данные.
      Требуется: (1) снимок **исходящего** запроса в точке провайдера — после
      проекции (`sanitizeChat`/`projectDeep`, `modules/security/data-policy/guard.ts`)
      и до сети, т.е. то, что уйдёт в API: `messages`, `system`, `tools`
      (имена + описания), параметры (`model`, `temperature`, `max_tokens`, `stream`,
      `reasoning`); (2) запись в `session.jsonl` отдельным событием (`llm_request`)
      с капом размера (усечение по блокам с пометкой «обрезано»), без оригиналов;
      (3) в Trace — строка/кнопка «запрос» на каждый вызов модели, по клику поп-ап
      с **отформатированным и читаемым** видом: дерево `system → messages → tools`
      с подсветкой блоков, тронутых DLP, бейдж назначения (внешний/локальный
      провайдер + хост) и сводка редакции этого вызова; (4) возможность скопировать
      JSON как есть (для разбора инцидентов) и переключатель «только отредактированные
      места»; (5) рядом — ответ модели (или ошибка провайдера) для сверки.
      Опираться на существующий поп-ап системного промпта
      (`GET /api/sessions/:id/system-prompt`, спека
      `2026-10-26-webui-system-prompt-popup-design`) и `openSubDialog`
      (`assets/js/subdialog.ts`). Ветка `feat/dlp-trace-request-popup`; гейты:
      `tests/providers/sanitizing-provider.test.ts`, `tests/security/data-policy*.test.ts`,
      новый `tests/webui/llm-request-snapshot.test.ts` (снимок не содержит
      оригиналов, кап соблюдён, поп-ап строится из события).
- [x] **U21 (P1) Чат: клик по категории DLP → конкретные места редакции.**
      Сейчас бейдж DLP агрегатный (класс → вид → счётчик → маскированный отпечаток
      секрета и назначение — `assets/js/feed/egress.ts:1-2`, форма
      `EgressTurnSummary` в `src/modules/security/data-policy/types.ts:87`): видно
      «что и сколько», но не «где именно» — ни сообщения, ни тула, ни поля, ни
      места в тексте. Требуется: (1) расширить агрегат **позиционной** детализацией
      на находку: класс, вид, где (`messageIdx` / `tool` + имя аргумента / `system`),
      диапазон в тексте (`span`), чем заменено (метка-плейсхолдер вида
      `«MAIL_1»` / `***` / псевдоним), — с капом числа записей и **без** оригиналов;
      (2) клик по строке категории в бейдже разворачивает список находок (сейчас
      поп-ап только читает), клик по находке — переход/подсветка соответствующего
      сообщения или вызова тула в ленте; (3) сводка «сколько уникальных значений,
      сколько вхождений, в какие цели ушло» с разделением «ушло провайдеру / не
      ушло (локально отфильтровано)»; (4) исторические записи без новых полей
      продолжают показывать старый агрегат (обратная совместимость —
      `assets/js/feed/history.ts:132`); (5) в Trace — связь находки с конкретным
      вызовом модели (перекрёстно с U20). Ветка `feat/dlp-redaction-details`;
      гейты: `tests/webui-dlp-indicator.test.ts`, `tests/security/data-policy*.test.ts`,
      новый `tests/webui/dlp-hits.test.ts` (позиции и метки приходят, оригиналов нет).
- [x] **U22 (P1) Сайдбар: вкладка «Безопасность» — живой журнал отловов.** Нужна
      отдельная вкладка рядом с Trace, где в реальном времени видно, что поймала
      защита: свежее сверху, у каждой строки — время, глиф класса (block / DLP /
      approval / SSRF), короткая суть и цель (тул, путь, URL, хост); клик по строке
      открывает поп-ап с деталями (полная причина, действие, тул, аргументы с
      уже применённой редакцией, DLP-находки этого хода, назначение
      «внешний/локальный», id сессии и id вызова для сверки с Trace).
      Что есть под это: `audit.jsonl` с записями `security_block` /
      `security_approval` (`src/modules/security/audit-log.ts:7-26`, `:186`, `:204`),
      по-сессионный каталог аудита (`setAuditSessionDir`) и `globalAuditNotifier`
      (`audit-notifier.ts:258`) — но последний по умолчанию **выключен**
      (`DEFAULT_AUDIT_NOTIFIER_CONFIG.enabled = false`), пишет только файл/webhook и
      не отдаёт событие в UI. Что требуется: (1) внутрипроцессный поток
      security-событий (не зависящий от webhook-нотификатора) — хук в `logAudit` или
      отдельный emitter, по образцу `OutputBus`; (2) SSE-событие `security` в
      `modules/webui/session/forward.ts` + бэкфилл из `audit.jsonl` при открытии
      сессии (та же дыра, что U3 — сейчас исторические события не поднимаются);
      (3) кольцевой буфер с капом на сессию (по образцу `TRACE_CAP`) и троттлинг
      батчами по кадру; (4) перевёрнутый список с автоприлипанием «пока читатель у
      свежей кромки» — переиспользовать контракт `assets/js/sidebar/trace-scroll.ts`
      (`traceAtFreshEdge`/`traceFollow`, кнопка «наверх»); (5) фильтры по классу и
      severity, счётчик непрочитанного на иконке вкладки; (6) в деталях —
      **никаких оригиналов** (INV-DLP-1): только маскированные значения, классы и
      позиции, как в U21. Ветка `feat/webui-security-log`; гейты:
      `tests/security/audit-*.test.ts`, `tests/arch/observability-coverage.test.ts`,
      новый `tests/webui/security-log.test.ts` (событие приходит из `logAudit`,
      кап соблюдён, порядок «свежее сверху», бэкфилл истории, оригиналов нет).


### 1.12 mma web — тестовые прогоны 2026-11-02

Отчёт: [`docs/agents/web-agent-test-report-2026-11-02.md`](./docs/agents/web-agent-test-report-2026-11-02.md).
Три живых прогона в браузере: nemotron (34 находки, сайт без стилей), MiMo (`400 Upstream
response was not valid JSON`), DeepSeek (styled-сайт, 30 маршрутов, корзина и фильтры
проверены вживую).

- [x] **MCP-тулы убраны из дефолтного набора** — тег `mcp` вместо `code`/`research`;
      65 → 40 тулов, MiMo перестал падать на втором ходе. Гейт:
      `tests/mcp-tool-tags.test.ts`.
- [x] **Guard обязательного path-аргумента** — `path: undefined` больше не создаёт файл
      `undefined`: fail-closed в `ToolExecutor.enforcePathArgs` по `parameters.required` +
      защита в `write_file`/`edit_file`. Гейт: `tests/tools/enforcement-path.test.ts`.
- [x] **Pre-write `checkDraft` через LSP** — типы проверять до записи (`LspConnection.syncDocument`
      + `diagnosticsFor`), при ошибке не писать файл или откатывать. _(2026-11-03:
      `runPreWriteCheck` в `lsp/write-check.ts` + `LspClient.checkContent`; тёплый
      сервер проверяет черновик `write_file`/`edit_file`, ошибки типов блокируют
      вызов (`lsp.draft_blocked`), холодный — fail-open с прогревом в фоне.
      Гейт `tests/modules/lsp/pre-write-check.test.ts`.)_ Долг F-18/F-19.
- [x] **Post-build гейт для веб-задач** — после `build` проверять, что CSS содержит
      utilities (`.grid`, `.flex`, `--tw-`) и страница не пустая. _(2026-11-03:
      check-kind `web-build:<dir>` — `checkWebBuild` ищет CSS/`index.html` в артефакте,
      требует Tailwind-утилиты и непустую страницу; путь резолвится через
      path-validator. Спека `docs/specs/2026-11-03-web-build-gate-design.md`, гейты
      `tests/modules/execution/web-build-check.test.ts`,
      `tests/execution/plan-checks-web-build.test.ts`.)_ Долг F-30/F-34.
- [x] **Финальный гейт по `typecheckFailures` без плана** — сейчас ошибки типов блокируют
      только `plan_step done`. _(2026-11-03: `runFinalAudit` при отсутствии плана и
      непустой карте `typecheckFailures` возвращает `passed:false` с файлами в
      `pendingSteps`; гейт `tests/modules/execution/final-typecheck-gate.test.ts`.)_ Долг F-21.
- [ ] **Localhost-проверки для веб-разработки** — `web_fetch`/`browser` блокируют localhost,
      `node`/`powershell` в blacklist; агенту нужен штатный путь проверить свой dev-сервер.
      Долг D-09.
- [x] **`--isolated` для MCP Playwright** — иначе «Browser is already in use», когда
      тестировщик держит свой Playwright. _(2026-11-03: зафиксировано в
      `docs/agents/testing.md` — `args: ["@playwright/mcp@latest", "--isolated"]`.)_ Долг D-10.
- [x] **Локальные изображения/заглушки** вместо внешнего picsum (403 в тестовой сети).
      _(2026-11-03: правило в `docs/agents/testing.md` — локальный SVG/заглушка в проекте.)_ Долг D-12.
- [ ] **Вложенный `AGENTS.md` и `.mma/`** — mma не читает `site/AGENTS.md` Next 16, а
      `.mma/` в корне ломает `create-next-app .`. Долг F-01/F-06.

---

## 2. Действия пользователя (не задачи для агента)

- [ ] Вернуть `contextWindow 64000` в реальном конфиге (`~/.mma`) — сейчас 32768
      (проверено 2026-10-30): `/config contextWindow 64000`.
- [x] Playwright MCP прописан в `~/.config/opencode/opencode.jsonc` (проверено
      2026-10-30) — действий не требуется.

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
      в CI; остаток раздутых файлов (п. 1.4).

---

## 4. Бэклог

- [ ] Подобрать литературу по верификации/критикам (вторая половина пункта
      «контр-агент для проверки работы»; сам контр-агент сделан — `src/modules/critic/`).
- [ ] Долги из [`docs/agents/debt.md`](./docs/agents/debt.md) — каждый оплачивается
      по своему триггеру (правило 9). Активных записей: 20.

---

## 5. Релиз

- Публикация — **только через GitHub Releases** (npm publish не используется).
- Версии в бете — только `0.x.y` (`1.0.0` запрещён, гвард `tests/version-beta.test.ts`).
- Релиз = обновление `CHANGELOG.md` + `package.json` → тег `vX.Y.Z` → GitHub Actions.
