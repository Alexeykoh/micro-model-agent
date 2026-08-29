# TODO — Micro Models Agent

## Актуальное

### Аудит логики агента — `docs/analysis/2026-08-29-agent-logic-audit.md`

Системный аудит (2026-08-29) поверх `model-control-fixes`: подтвердил статус 39 находок по текущему
коду + нашёл 10 новых (N-1…N-10). **Почти всё уже закрыто коммитами `af12430..HEAD`**
(ветка `fix/agent-logic-audit-2026-08-29`): N-1/N-2/N-3/N-4/N-5/N-6/N-7/N-8, R2-2/R2-3, #1/#13,
#6/#7/#8/#9/#11, Task 10, Wave 8 (21–29), Wave 9 (30–35).

**Открыто (по приоритету):**
- [ ] **Task 12** — FactualCheck rescan (низкий приоритет)

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

**Не пройдено (файловый обход продолжается):**
- [ ] Wave B: tools/ (bash 603, write/edit/read-file, subagent, web-*, browser tool)
- [ ] Wave C: execution module (module.ts 710, plan-tool 739, stuck-detector 845, auditor, verifier)
- [ ] Wave D: session/logger/i18n/ui (repl.ts 856, repl-commands 891, renderer, line-editor 893)
- [ ] Wave E: modules/security + processes + providers + mcp/pipelines/indexer/skills/plugins

Порядок выполнения фиксов: Wave 1 (контекст) → Wave 7 Tasks 15–17 (executor/MoE) → далее по волнам.
**Волны 1–9 закрыты** (см. аудит 2026-08-29). Релиз после волн: 0.56.0 (MINOR) → фактически выпущены 0.57.0/0.57.1.

### MoE Completion — план `docs/superpowers/plans/2026-08-26-moe-completion.md`

Цель: довести MoE из MVP до потенциально основного режима. Полный аудит дыр — в плане (§1).

**Сделано (Wave 1 + Wave 2, коммиты на master):**
- [x] **Plan 1.1** `47b00ae` — живой re-plan цикл в `runWithMoE` (`moe.maxReplanCycles`, default 3;
      лимит переехал из OrchestratorClient в вызывающего; каждый план ревалидируется;
      битый re-plan → честный partial failure; knownTags из реестра)
- [x] **Plan 1.2** `d000fa2` — input_from cross-expert data flow (`src/modules/execution/input-from.ts`;
      результаты зависимых сабтасков инжектятся в промпт, failed dep = `[FAILED]`;
      валидатор: неизвестный id → error, нет depends_on → autofix;
      DI-швы в runWithMoE вместо vi.mock — Bun-моки глобальны на процесс и ломают чужие тесты)
- [x] **Plan 2.1** — scope_request протокол (`src/tools/scope-request.ts`;
      ScopeDenialCollector в subagent детерминированно собирает path-denials →
      `<scope-request>` блок; Router approve/reject через
      `OrchestratorClient.resolveScopeRequest` (unparseable = reject);
      переисполнение только этого сабтаска; лимит 2 цикла)
- [x] **Plan 4.1** — Esc/interrupt в MoE (`AbortController` теперь создаётся в `run()`
      и протягивается signal'ом в runWithMoE/MoEExecutor; AbortError летит наверх без fallback;
      очередь сабтасков не стартует после прерывания)

Верификация после каждой волны: новые сюиты зелёные, tsc чисто,
полный прогон 1636 pass / 53 fail (= baseline flake, см. раздел ниже).

**Осталось:**

Wave 3:
- [ ] **Plan 3.1** — динамические эксперты в Router: `ExpertConfig.description`,
      список экспертов из `config.experts` рендерится в PLAN_SYSTEM_PROMPT вместо хардкода
      code/research/browser/vision (`orchestrator.ts:21-25`); knownTags уже из реестра (сделано в 1.1)
- [ ] **Plan 3.2** — оркестратор через ProviderManager: сейчас OrchestratorClient строит provider
      напрямую с захардкоженным contextWindow 32768 и без retry/rateLimits/failover entry.
      Legacy {type,baseUrl,apiKey} должен продолжать работать
- [ ] **Plan 4.2** — observability: события moe_plan/moe_subtask/moe_replan/moe_verify в session.jsonl
      (+ `session show`); sessionId реальный вместо хардкода "moe"; cost attribution per subtask
      (CostTracker.record per-provider уже умеет; нужен breakdown по expert_tag)

Wave 4:
- [ ] **Plan 5.1 Task 1** — StepVerifier.verifySubtaskCriteria: машиночитаемые success_criteria
      (file-exists, substring-in-file, command-exit-0) до merge; LLM-only критерии → warning
      в контекст verifyAndMerge
