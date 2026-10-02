# TODO — Micro Models Agent

## Web session state / изоляция сессий (2026-10-02)

> Аудит багов переключения вкладок в `mma web` (grill-me): первопричина — два
> представления «активной сессии» (клиентская вкладка vs `sessionManager.getActive()`)
> и сессионно-зависимые модуль-глобалы, оставшиеся от однo-сессионного ядра.
> Ветка работ: `docs/web-session-state` (документы), затем `feat/session-scope-isolation`
> и `feat/web-session-state`.

- **Спека (фундамент, P0-изоляция):** [docs/specs/2026-10-02-session-scope-isolation-design.md](./docs/specs/2026-10-02-session-scope-isolation-design.md)
  - P0-1 общий `Logger`/`sessionLogPath` + глобальный `_sessionAuditDir` (`session-logger.ts:30-43`, `audit-log.ts:27-51`)
  - P0-2 identity сессии провайдера привязана к main (`provider-phase.ts:193-197`)
  - P0-3 `OutputEvent` без `sessionId`, `defaultOutputBus` — синглтон (`log-forward.ts:27-41`)
  - P0-4 `SessionManager.create` удаляет чужие пустые сессии (`manager.ts:77-78`)
  - P0-5 команды не гейтятся busy и реконфигурят бегущие раннеры (`actions-api.ts:48-73`)
  - P0-6 глобальный kill-реестр процессов без сессии (`processes/runner.ts:8`)
- **План (фундамент):** [docs/plans/2026-10-02-session-scope-isolation.md](./docs/plans/2026-10-02-session-scope-isolation.md)
- **Спека (UI/state):** [docs/specs/2026-10-02-web-session-state-design.md](./docs/specs/2026-10-02-web-session-state-design.md)
  - Сайдбар от `getActive()` (`host-state.ts:76`), полный апдейт только по 2с-поллу (`app.js:343`)
  - `openTab` обновляет не всё (`tabs.js:248-260`); нет guard по `sessionId`; Trace не переключается
  - Нет loading-индикаторов Session/Plan/Usage; `sessionUsage` не персистится
- **План (UI/state):** [docs/plans/2026-10-02-web-session-state.md](./docs/plans/2026-10-02-web-session-state.md)
  - Обязательный задел: DOM-харнесс (`happy-dom`) — сейчас клиент проверяется только строковым матчингом (`webui-assets.test.ts:19-20`)

## Осталось (по приоритетам, 2026-09-25)

> Сверено с кодом на `master` @ 2.5.0. Закрытые пункты вычеркнуты ниже.
> Основание приоритета: влияние на реального пользователя + маленькую модель (32K/бюджет
> контекста/предсказуемость) vs. риск и объём работы.

### P0 — качество прогонов и фундамент
- **Безопасность/целостность (аудит волн B/C/D/E, sev 4)** — отчёт `docs/analysis/2026-09-25-waves-bcde-audit.md` — ✅ все 6 исправлены (ветка `fix/audit-waves-bcde`):
  - [x] ~~**W-1 (B-1/E-1)** `isPathWritable` без `escapesViaSymlink`~~ ✅ symlink-проверка добавлена в запись + канонизация ближайшего существующего предка (`path-validator.ts`).
  - [x] ~~**W-3 (E-2)** command injection в lint-on-write~~ ✅ `bun build`/`node --check` через `spawn(file,args)` без `shell`.
  - [x] ~~**W-4 (C-1)** `plan update` без валидации статуса~~ ✅ допустимы только `done|failed|skipped`, иначе отказ (`plan.bad_status`).
  - [x] ~~**W-5 (C-2)** ложный автозакрыт шагов~~ ✅ delete-шаги проверяются на отсутствие файлов, create — на непустое содержимое.
  - [x] ~~**W-2 (B-2)** MoE затирает scope в `undefined`~~ ✅ `getScope()` + compare-and-restore с реальным родительским scope.
  - [x] ~~**W-6 (E-4)** MCP-тулы не регистрируются~~ ✅ discovery параллельный и awaited до сборки реестра; late-success после таймаута отменяется.
- [x] ~~**P6b — reasoning baseline `"medium"` на тривиальных**~~ ✅ baseline теперь `"low"` (`defaults.ts`), резолвер падает на `reasoningConfig.min` вместо хардкода `"medium"`; policy по-прежнему поднимает до high на сигналах (ветка `fix/reasoning-baseline`).
- [x] ~~**Этап 0 — базовая линия**~~ ✅ `bun test` + `tsc --noEmit` зелёные, зафиксировано.
- [x] ~~**Валидация кэша индекса**~~ ✅ `index-cache.json` — envelope `{version,root,signature}`; `load()` сверяет SHA-1 сигнатуру дерева (`Indexer.scanSignature()`, stat-only) и отклоняет устаревший/легаси-кэш (ветка `fix/index-cache-validation`).

