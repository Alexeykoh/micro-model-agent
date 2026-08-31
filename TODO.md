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

- [x] Порядок: сначала `agent.ts` (главный hotspot, fan-in 14), затем execution-модуль, потом CLI.
      Выполнено: `d137280` (agent loop → модули), `788aea2` (plan handler → per-action),
      `8d1adb7` (registerMmaCommands → per-domain), `c5b4274` (createProgram + moe-executor dedup),
      `603db6c` (bash handler 236→~100). Остались: repl.ts, line-editor.ts, stuck-detector.ts, module.ts
- [ ] Часть исключений задокументирована в AGENTS.md — не трогать без явного решения.

### Этап 3. Антипаттерны и дублирование
- [ ] Извлечь общий test-harness из интеграционных тестов (~1000 строк экономии, 26 копий scaffolding).
- [~] Рефакторинг hotspot-функций: `createPlanToolDefinitions` (695), `bootstrap()` (438), `createProgram` (467)
      — частично: createProgram разбит (`c5b4274`), plan-definitions разбиты (`788aea2`); bootstrap() не тронут.
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

1. ~~**Разобраться с 53 падениями**~~ ✅ ЗАКРЫТО 2026-08-31 (см. выше)

2. **Git push**: нужен remote `master`, пока только `providers` ветка

3. **npm publish** — 0.46.0/0.47.0/0.56.0/0.57.0/0.57.1/0.57.2 выпущены (см. CHANGELOG, HEAD `a82d115`). Следующий — после закрытия открытых пунктов аудита 2026-08-29.

4. **Качество агентных прогонов — P5/P6 из аудита 2026-08-31** (`_testing/agent-quality-review-2026-08-31.md`; P0–P4 из того же аудита закрыты коммитами `7ff98dc`, `98dc7a2`):
   - [ ] **P5 — авто-сужение набора тулов**: тривиальный вопрос тянет все 23 схемы тулов (~3.1K токенов, ~9% окна 32K); tool narrowing (`enable_tools`) есть, но не применяется автоматически — сужать по типу задачи до первого LLM-вызова
   - [ ] **P6a — Unix-команды на Windows**: модель шлёт `find | head` в cmd.exe несмотря на hint в system prompt — кандидат: авто-конвертация или stub-ответ с hint'ом при характерной ошибке
   - [ ] **P6b — reasoning policy на тривиальных задачах**: уровень «medium» из policy назначается даже на Q&A в один тул — пересмотреть порог в reasoning-resolver

---

## Бэклог

- [x] добавить поиск в интернете ошибки если более 5-ти раз не удается решить одну и ту же задачу
- [ ] добавить контр-агента который будет проверять выполнение работы. Нужно предоставить литературу
- [x] выполнить план исправлений код-ревью: `docs/superpowers/plans/2026-08-20-code-review-fixes.md` (22 задачи, 7 фаз: P0-баги, безопасность, изоляция тестов, производительность, мёртвый код/i18n, документация, релиз 0.47.0 — релиз 0.47.0 выпущен 2026-08-19)