- [ ] **Plan 5.1 Task 2** — selective re-plan: executePlan(skipIds) — успешные сабтаски
      переносятся как carried, переисполняются только упавшие

Wave 5:
- [ ] **Plan 5.2** — cert suite tag=moe: 2 сценария (параллельные волны; read-after-write
      через input_from), config override moe.enabled+orchestrator, timeoutMs 600_000;
      обновить спеку (Draft → Implemented) и AGENTS.md; наблюдения → docs/small-model-observations.md

Definition of Done плана — в конце файла плана.

---

### Фаза 2+3: Multi-provider + provenance ✅ ЗАКОММИЧЕНО
- Ветка `providers`, коммит `2ed48c2`
- ProviderManager, hot-swap, CLI/REPL, caller provenance
- tsc чисто, 14+4 тестов проходят
- npm 0.45.0 опубликован (токен `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`)

---

### 53 падения в полном тест-сьюте (1403 pass / 53 fail / 1 skip)
Все предсуществующие. Не связаны с Phase 2+3.

#### Agent-тесты (36 fail) — КЛЮЧЕВАЯ ПРОБЛЕМА
- `tests/core/agent.test.ts` падает ТОЛЬКО в параллельном режиме `bun test`
- При `--parallel=1` или `--parallel=2/4/8` — ВСЕ agent-тесты проходят
- При `bun test` (без флагов) — 36 agent-тестов падают с `text:"done"` вместо预期
- Причина: `config.maxToolIterations=undefined` в параллельном воркере
- `createMockDeps()` создаёт объект локально, но `this.deps.config` оказывается другим объектом
- **Не воспроизводится** при запуске agent+любой другой файл по одному
- **Не воспроизводится** при `--parallel=N` (любое N)
- **Воспроизводится** только при `bun test` без флагов (дефолтный runner)
- **Гипотеза**: bun test runner при дефолтном запуске группирует файлы в воркеры иначе, чем при `--parallel=N`

#### Другие падения (17 fail)
- FactualCheck (1) — Windows path test
- grep alternation (1) — shell interference
- forbidden Windows command (1)
- BridgeDriver (3) — Playwright не установлен
- nested typecheck (2) — tsconfig в подпапке
- plan create guard (3)
- read_file (4) — path formatting
- Path Validator glob (1) — `**` pattern
- read_file output header (1)

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
- [ ] Прогнать `bun test` + `tsc --noEmit`, зафиксировать зелёное состояние как точку отсчёта.

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

- [ ] Порядок: сначала `agent.ts` (главный hotspot, fan-in 14), затем execution-модуль, потом CLI.
- [ ] Часть исключений задокументирована в AGENTS.md — не трогать без явного решения.

### Этап 3. Антипаттерны и дублирование
- [ ] Извлечь общий test-harness из интеграционных тестов (~1000 строк экономии, 26 копий scaffolding).
- [ ] Рефакторинг hotspot-функций: `createPlanToolDefinitions` (695), `bootstrap()` (438), `createProgram` (467).
- [ ] `console.*` в `repl-commands.ts` (126 вхождений) — консистентность с renderer/logger.

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
- Wave 1: Реструктуризация ядра + удаление дублирования
- Wave 2: DONE CONDITIONS + STOP directives + Session start protocol
- Wave 3: Failure classification в StuckDetector
- Wave 4: FORBIDDEN patterns (autoPlan или always — решить)

---

## Следующие шаги

1. **Разобраться с 53 падениями** (пользователь просил)
   - Agent-тесты: найти root cause конфликта bun parallel runners
   - bridge-тесты: установить Playwright или пропустить на CI
   - Остальные: по одному разобрать

2. **Git push**: нужен remote `master`, пока только `providers` ветка

3. **npm publish** — 0.46.0/0.47.0/0.56.0/0.57.0/0.57.1 уже выпущены (см. CHANGELOG). Следующий — после закрытия открытых пунктов аудита 2026-08-29.

---

## Бэклог

- [x] добавить поиск в интернете ошибки если более 5-ти раз не удается решить одну и ту же задачу
- [ ] добавить контр-агента который будет проверять выполнение работы. Нужно предоставить литературу
- [x] выполнить план исправлений код-ревью: `docs/superpowers/plans/2026-08-20-code-review-fixes.md` (22 задачи, 7 фаз: P0-баги, безопасность, изоляция тестов, производительность, мёртвый код/i18n, документация, релиз 0.47.0 — релиз 0.47.0 выпущен 2026-08-19)