### P1 — поведение агента
- [x] ~~**P5 — авто-сужение набора тулов**~~ ✅ закрыто (ветка `feat/auto-tool-narrowing`): `enableOnDemand: true` по умолчанию + детерминированный пред-посев тегов по первому сообщению (`src/tools/auto-tags.ts`, только добавление, до первого LLM-вызова) + `question`/`approve`/`load_skill` → `alwaysOn`. Причина отката mitigation: hidden-tools блок, bash hidden-hint + redirect, пред-посев убирает нужду в `enable_tools`-roundtrip на веб-задачах.
- [x] ~~**System Prompt — DONE CONDITIONS**~~ ✅ в `buildSystemInfo` добавлены секции `DONE CONDITIONS` и `STOP AND ASK THE USER` (ветка `feat/system-prompt-done-conditions`). Остальные задачи плана `2026-08-27-system-prompt-optimization.md` (реструктуризация, failure classification, FORBIDDEN) — открыты.
- [x] ~~**Аудит волн B/C/D/E**~~ ✅ проведён 2026-09-25, отчёт `docs/analysis/2026-09-25-waves-bcde-audit.md`: 6 находок sev 4 (→ P0, исправлены), ~24 sev 3, ~25 sev 2. **Исправлено большинство** (ветка `fix/audit-waves-bcde`): sev 4 + stuck-детектор, plan-correctness, SSRF/секреты/symlink/injection, MCP reliability, read/process/pipeline-харды, skills CRLF, command-validator wrappers. Остаток — в P2 (см. «Остатки аудита»).
- **Linux watcher**: `walker.ts` `Indexer.watch()` — ✅ fallback добавлен (ветка `chore/small-tails`): `recursive: true` в try, при throw — per-dir non-recursive watch с игнорами (`watchNonRecursive`); `unwatch()` закрывает массив. Новые подкаталоги после `watch()` требуют ручного refresh — задокументировано в JSDoc.

### P2 — техдолг и поддерживаемость
- [x] ~~**Остатки аудита волн B/C/D/E**~~ ✅ (2026-09-25) — sev 4/3/2 закрыты: `B-11` (trailing-newline total), `D-3` (локаль до `createProgram`), `D-7` (`rotateOldSessions` подключён), `D-8` (carry-over non-TTY), `E-15` (async `killTree`), i18n `B-12`/`C-14`/`D-9` (verifier/tools/CLI через `t()`, en+ru). Осознанно оставлено:
  - `B-13` прочие `catch {}` в `auto-fixer.ts`/`bash.ts`/`search-history.ts`/`scope-request.ts` — это намеренный control-flow с комментарием (парсинг с фолбэком / пропуск битой строки), не сокрытие ошибки; `syntax-validator` cleanup логируется.
  - `C-18` часть публичных методов `StuckDetector` (`classifyError`, `getHints`, `getToolAlternative`, …) и actionable-hints остаются англоязычными model-facing диагностиками (как system prompt) — сохранены как API/тесты.
