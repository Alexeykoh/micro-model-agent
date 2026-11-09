# Nested AGENTS.md + lazy .mma (F-01/F-06)

## Проблема

Отчёт `docs/archive/reports/web-agent-test-report-2026-11-02.md`:

- **F-01.** Вложенный `AGENTS.md` (Next 16) не читается: `agentsMdPaths()` в
  `src/core/bootstrap/state.ts` ищет только корень `baseDir`, проектный `.mma`
  и глобальный конфиг. В монорепозитории с корнем выше (`<root>/site/AGENTS.md`)
  агент работает без проектных правил.
- **F-06.** `.mma/` в корне workspace ломает `create-next-app .` (команда требует
  пустой каталог). Индексер при первом `buildIndex()` сразу пишет кэш в
  `<baseDir>/.mma/index-cache.json` (`src/modules/indexer/cache.ts:save`),
  создавая каталог до скаффолдинга.

## Решение

### F-01. Nested AGENTS.md discovery

`agentsMdPaths()` расширяется: после корневых кандидатов добавляются вложенные
`AGENTS.md`, найденные обходом `baseDir` до глубины 4, со скипом
`node_modules`, `.git`, `.next`, `.mma`, `dist`, `.cache`. Сохраняется приоритет:
корень → проектный `.mma` → вложенные (от меньшего к большему пути) → глобальный.
`loadAgentsMdBlocks()` помечает вложенные блоки меткой с относительным путём
(`AGENTS.md (site/)`), чтобы модель видела, к какому поддерева относится правило.
Кап: максимум 5 вложенных файлов. Веб-панель (`web-command.ts`) показывает все
найденные файлы через тот же `agentsMdPaths()`.

### F-06. Lazy .mma

`IndexCache.save()` не создаёт каталог и не пишет файл, если результат индекса
пустой (`result.files.length === 0`) — пустой workspace не получает `.mma/`
до первого реального наполнения. Прочие записи в проектный `.mma` (скиллы,
планы, NOTES) уже создаются только при использовании, трогать не нужно.
Тест: сборка индекса на пустом каталоге не создаёт `.mma/`.

## Проверка

- `tests/agents-md-nested.test.ts` — обход находит `site/AGENTS.md`, скипает
  `node_modules`/`.git`, приоритет корня выше вложенного, кап 5.
- `tests/indexer/lazy-mma.test.ts` — пустой индекс не создаёт `.mma/`, непустой создаёт.
- `bun test` + `bun run quality`.
