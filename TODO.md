# TODO — Micro Models Agent

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
- **P5 — авто-сужение набора тулов**: тривиальный запрос тянет все схемы (~3.1K токенов, ~9% окна 32K); сейчас `enableOnDemand:false` отдаёт полный набор. Приоритет высокий, но риск высокий (уже откатывали) — нужен дизайн, а не быстрый фикс.
- [x] ~~**System Prompt — DONE CONDITIONS**~~ ✅ в `buildSystemInfo` добавлены секции `DONE CONDITIONS` и `STOP AND ASK THE USER` (ветка `feat/system-prompt-done-conditions`). Остальные задачи плана `2026-08-27-system-prompt-optimization.md` (реструктуризация, failure classification, FORBIDDEN) — открыты.
- [x] ~~**Аудит волн B/C/D/E**~~ ✅ проведён 2026-09-25, отчёт `docs/analysis/2026-09-25-waves-bcde-audit.md`: 6 находок sev 4 (→ P0, исправлены), ~24 sev 3, ~25 sev 2. **Исправлено большинство** (ветка `fix/audit-waves-bcde`): sev 4 + stuck-детектор, plan-correctness, SSRF/секреты/symlink/injection, MCP reliability, read/process/pipeline-харды, skills CRLF, command-validator wrappers. Остаток — в P2 (см. «Остатки аудита»).
- **Linux watcher**: `walker.ts:97` `{ recursive: true }` без fallback — поднимать в P1 только если Linux в целевых платформах, иначе остаётся здесь как условный.

### P2 — техдолг и поддерживаемость
- [x] ~~**Остатки аудита волн B/C/D/E**~~ ✅ (2026-09-25) — sev 4/3/2 закрыты: `B-11` (trailing-newline total), `D-3` (локаль до `createProgram`), `D-7` (`rotateOldSessions` подключён), `D-8` (carry-over non-TTY), `E-15` (async `killTree`), i18n `B-12`/`C-14`/`D-9` (verifier/tools/CLI через `t()`, en+ru). Осознанно оставлено:
  - `B-13` прочие `catch {}` в `auto-fixer.ts`/`bash.ts`/`search-history.ts`/`scope-request.ts` — это намеренный control-flow с комментарием (парсинг с фолбэком / пропуск битой строки), не сокрытие ошибки; `syntax-validator` cleanup логируется.
  - `C-18` часть публичных методов `StuckDetector` (`classifyError`, `getHints`, `getToolAlternative`, …) и actionable-hints остаются англоязычными model-facing диагностиками (как system prompt) — сохранены как API/тесты.
- Дробление (правило ≤300): `repl-commands.ts` 1426, `agent.ts` 1338 (`executeSingleAgentLoop` ~665), `repl.ts` 1327, `line-editor.ts` 1068, `bootstrap.ts` 870, `stuck-detector.ts` 749, `module.ts` 750.
- Разорвать 2 цикла `browser/` (`driver ↔ session`).
- Извлечь общий test-harness (сейчас только `tests/helpers/webui-commands.ts`).
- Хардкод → абстракция: `BASH_GRACE_MS`, пути `.mma`, единый реестр `MMA_*`.
- Аудит `as any` (53) и глухих `catch {}`.

### P3 — гигиена и релиз
- Удалить `verify-tools.ts`; убрать `tsconfig-paths` (не используется); добавить `.fallowrc.json`.
- CI quality gate (`fallow --ci`), lint (Biome/ESLint), pre-commit hook.
- Русские комментарии/JSDoc (~76 файлов с кириллицей).
- README + `docs/` актуализация; `fallow security`.

### P4 — бэклог
- Автоназвание сессии по контексту (сейчас только ручной `rename`).
- Контр-агент для проверки работы (+ подобрать литературу).

## Актуальное

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
- [ ] Watcher на Linux не рекурсивный (`fs.watch recursive`) — автообновление только ручное

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
- [ ] Удалить `verify-tools.ts` в корне (не входит ни в одну сборку).
- [ ] `examples/plugins/*` — НЕ удалять (загружаются динамически), добавить suppress-конфиг в `.fallowrc.json`.
- [ ] Убрать `tsconfig-paths` из devDependencies (проверить bunfig).
- [ ] Разорвать 2 цикла в `src/modules/browser/` (общие типы → отдельный модуль).

### Этап 2. Дробление больших файлов (правило #1: ≤300 строк)

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
      `603db6c` (bash handler 236→~100). Остались: repl.ts, line-editor.ts, stuck-detector.ts, module.ts
- [ ] Часть исключений задокументирована в AGENTS.md — не трогать без явного решения.

### Этап 3. Антипаттерны и дублирование
- [ ] Извлечь общий test-harness из интеграционных тестов (~1000 строк экономии, 26 копий scaffolding).
- [~] Рефакторинг hotspot-функций: `createPlanToolDefinitions` (695), `bootstrap()` (438), `createProgram` (467)
      — частично: createProgram разбит (`c5b4274`), plan-definitions разбиты (`788aea2`); bootstrap() не тронут.
- [x] ~~`console.*` в `repl-commands.ts` (126 вхождений)~~ ✅ сейчас 0 вхождений (OutputChannel).

