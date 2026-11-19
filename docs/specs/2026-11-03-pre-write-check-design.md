# Pre-write LSP draft check — design

> **Дата:** 2026-11-03. Закрывает долг F-18/F-19 (TODO §1.12).

## Проблема

`write_file`/`edit_file` проверяли только синтаксис (bun/node) и уже писали
файл; ошибки типов обнаруживались постфактум. Модель тратила ход на
«записал → сломал → чини».

## Контракт

- `LspClient.checkContent(filePath, content, config, root, timeout)` — тот же
  протокол, что `checkFile`, но синхронизирует переданный черновик, не читая
  диск.
- `runPreWriteCheck(deps, ctx, call): Promise<string | null>` в
  `modules/lsp/write-check.ts`; вызывается из `onBeforeTool`.
- Блокирует (`string` с `lsp.draft_blocked`) только при диагностиках
  `severity=error`.
- Холодный сервер: `isWarm === false` → прогрев в фоне и `null` (fail-open,
  как у пост-проверки; 30-секундный старт не должен блокировать ход).
- Ошибка/таймаут сервера → `null` + `health.warn`/лог, запись разрешена.
- Черновик `edit_file` собирается из текущего файла и `old`/`new`; если
  реконструировать нельзя — проверка пропускается.

## Гейты

`tests/modules/lsp/pre-write-check.test.ts`: ошибки блокируют, чистый черновик
и не-write тулы проходят, холодный сервер fail-open.