- [x] ~~Дробление (правило ≤300)~~ ✅ сделано там, где есть чистый шов: `bootstrap.ts` (`system-prompt.ts` вынесен) и `repl-commands.ts` (`/lsp`+`/skill` вынесены в `repl-commands-lsp/skills.ts`). **Принятые исключения** (решение 2026-09-25 — не трогать): `agent.ts`, `repl.ts`, `line-editor.ts`, `stuck-detector.ts`, `execution/module.ts`. Сверка 2026-09-28: все пять по-прежнему >>300 (agent 1582, repl 1450, line-editor 1162, stuck-detector 927, module 866; bootstrap снова 950, repl-commands 1368 — цифры 870→784 / 1425→~1170 устарели, суть «шовное дробление сделано» верна.
- [x] ~~Разорвать 2 цикла `browser/`~~ ✅ `ConsoleBuffer` → `console-buffer.ts`, `BrowserDriver`/`LaunchConfig`/`BrowserLaunchOverrides` → `driver-types.ts`; `driver`/`bridge-client` больше не импортируют `session`. fallow-baseline теперь пустой.
- [x] ~~Извлечь общий test-harness~~ ✅ `tests/helpers/webui-server.ts` (`webuiAssets`/`doFetch`/`withServer`/`postJson`); 15 webui-тестов на нём (сверка 2026-09-28; было 11). `tests/helpers/webui-commands.ts` уже был.
- [x] ~~Хардкод путей `.mma`~~ ✅ `src/config/paths.ts` (`MMA_DIR_NAME`, `globalMmaDir`, `globalConfigFile/Memory/Sessions/Logs/Exports/Plugins`, `projectMmaDir`); ~30 литералов заменены. Осталось (не критично): магические числа/таймауты вне конфига, единый реестр `MMA_*`.
- [x] ~~Аудит `as any` (53)~~ ✅ `as any` в коде `src/` — 0 (сверка 2026-09-28: 2 совпадения, оба — упоминания в комментариях, не код). `noExplicitAny` остаётся **warn** (в основном `: any` в сигнатурах, отдельный ratchet).

### P3 — гигиена и релиз
- [x] ~~Удалить `verify-tools.ts`; убрать `tsconfig-paths`; добавить `.fallowrc.json`~~ ✅ (ветка `chore/p3-hygiene`).
- [x] ~~CI quality gate + pre-commit hook~~ ✅: `.fallowrc.json` (+baseline `.fallow-baseline.json`, `src/modules/webui/assets/**` в ignore), npm-скрипты `quality`/`fallow`/`fallow:baseline`/`fallow:security`, workflow `.gitea/workflows/quality.yml` (typecheck + `bun test` + `fallow dead-code --baseline … --fail-on-issues`), git pre-commit hook (`fallow hooks install --target git`).
- [x] ~~`fallow security`~~ ✅ прогнан, триаж `docs/analysis/2026-09-25-fallow-security.md`: actionable-находок нет.
- [x] ~~**Lint (Biome)**~~ ✅ `@biomejs/biome` + `biome.json` (линтер, formatter/assist off — Prettier остаётся), `bun run lint`, включён в `quality` и CI. Правила-полировка: `noConsole` error (allowlist cli/output/ui), `noUnusedVariables/Imports/Unreachable` error; `noExplicitAny` — **warn** (186, ratchet до error отдельной задачей); осознанно off: `noNonNullAssertion`, `noAssignInExpressions`, control-char-regex, `useNodejsImportProtocol`, `noStaticOnlyClass`. Авто-фиксы применены по всему репо; заодно исправлен flaky тест encryption.
- [x] ~~README + `docs/` актуализация~~ ✅ README переписан под 2.6.0; `docs/mma-features-overview.md` поднят до 2.10.0 (секция «Что нового в 2.7.0–2.10.0», ветка `chore/small-tails`); `docs/agents/*` актуальны (AGENTS.md — канон).
- [x] ~~Русские комментарии/JSDoc~~ ✅ Этап 5 закрыт (ветка `chore/ru-jsdoc`, коммит `f03bedf`): 347 файлов — русские заголовки + JSDoc каждому экспорту, тривиальные удалены, код не тронут. Проверки: `tsc` 0, `biome` 0 errors, `bun test` 2813 pass / 0 fail.

### P4 — бэклог
- [x] ~~Автоназвание сессии по контексту~~ ✅ СДЕЛАНО (релиз 2.6.0): `deriveSessionName` + fire-and-forget `generateSessionTitle` в хуке `Agent.run()`, `session.autoName` (default true), `nameSource` (`auto` не затирает `manual`). Строка «только ручной `rename`» устарела (сверка 2026-09-28).
- [x] ~~Контр-агент для проверки работы (+ подобрать литературу)~~ ✅ v1 (ветка `feat/critic-agent`): in-loop `CriticGate` + `src/modules/critic/` (evidence pack + LLM-клиент, JSON-вердикт, fail-open), конфиг `critic.*`, события `critic_*` в `session.jsonl`; MoE не тронут. Дизайн: `docs/specs/2026-09-25-session-autoname-and-critic-design.md` §4, план `docs/superpowers/plans/2026-09-25-critic-agent.md`.
  - [x] ~~**Phase 2:** выделенный critic-провайдер (`critic.provider`/`critic.model` через `ProviderManager`)~~ ✅ (ветка `feat/critic-phase2`): `src/modules/critic/provider.ts` (managed-путь только при заданном `model`, битый оверрайд — warn + fallback на активный).
  - [x] ~~**Phase 2:** ограниченный read-only tool-loop для критика (`critic.tools`)~~ ✅ (ветка `feat/critic-phase2`): `src/modules/critic/tools.ts` (до 3 проверок `read_file`/`grep`/`glob`/`file_info`/`list_dir` через общий executor с allowlist), second-pass в `CriticClient.verify`, fail-open к первому вердикту.

## Актуальное

### Непрошеные md-файлы в некодовых задачах (сессия `ses_mukulpsv_is271g`, 2026-09-28, qwen3.5-9b)

**Симптом (живой прогон, не теория):** задача «подбери велосипед, задавай вопросы, найди варианты в интернете, больше ничего не требуется» → модель создала план 5 шагов и записала в рабочую папку два непрошеных файла: `profile_user.md` (профиль) и `recommendation.md` (170 строк, дублирует финальный ответ в чате). Плюс факты из памяти (ДР 20.01.1995, рост 183) утекли в эти файлы. Это НЕ косяк `question`-тула (он отработал штатно: 4 вопроса, батч-кап 3+1, ответы в память не ушли) — механика полностью старая, ниже.

**Почему (три источника в контексте):**
1. `ARTIFACTS` (`src/core/system-prompt.ts`): 9B переприменяет «создай файл, когда просят документ» на слова «итоговая рекомендация» — явного запроса файла не было, `SCOPE DISCIPLINE` («делай только то, что просили») проиграл.
2. Давление плана: `PLAN QUALITY` требует «шаг = конкретные deliverables (точные пути)», а гейт деливераблов (`plan-actions.ts:568-574`, `t("plan.no_deliverables")`, не `module.ts`) после каждого `done`-шага без файлов инжектит «шаг N не называет файлов — его выполнение нельзя проверить автоматически» + совет «добавить пути / запустить сборку/тесты» → модель материализует файлы, чтобы шаги стали «проверяемыми» (сверка 2026-09-28).
3. Нота гейта кодоцентрична («запусти сборку/тесты») — мусор в некодовой задаче.

**Что починить (вне скоупа ветки `feat/ask-interactive-tool`) — ✅ всё три закрыты отдельными ветками (сверка 2026-09-28):**
- [x] ~~`ARTIFACTS`: создавать файл только по явному запросу файла~~ ✅ `system-prompt.ts:21` («recommendation/summary/report alone = answer in chat»).
- [x] ~~Нота деливерабл-гейта~~ ✅ `plan.no_deliverables` (en+ru): проверять способом под задачу, НЕ создавать файлы ради деливераблов (ветка `fix/plan-note-pure-noncode`).
- [x] ~~Утечка памяти в workspace~~ ✅ `MEMORY PRIVACY` (`system-prompt.ts:25`): факты памяти в файлы только по явному запросу.

### ~~MMA Web — первый запуск (мастер настройки)~~ ✅ ЗАКРЫТО (2026-09-25), релиз 2.6.0

**Спека:** `docs/specs/2026-09-25-web-first-run-design.md` · **Ветка:** `feat/web-first-run` · **Слито в `master`** (`a6b9bfe`), запушено.

Проблема: `mma web` при виргин-конфиге лишь печатал `cli.first_run_oneshot` и стартовал на дефолтах
(`web-command.ts:80`); в терминале тот же случай запускает `runSetup()` (`main.ts:330`). Браузер
получал агента без провайдера/модели. Реализован вариант A — общее ядро setup на терминал и веб.

- [x] `src/modules/setup/{answers,apply,discovery}.ts`; `cli/setup.ts` / `cli/setup-order.ts` → re-export (тесты без изменений)
- [x] `webui/setup-api.ts`: `GET /api/setup`, `POST /api/setup/{scan,models,test,locale}`, `POST /api/setup`
- [x] `state.setupRequired` + серверный `409 setup_required` на `/api/message` и `/api/command`
- [x] Фронтенд: гейт `setup.js` (Language → Provider → Key → Model → Context → Security → Review), скрытие чата
- [x] Финиш: `applyAnswersToConfig` → `saveConfig` → `reconfigure` → reload
- [x] i18n `web.setup.*` (en+ru), стиль по STYLE.md
- [x] Тесты `tests/webui-setup.test.ts` + asset-level; `bun test` (2489 pass / 0 fail) + `tsc --noEmit` зелёные
- [x] Docs: AGENTS.md, CHANGELOG, версия 2.6.0 (MINOR)

### Баг: затенение i18n `t()` в web-фронтенде (2026-09-23) — исправлено (`08ae01a`)

- **Симптом:** вкладки сессий в `mma web` не рендерились вовсе (в топбаре — тонкие полоски); агент «не отвечал» на первый запрос (на деле первый прогон ~40с молча суммировал переполненный системный промпт).
- **Root cause (два):**
  1. `renderTabstrip` использовал `tabs.forEach((t) => …)` — параметр `t` затенял i18n-функцию `t()`, из-за чего `t("web.topbar.close")` бросал `TypeError: t is not a function` и вкладка не добавлялась. Тот же баг был в `loadHistory(t)` и `onPlan` (`const t`).
  2. Web-режим не подписывался на `OutputBus`, поэтому предупреждения (`Переполнение системного промпта`, суммаризация) в UI не показывались, а индикатор «думаю» появлялся только с первым LLM-событием.
- **Фикс:** переименован параметр в `item` (+ `loadHistory`/`onPlan`); добавлен `log-forward.ts` (совет: `OutputBus` warn/error → SSE `log`, секреты редакторятся); оптимистичный busy-индикатор сразу после `POST /api/message`.
- **Урок:** в этом файле i18n-функция называется `t` — не называть так локальные переменные/параметры. Рассмотреть линт-правило `no-shadow` для `t` в web-assets.

### Session self-inspection + project map/indexing — 0.60.0 (2026-09-15)

Реализовано (коммиты `ebbb70b..29818ef`):
- **`session_info`** (alwaysOn) — id/имя/модель/провайдер/контекст/сообщения + живое использование контекста; `SessionModule` prompt-блок починен (собирался при bootstrap с `messageCount === 0` → всегда `null`; теперь через `getDynamicPromptBlocks`, стабильный per-session).
- **i18n** для `prompt.overflow.*` (en+ru).
- **Карта проекта**: `selectMapFiles` (source > tests > docs/config, плотнейший code-каталог первым, детерминированно, cap 80) — раньше `slice(0,100)` в порядке обхода давал 0 файлов из `src/`.
- **Команда**: `mma map` / `/map` (summary|refresh|find).
- **Индексатор**: мультиязычный `IGNORE_DIRS` (venv/`.venv`/target/vendor/__pycache__/…), сегментный матчинг в watcher; реестр языков `symbols.ts` (TS/JS, Python, Rust, Go, Java, Kotlin, C#, Ruby, PHP, Swift, Scala, C/C++, Shell, Lua).

**Открытые хвосты по индексации:**
- [x] ~~Валидация кэша индекса (mtime/hash)~~ ✅ `IndexCache.load()` сверяет `version`/`root`/`signature`; устаревший или легаси-кэш → полный пересбор.
- [x] ~~Watcher на Linux не рекурсивный~~ ✅ закрыто в `chore/small-tails` (per-dir fallback, см. P1 выше); ограничение: новые подкаталоги после `watch()` — только ручной refresh

### Аудит логики агента — `docs/analysis/2026-08-29-agent-logic-audit.md`

Системный аудит (2026-08-29) поверх `model-control-fixes`: подтвердил статус 39 находок по текущему
коду + нашёл 10 новых (N-1…N-10). **Почти всё уже закрыто коммитами `af12430..HEAD`**
(ветка `fix/agent-logic-audit-2026-08-29`): N-1/N-2/N-3/N-4/N-5/N-6/N-7/N-8, R2-2/R2-3, #1/#13,
#6/#7/#8/#9/#11, Task 10, Wave 8 (21–29), Wave 9 (30–35).

**Открыто (по приоритету):**
- [x] ~~**Task 12** — FactualCheck rescan~~ ✅ реализован: `factual.ts` `RESCAN_COOLDOWN_MS` + one-off rescan; аудит 2026-08-29 признал не-багом

### Аудит агента + план исправлений — `docs/superpowers/plans/2026-08-26-model-control-fixes.md`

Системный аудит «как агент управляет моделью» (2026-08-26). 4 раунда, **39 находок** (оценки 1–5),
**35 задач в 9 волнах**, реестр находок с файлами/строками — всё в плане.

**Пройдено:**
- [x] Round 1 — ядро (`agent.ts`, `openai-compat.ts`, `context/manager.ts`, hallucination, reasoning):
      15 находок. Критичные: аргументы тулов не обрезаются в summary (#1), мёртвый reasoning-полиси (#2),
      set_thinking не влияет на запросы (#3), компакция рвёт tool-call пары (#4) → Wave 1–6
- [x] Round 2 — executor/MoE/chunk-query: 6 находок. Таймер таймаута тула выполняет cleanup
      ТЕКУЩЕГО вызова через 60s после успеха (R2-1); MoE теряет onTool и не пишет ответ в
      контекст/историю (R2-2/3) → Wave 7 (Tasks 15–20)
- [x] Round 3 — инициализация (`main.ts`, `bootstrap.ts`): 10 находок. Тулы читают протухший
      toolCtx.config после reconfigure (B1); опечатка субкоманды уходит модели как промпт (M1);
      --json нарушает контракт при throw (M2); кириллический AGENTS.md молча выпадает из
      системного промпта из-за len/4 оценок (B3) → Wave 8 (Tasks 21–29)
- [x] Round 4 — config-слой (`config.ts`, `providers/manager.ts`, `domains.ts`, migration):
      8 находок. MMA_PROVIDER_* env-overrides игнорируются при entries[] → cert harness тестирует
      не того провайдера (C1); миграция удаляет живой конфиг по эвристике «нет одного поля = v1»,
      backupAll существует но не вызывается (C2); toConfig() затирает provider.fallback (C3);
      env-значения персистятся навсегда (C4) → Wave 9 (Tasks 30–35)

**Файловый обход B/C/D/E выполнен** отдельным аудитом 2026-09-25 (см. P0/P1/P2 и
`docs/analysis/2026-09-25-waves-bcde-audit.md`):
- [x] Wave B: tools/
- [x] Wave C: execution module
- [x] Wave D: session/logger/i18n/ui
- [x] Wave E: modules/security + processes + providers + mcp/pipelines/indexer/skills/plugins

Порядок выполнения фиксов: Wave 1 (контекст) → Wave 7 Tasks 15–17 (executor/MoE) → далее по волнам.
**Волны 1–9 закрыты** (см. аудит 2026-08-29). Релиз после волн: 0.56.0 (MINOR) → фактически выпущены 0.57.0/0.57.1.

### MoE Completion — план `docs/superpowers/plans/2026-08-26-moe-completion.md` ✅ ЗАКРЫТО (2026-08-31)

Все волны выполнены, релиз **0.58.0** (коммит `f069fba`). Итог:

- **Wave 1–2:** re-plan цикл, input_from, scope_request, abort
- **Plan 3.1:** динамические эксперты из `config.experts` (`ExpertConfig.description`) в PLAN_SYSTEM_PROMPT
- **Plan 3.2:** OrchestratorClient через ProviderManager (per-entry contextWindow/retry/rateLimits, failover, legacy работает)
- **Plan 4.2:** moe_plan/moe_subtask/moe_replan/moe_verify в session.jsonl (+ `session show`), usage по expert_tag, реальный sessionId
- **Plan 5.1:** StepVerifier.verifySubtaskCriteria (file-exists / substring-in-file / command-exit-0; LLM-only → warning) + selective re-plan (skipIds/carriedResults)
- **Plan 5.2:** cert-сценарии 5.1-moe-basic, 5.2-moe-parallel-waves, 5.3-moe-read-after-write; спека Draft → Implemented; раздел MoE в AGENTS.md

---

### Фаза 2+3: Multi-provider + provenance ✅ ЗАКОММИЧЕНО
- Ветка `providers`, коммит `2ed48c2`
- ProviderManager, hot-swap, CLI/REPL, caller provenance
- tsc чисто, 14+4 тестов проходят
- npm 0.45.0 опубликован (токен `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`)

---

### 53 падения в полном тест-сьюте ✅ ЗАКРЫТО (2026-08-31)

**Результат:** 1782 pass / 0 fail / 1 skip — полный suite зелёный в дефолтном `bun test`.

Root cause параллельных падений: `vi.mock` в Bun **глобален на процесс** — мок модуля
в одном тест-файле подменял импорты во всех остальных файлах воркера. Большинство
старых падений закрыли предыдущие фиксы (DI-швы, agent-тесты); последние 8
(moe-replan/moe-abort) — из `agent-moe-write.test.ts` (vi.mock agent-moe) и
`subagent.test.ts` (vi.mock Agent).

Фикс: DI-швы вместо vi.mock — `AgentDeps.runWithMoEOverride` (src/core/agent.ts),
`ToolContext.agentFactory` (src/tools/types.ts → src/tools/subagent.ts).

---

## Подготовка к продакшену: план чистки кода

> Составлено по данным fallow 2.88.0 (health / dead-code / dupes) + скан файлов.
> Ключевая метрика: **комменты — последний этап**, документировать до рефакторинга бессмысленно.

### Текущее состояние

| Метрика | Значение |
|---|---|
| Файлов в `src/` | 220 (.ts), ~69K строк с тестами |
| Файлов с построчными комментами | 109 из 220 |
| С русскими комментами | 7 из 220 |
| Мёртвый код | 12 неиспользуемых файлов, 25 экспортов, 1 devDep (`tsconfig-paths`) |
| Циклические зависимости | 2 (browser: `driver ↔ session ↔ bridge-client`) |
| Дублирование | 11.2% (в основном интеграционные тесты) |
| Здоровье | maintainability 90/100; 41 функция критичной сложности |

### Этап 0. Базовая линия
- [x] ~~Прогнать `bun test` + `tsc --noEmit`~~ ✅ зелёное зафиксировано (2537 pass / 0 fail).

### Этап 1. Мёртвый код (быстрая победа)
- [x] ~~Удалить `verify-tools.ts` в корне~~ ✅ удалён (сверка 2026-09-28: файла нет).
- [x] ~~`examples/plugins/*` suppress~~ ✅ `examples/plugins/**` в `ignorePatterns` `.fallowrc.json`.
- [x] ~~Убрать `tsconfig-paths` из devDependencies~~ ✅ в `package.json` отсутствует (остался только транзитивным в `package-lock.json`).
- [x] ~~Разорвать 2 цикла в `src/modules/browser/`~~ ✅ общие типы вынесены (`console-buffer.ts`, `driver-types.ts`).

### Этап 2. Дробление больших файлов (правило #1: ≤300 строк)

> Замеры 2026-09-28 (фактические, `Get-Content .Count`): agent.ts 1582, repl-commands.ts 1368, repl.ts 1450, line-editor.ts 1162, stuck-detector.ts 927, module.ts 866, plan-tool.ts ужался до 300. Таблица ниже — историческая (на момент плана), актуальные размеры выше; исключения — в AGENTS.md «Large files — accepted exceptions».

| Файл | Строк | Крупнейшая функция |
|---|---|---|
| `src/core/agent.ts` | 1230 | `executeSingleAgentLoop` — 779 строк! |
| `src/cli/repl-commands.ts` | 819 | `registerMmaCommands` — 508 |
| `src/ui/line-editor.ts` | 819 | `onKey` — 187 |
| `src/cli/repl.ts` | 787 | `start` — 157 |
| `src/modules/execution/stuck-detector.ts` | 764 | — |
| `src/modules/execution/plan-tool.ts` | 722 | `handler` — 517 |
| `src/modules/execution/module.ts` | 665 | — |

- [x] Порядок: сначала `agent.ts` (главный hotspot, fan-in 14), затем execution-модуль, потом CLI.
      Выполнено: `d137280` (agent loop → модули), `788aea2` (plan handler → per-action),
      `8d1adb7` (registerMmaCommands → per-domain), `c5b4274` (createProgram + moe-executor dedup),
      `603db6c` (bash handler 236→~100). Остаток — осознанные исключения (см. AGENTS.md), не трогать.
- [x] ~~Исключения задокументированы в AGENTS.md~~ ✅ repl.ts, line-editor.ts, stuck-detector.ts, module.ts (+ registry-extra.ts, settings-api.ts) — не трогать без явного решения.

### Этап 3. Антипаттерны и дублирование
- [x] ~~Извлечь общий test-harness~~ ✅ `tests/helpers/webui-server.ts` + `webui-commands.ts` (см. P2 выше).
- [x] ~~Рефакторинг hotspot-функций~~ ✅ закрыт полностью (ветка `chore/etap4-tails`):
  `bootstrap()` разбит на `src/core/bootstrap/*.ts` (7 фаз-модулей, оркестратор 169 строк).
- [x] ~~`console.*` в `repl-commands.ts` (126 вхождений)~~ ✅ сейчас 0 вхождений (OutputChannel).

### Этап 4. Хардкод → абстракция — ✅ ЗАКРЫТ (ветка `chore/etap4-tails`, 2026-09-28)
- [x] ~~Магические числа/таймауты~~ ✅ `src/config/timeouts.ts` — 27 канонических `*_MS`, модули импортируют (публичные имена сохранены алиасами, поведение 1:1).
- [x] ~~Хардкод путей~~ ✅ `auditLogFile(dir)` в `src/config/paths.ts` (остальные пути уже централизованы).
- [x] ~~Строки мимо `t()`~~ ✅ CLI-литералы переведены (26 новых `cli.*` ключей en+ru, en-тексты 1:1).
- [x] ~~Env-переменные: единый реестр `MMA_*`~~ ✅ `src/config/env.ts` (`MMA_ENV` + `readEnv`, чтение в момент вызова, без кеширования).
- Попутно: общий `settleChildClose` (`src/utils/child-run.ts`) убрал fallow-клон в verifier/syntax-validator/lint-on-write; `setupModulesPhase` нарезан на хелперы (гейт `fallow audit` зелёный).
- Проверки: `tsc` 0, `biome` 0 errors, `bun test` 2818 pass / 0 fail.

### Этап 5. Русские комментарии (финал) — ✅ ЗАКРЫТ (ветка `chore/ru-jsdoc`, 2026-09-28)

Политика (выполнена):
- JSDoc на русском для каждой экспортируемой функции/класса + файловый заголовок «что модуль делает»
- Внутренние комменты — только где логика неочевидна (инварианты, workaround'ы, «почему», а не «что»)
- Не комментировать тривиальное (`// геттер` — мусор)
- Перевести существующие английские комменты там, где они содержательные

Итог: 347 файлов `src/` (6 слоёв параллельными агентами + добор вручную), код не тронут;
`tsc` 0, `biome` 0 errors, `bun test` 2813 pass / 0 fail. Подробнее — P3 выше.

### Дополнительно перед релизом — ✅ всё закрыто (сверка 2026-09-28, см. P3 выше)
- [x] ~~CI quality gate~~ ✅ `.gitea/workflows/quality.yml` + baseline; ~~Линт~~ ✅ Biome; ~~`as any`~~ ✅ 0 в коде `src/`;
  ~~глухие `catch {}`~~ ✅ триаж (намеренный control-flow); ~~README + docs/~~ ✅; ~~CHANGELOG~~ ✅;
  ~~pre-commit hook~~ ✅; ~~`fallow security`~~ ✅ триаж без actionable-находок.

---

## System Prompt Optimization

**План:** `docs/superpowers/plans/2026-08-27-system-prompt-optimization.md`

Цель: перестроить `buildSystemInfo` для 9B моделей — уменьшить токены, улучшить читаемость, добавить недостающие директивы.

**6 задач, 4 волны (ветка `feat/system-prompt-waves`, сверка 2026-09-28):**
- Wave 1: [x] ~~Реструктуризация ядра + удаление дублирования~~ ✅ `system-prompt.ts`: секции `HEADER:` + буллеты ≤120 символов (было 20/21 строк >120, max 608); токены −22% (1744→1360, замер `estimateTokens`, win32+autoPlan); `Design: YAGNI/KISS/DRY` удалён (дубль AGENTS.md, Task 2).
- Wave 2: [x] DONE CONDITIONS + STOP directives ✅ реализовано; [x] ~~Session start protocol~~ ✅ секция `SESSION START` в системном промпте (inspect → baseline только для code-задач → trivial chat без baseline). Решение развилки: system prompt, не plugin-hook (нулевой механики, условная формулировка не грузит тривиальные чаты).
- Wave 3: [x] Failure classification в StuckDetector ✅ (`FailureType`/`classifyFailure`/`getStuckDiagnostic`, `[STUCK: type=…]` префикс recovery-сообщения); ветка `feat/failure-classification`. `scope_drift`/`empty_output` из плана не реализованы — нет надёжного сигнала.
- Wave 4: [x] ~~FORBIDDEN patterns~~ ✅ always-on компакт (4 строки-«never» как индекс к ARTIFACTS/VERIFY/WORK; autoPlan-gate отклонён — анти-паттерны важны и в тривиальных задачах). Решение развилки: always.

---

## Следующие шаги

1. ~~**Разобраться с 53 падениями**~~ ✅ ЗАКРЫТО 2026-08-31 (см. выше)

2. ~~**Git push**~~ ✅ ЗАКРЫТО: remote `origin` есть, ветка `master` (сверка 2026-09-28).

3. **npm publish** — актуальная версия **2.10.0** (сверка 2026-09-28; перечисленные 0.46.0–0.61.0 давно выпущены, CHANGELOG покрывает 0.62.0→2.10.0).

4. **Качество агентных прогонов — P5/P6 из аудита 2026-08-31** (`_testing/agent-quality-review-2026-08-31.md`; P0–P4 из того же аудита закрыты коммитами `7ff98dc`, `98dc7a2`):
    - [x] ~~**P5 — авто-сужение набора тулов**~~ ✅ см. выше (ветка `feat/auto-tool-narrowing`)
   - [x] ~~**P6a — Unix-команды на Windows**~~ ✅ реализовано: `windows-commands.ts` (hard-stop `<system-summary>`) + `bash.ts` `UNIX_TO_WIN_HINTS`/`FAILING_FIRST_WORDS`/`HARD_BLOCK_THRESHOLD`
   - [x] ~~**P6b — reasoning policy на тривиальных задачах**~~ ✅ baseline `"low"` + fallback на `reasoningConfig.min` вместо `"medium"`

---

## Бэклог

- [x] добавить поиск в интернете ошибки если более 5-ти раз не удается решить одну и ту же задачу
- [x] ~~**Автоназвание сессии по контексту**~~ ✅ см. P4 выше (релиз 2.6.0) — пункт бэклога закрыт.
- [x] ~~контр-агент для проверки работы~~ ✅ сделан (in-loop `CriticGate`, v1 + Phase 2 — см. P4 выше).
  **Открыта только вторая половина пункта — подобрать литературу** по верификации/критикам.
- [x] выполнить план исправлений код-ревью: `docs/superpowers/plans/2026-08-20-code-review-fixes.md` (22 задачи, 7 фаз: P0-баги, безопасность, изоляция тестов, производительность, мёртвый код/i18n, документация, релиз 0.47.0 — релиз 0.47.0 выпущен 2026-08-19)


## Остаток на 2026-09-26 (web UI / провайдеры) — сверка 2026-09-28

- [x] ~~**Вложенный поп-ап добавления и настройки провайдера**~~ ✅ ЗАКРЫТО иначе: `#providerOverlay`/`openProviderForm`/`hideProviderOverlay` в коде больше нет (0 совпадений в `src/`) — заменено общим вложенным диалогом `#subOverlay`/`openSubDialog` (`index.html:169`, `settings.js:1692`; провайдер/MCP/LSP/память через него). Проверено e2e-харнессом (`tests/e2e/web-provider-dialog.e2e-test.ts`: селекторы `#subOverlay.open`, open/Esc/backdrop/save; `bun run test:e2e`). Отдельный Playwright-прогон «вручную в headed» и коммит старого поп-апа больше не требуются.
- [ ] **Состояние реального конфига** (`~/.mma`, действие пользователя, не ветка): `provider` сейчас — легаси `openai-compat` / `http://localhost:1234/v1`,
  модель `qwen/qwen3.5-9b`, `contextWindow 32768`. Ранее просили **64000** — вернуть при необходимости
  (`/config contextWindow 64000`).
- [ ] **Playwright MCP в opencode** прописан (`~/.config/opencode/opencode.jsonc`), но инструменты появляются
  только после **рестарта opencode** (действие пользователя).
- [x] Фикс: список моделей следует за активным провайдером (refresh on reconfigure).
- [x] Фикс: добавление провайдера не затирает легаси-конфиг (seed `entries[0]`).

- [x] (2026-09-26) Нормально тестировать web UI: `bun run web:dev` (watch + live asset reload),
  изолированный `MMA_CONFIG_DIR` e2e-харнесс (`tests/e2e/web-harness.ts`, реальный `mma web` дочерним
  процессом, реальный `~/.mma` не затрагивается), Playwright-сценарии с артефактами
  (`tests/e2e/web-provider-dialog.e2e-test.ts`: boot + вложенный поп-ап провайдера —
  open/Esc/backdrop/save; артефакты в `_testing/web-e2e/<scenario>/`), запуск `bun run test:e2e`
  (`vitest.e2e.config.ts`, только по явной просьбе). Ветка `chore/web-e2e-harness`.

## Production readiness — gap-анализ (2026-09-28)

> Полная спека: [docs/specs/2026-09-28-production-readiness-design.md](./docs/specs/2026-09-28-production-readiness-design.md).
> Сверено: `master` @ 2.10.0 vs. MLflow 05.2026 / Alice Labs 08–09.2026 / Arthur 05.2026 / OWASP LLM01+AST10 / EU AI Act (high-risk с 02.08.2026).
> Вывод: MMA — зрелый single-user dev-харнесс; до продакшена не хватает 6/6 условий Alice Labs
> (durable state, trace-observability, архитектурные guardrails, HITL-gates, cost caps upstream, rollback артефактом).
> Каждый пункт ниже — отдельная ветка от актуального `master` (`bun test` + `tsc --noEmit` зелёные).

### P0 — без этого в прод нельзя
- [ ] **1. Изоляция исполнения** — `bash`/тулы бегут на хосте (`execa`); cert-«sandbox» — лишь temp-папки. Ввести `execution.profile: local-trusted|sandbox`, sandbox с deny-by-default egress, угрозу задокументировать.
- [ ] **2. Durable state** — `session.jsonl` не переживает краш посреди хода. Опциональный checkpointer (Postgres-совместимый интерфейс), стабильный `thread_id` <255, prune по retention, long-term store с TTL.
- [ ] **3. Observability (OTel)** — нет GenAI-спанов и внешнего бэкенда. Adapter над `gen_ai.*` v1.41, OTLP-экспорт, метрики faithfulness/drift/bypass, связка trace↔session↔cost↔approvals.
- [ ] **4. Evals в контуре + staged rollout** — cert проверяет harness, не продукт. Eval-набор с trajectory-оценкой, ensemble-судья + human-gold, eval-gate в CI, стадии shadow→canary→percentage→full, скоркард (success/cost/p95/safety).

### P1 — управляемость
- [ ] **5. Cost/LLM-gateway** — счёт есть, enforcement нет. Per-run бюджет, `max_turns` hard-stop, per-tenant caps до вызова модели, intent-routing, cache-anchoring промпта.
- [ ] **6. MCP/plugin supply-chain** — нет OAuth 2.1 per-user и gateway с allowlist/rate-limit, нет signed skill-манифестов/SBOM, спек MCP устаревает.
- [ ] **7. HITL + kill-switch** — `question`/`approve` не переживают рестарт. Durable `interrupt()`, escalation по impact, oversight-панель (задел Art.14), глобальный kill-switch.
- [ ] **8. Поставка и эксплуатация** — нет Dockerfile/K8s/`/healthz`, релиз не артефакт. Манифест (prompt+model+tools+evals), откат одной командой, RBAC/тенанты заделом, SLO + runbook 6 классов.

### P2 — зрелость
- [ ] **9. Compliance (EU AI Act)** — логи без подписи, нет артефактов high-risk (risk file, lineage, oversight-панель, adversarial-лог Art.15). Append-only + подпись, retention ≥6 мес.
- [ ] **10. Внутренние хвосты** — overview поднят до 2.10.0 ✅, Linux watcher fallback ✅, русские комменты ✅,
  Этап 3 (bootstrap) ✅, Этап 4 ✅ (всё — 2026-09-28).
  Осталось: 5 файлов >>300 строк (осознанные исключения, только чистые швы);
  `noExplicitAny` warn-ratchet; coverage-threshold в CI.

## Новое (2026-10-01)

- [x] ~~**Очередь сообщений для WebUI**~~ ✅ (ветка `feat/webui-message-queue`): сообщение во время хода встаёт в очередь (`202 {queued: n}`, кап 5, хвост `429 queue_full`) и выполняется следующим ходом по `turn_end`; дренаж через single-flight сабмит, `queueLen` в `/api/state` и SSE `state`, pending-квитанция в ленте.
- [x] ~~**Разобраться с пост-задачной генерацией**~~ ✅ (ветка `fix/post-task-generation`): живой прогон qwen3.5-9b + разбор `session.jsonl` показал главный ложный механизм — success-claim ветировал честное «тесты прошли» из-за stale-ошибки `plan re-plan` (сессия `ses_mupgenhq_75f66l`); `checkSuccessClaim` больше не учитывает фейлы тулов-блокнота (`plan`/`plan_step`/`todo`, их полисит финальный аудит). Критик-`critical` в том же прогоне был прав (тесты правда не запускались) — не тронут.
- [x] ~~**Трассировка: расширить покрытие + текст модели в деталях**~~ ✅ (ветка `feat/webui-trace-expansion`): живые строки status (SSE `meta`), log (минус info-diagnostic), retract, index (start/done/error); critic/MoE/compaction/probe/usage/audit/claim_retry/output — докачка из `session.jsonl` (`GET /api/sessions/:id/log`, инкремент на `turn_end`, без новых продюсеров); `turn_end` несёт серверный `turnSeq`; деталь текста — полный текст хода (кап 20K) + сверка с логом (assistant/итерации/модель/токены). Git-операции отдельно не выделяются (хрупкая эвристика) — команда видна в строке `bash`. Осознанно не сделано: ответы на `question` (события нет), reason-чейн в Trace (шум чанков).

### Follow-up аудита сессии `ses_mup6p61q_yoope2` (2026-10-01)

Контекст: разбор боевой сессии (сегментная полоса контекста, 175 LLM-вызовов / 20.1M токенов на коммит +230/−5). P0–P1 закрыты веткой `fix/session-audit-harness-fixes` (CHANGELOG `[Unreleased]`). Ниже — три отложенных пункта.

- [x] ~~**Протухание `/api/i18n` на живом сервере**~~ ✅ (ветка `feat/webui-i18n-stale`): `GET /api/i18n` и снапшот состояния несут `i18nStale` (mtime словарей на диске новее старта процесса); топбар показывает жёлтый бейдж с кнопкой reload вместо молчаливых сырых ключей. Ключи `web.i18n.stale/reload` (en+ru).
- [x] ~~**Сверка терминологии частей контекста терминал vs web**~~ ✅ (ветка `fix/context-parts-terminology`): зафиксировано осознанное расхождение — web-легенда показывает *использование* (подписи одобрены пользователем, EN `dialogue` оставлен как перевод одобренного «диалог»), терминальный баннер — *бюджеты*, но теперь локализован (`repl.ctx_part_system/reserve/history`: `system/reserve/history` + `система/резерв/история` вместо непереведённых `sys/res/hist`).
- [x] ~~**Изоляция проверочных web-серверов + гайд браузерной верификации**~~ ✅ (ветка `docs/verification-hygiene`): правило ушло в читаемые моделью места — системный промпт (`MMA_CONFIG_DIR=<empty tmp dir>`, никогда против живого сервера пользователя) + описание browser-тула (без vision — snapshot-текст и DOM/API-ассерты `/api/*` вместо вождения браузера). Тесты: `tests/core/bootstrap.test.ts`, `tests/tools/browser.test.ts`.