### Этап 4. Хардкод → абстракция
Аудит по категориям:
- [ ] Магические числа/таймауты вне конфига (`BASH_GRACE_MS`, лимиты строк и т.п.)
- [ ] Хардкод путей/имён файлов (`.mma/plans`, `audit.jsonl`)
- [ ] Строки пользователя мимо `t()` (правило #8) — особенно CLI-команды
- [ ] Env-переменные: единый реестр `MMA_*`

### Этап 5. Русские комментарии (финал)

Политика:
- JSDoc на русском для каждой экспортируемой функции/класса + файловый заголовок «что модуль делает»
- Внутренние комменты — только где логика неочевидна (инварианты, workaround'ы, «почему», а не «что»)
- Не комментировать тривиальное (`// геттер` — мусор)
- Перевести существующие английские комменты там, где они содержательные

Объём: ~110 файлов. Идти по слоям: core → llm → tools → modules → cli/ui.

### Дополнительно перед релизом
- [ ] CI quality gate: `fallow --ci --fail-on-regression` + baseline
- [ ] Линт: Biome/ESLint (strict, no-explicit-any, no-console кроме cli/)
- [ ] Аудит `any`/type-assertions (`rg "as any" src`)
- [ ] Обработка ошибок: найти глухие `catch {}`
- [ ] README + docs/ актуализация под текущую архитектуру
- [ ] CHANGELOG.md — вынести историю из AGENTS.md в стандартный формат
- [ ] Pre-commit hook: `fallow init --hooks` + typecheck на staged-файлы
- [ ] Безопасность: `fallow security` (command-injection, path-traversal — актуально для bash/path tools)

---

## System Prompt Optimization

**План:** `docs/superpowers/plans/2026-08-27-system-prompt-optimization.md`

Цель: перестроить `buildSystemInfo` для 9B моделей — уменьшить токены, улучшить читаемость, добавить недостающие директивы.

**6 задач, 4 волны:**
- Wave 1: Реструктуризация ядра + удаление дублирования — [ ] открыто (крупный рефактор промпта, нужен ручной прогон)
- Wave 2: [x] DONE CONDITIONS + STOP directives ✅ реализовано; [ ] Session start protocol — открыто
- Wave 3: [x] Failure classification в StuckDetector ✅ (`FailureType`/`classifyFailure`/`getStuckDiagnostic`, `[STUCK: type=…]` префикс recovery-сообщения); ветка `feat/failure-classification`. `scope_drift`/`empty_output` из плана не реализованы — нет надёжного сигнала.
- Wave 4: FORBIDDEN patterns (autoPlan или always — решить) — [ ] открыто

---

## Следующие шаги

1. ~~**Разобраться с 53 падениями**~~ ✅ ЗАКРЫТО 2026-08-31 (см. выше)

2. **Git push**: нужен remote `master`, пока только `providers` ветка

3. **npm publish** — 0.46.0/0.47.0/0.56.0/0.57.0/0.57.1/0.57.2 выпущены. За 2026-09-15 выпущены: **0.60.0** (session self-inspection + project map/indexing), **0.60.1** (уведомления о суммаризации промпта + i18n startup-логов), **0.61.0** (управление долями бюджета `mma context --system/--reserve` + честный overflow-совет).

4. **Качество агентных прогонов — P5/P6 из аудита 2026-08-31** (`_testing/agent-quality-review-2026-08-31.md`; P0–P4 из того же аудита закрыты коммитами `7ff98dc`, `98dc7a2`):
   - [ ] **P5 — авто-сужение набора тулов**: тривиальный вопрос тянет все 23 схемы тулов (~3.1K токенов, ~9% окна 32K); tool narrowing (`enable_tools`) есть, но не применяется автоматически — сужать по типу задачи до первого LLM-вызова
   - [x] ~~**P6a — Unix-команды на Windows**~~ ✅ реализовано: `windows-commands.ts` (hard-stop `<system-summary>`) + `bash.ts` `UNIX_TO_WIN_HINTS`/`FAILING_FIRST_WORDS`/`HARD_BLOCK_THRESHOLD`
   - [x] ~~**P6b — reasoning policy на тривиальных задачах**~~ ✅ baseline `"low"` + fallback на `reasoningConfig.min` вместо `"medium"`

---

## Бэклог

- [x] добавить поиск в интернете ошибки если более 5-ти раз не удается решить одну и ту же задачу
- [ ] **Автоназвание сессии по контексту** — сессия сама даёт себе осмысленное имя на основе содержания (первый запрос / накопленный контекст), вместо дефолтного/технического id; имя видно в `session list`/`session show`, вкладках `mma web` и `/export`.
- [ ] добавить контр-агента который будет проверять выполнение работы. Нужно предоставить литературу
- [x] выполнить план исправлений код-ревью: `docs/superpowers/plans/2026-08-20-code-review-fixes.md` (22 задачи, 7 фаз: P0-баги, безопасность, изоляция тестов, производительность, мёртвый код/i18n, документация, релиз 0.47.0 — релиз 0.47.0 выпущен 2026-08-19)
