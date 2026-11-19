# Скиллы в системном промпте: топ-10 по использованию

**Дата:** 2026-11-03 · **Статус:** реализовано · **TODO:** §1.10

## Проблема

`SkillsModule.getCatalogBlock()` показывал до 40 имён в `[Available Skills]`.
Для 9B-модели с 32K–64K контекста это дорогой и шумный список: модель всё равно
не выбирает из сорока строк, а префикс промпта раздувается. При этом реально
используются единицы скиллов, и это уже видно по истории загрузок.

## Контракт

- Каталог в промпте содержит **не более 10 имён** (`CATALOG_LIMIT`).
- Порядок: сначала скиллы с ненулевым счётчиком использования (по убыванию
  счётчика, при равенстве — по имени), затем неиспользованные в порядке
  сканирования источников (builtin → global → project). Так поведение
  детерминировано, а новый скилл без истории не вытесняет используемые.
- Если доступных скиллов больше 10, добавляется строка
  `…and N more — call "load_skill" with a query to search by task.`
  и `degraded.reason` = `<N> more skills not listed`.
- Блок `[Loaded Skills]` не меняется.
- Полный список остаётся в `/skill list` (`getAvailable()`); промпт его не дублирует.
- Счётчик увеличивается **только на успешной загрузке** (`tryLoad`), не на
  повторной загрузке уже загруженного и не на неудачной (неизвестное имя,
  превышение бюджета).

## Ранжирование

`src/modules/skills/catalog.ts`:

- `rankSkills(skills, usage)` — пересечение `usage.topNames()` с доступными
  именами (записи о скиллах, которых больше нет на диске, игнорируются), затем
  остаток в исходном порядке.
- `buildCatalogBlock(skills, usage)` — собирает `PromptBlock` (тот же формат,
  что и раньше: `priority: "normal"`, `estimatedTokens` по `estimateTokens`).

## Персистентность

`src/modules/skills/usage.ts`, класс `SkillUsage`:

- Файл `<global>/.mma/skills-usage.json` (`globalMmaDir()` уважает
  `MMA_CONFIG_DIR`), формат `{ "version": 1, "counts": { "<name>": <int> } }`.
- API: `recordLoad(name)` · `count(name)` · `topNames(n)`.
- Пустые/нестроковые имена игнорируются; в файл попадают только count > 0.
- Нет файла или битый JSON → пустые счётчики, следующая запись перезаписывает.
- Запись best-effort и атомарная по возможности: temp-файл + `renameSync`;
  ошибка диска не ломает `load_skill`.

Bootstrap (`src/core/bootstrap/workspace-phase.ts`) создаёт `SkillUsage(globalMmaDir())`
и передаёт его четвёртым аргументом конструктора `SkillsModule`. Старые вызовы
без статистики остаются валидными (аргумент опциональный).

## Гейты

- `tests/modules/skills/usage.test.ts` — инкремент, persist/reload, битый файл,
  пустые имена, стабильный порядок `topNames`.
- `tests/modules/skills/catalog-top.test.ts` — 15 скиллов: в каталоге ровно
  топ-10 (11-го нет), строка «5 more», детерминированный fallback при нулевых
  счётчиках, `loadByName` пишет статистику.
- `tests/skills-loader.test.ts` — обновлённый кэп каталога (10 вместо 40).
- `bun run quality`: `tests/arch/file-size.test.ts` (новые файлы < 300 строк,
  `module.ts` не в allowlist) и остальные arch-гварды.
