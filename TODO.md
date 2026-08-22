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
