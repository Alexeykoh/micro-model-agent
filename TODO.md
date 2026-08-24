# TODO — Micro Models Agent

## Актуальное

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

## Следующие шаги

1. **Разобраться с 53 падениями** (пользователь просил)
   - Agent-тесты: найти root cause конфликта bun parallel runners
   - bridge-тесты: установить Playwright или пропустить на CI
   - Остальные: по одному разобрать

2. **Git push**: нужен remote `master`, пока только `providers` ветка

3. **npm publish 0.46.0**: когда все тесты зелёные

---

## Бэклог

- [x] добавить поиск в интернете ошибки если более 5-ти раз не удается решить одну и ту же задачу
- [ ] добавить контр-агента который будет проверять выполнение работы. Нужно предоставить литературу
- [ ] выполнить план исправлений код-ревью: `docs/superpowers/plans/2026-08-20-code-review-fixes.md` (22 задачи, 7 фаз: P0-баги, безопасность, изоляция тестов, производительность, мёртвый код/i18n, документация, релиз 0.47.0)
