# Откат правок файлов агентом — дизайн

- Дата: 2026-11-24
- Статус: дизайн согласован, ожидается ревью спецификации перед планом реализации
- Ветка: `feat/file-rollback` (создана из HEAD `10e13d45`, локальный `dev` отстаёт на 47 коммитов)
- Публичный контракт: новый порт в `ToolContext`, новые тулы, новые ключи конфига, новый формат данных в папке сессии — спека обязательна (правило 2 AGENTS.md).

## 1. Проблема и цель

Агент пишет файлы напрямую (`writeFileSync`/`unlinkSync` в `src/tools/*`). Сейчас после неудачной правки нет ни версий, ни отката: в `session.jsonl` сохраняется только `diff` с тремя строками контекста, полное старое содержимое теряется. Чекпоинт сессии (`src/modules/session/checkpoint.ts`) хранит счётчики хода, а не файлы.

**Цель:** дать агенту и пользователю детерминированный откат правок, сделанных **file-тулами** в рамках сессии: по одному шагу и целиком за ход.

**Не-цели (v1):**
- изменения через `bash` (`sed -i`, `git mv`, скрипты), `create_dir`, запись конфига и плагинов;
- откат после удаления сессии;
- web UI (список изменений и кнопка отката);
- redo (отмена отмены);
- интеграция с git (commit/stash).

## 2. Архитектура

```
ToolExecutor.execute()  ── captureBefore() ──┐
        │                                    │
        ├─ handler (write_file и т.д.)       ├─→ ChangesModule
        │                                    │     ├─ index.jsonl
        └─ captureAfter(callId, ok) ─────────┘     ├─ state.json
                                                   └─ blobs/<sha>.gz

runTurn() ── beginTurn() ───────────────────────→ turn counter
tools restore_file / list_file_changes ────────→ undo() / list()
CLI mma undo / slash /undo ────────────────────→ undo() / list()
```

### 2.1 Порт

Определяется в `src/tools/types.ts`, реализуется модулем `src/modules/changes/`:

```ts
export interface FileChangesPort {
  beginTurn(): void;
  captureBefore(ctx: ToolContext, tool: ToolDefinition, call: ToolCall): void;
  captureAfter(callId: string, success: boolean): void;
  list(options: { path?: string; limit?: number }): ChangeEntry[];
  undo(options: { path?: string; steps?: number; turn?: number; force?: boolean }): UndoResult;
}
```

`ToolContext.fileChanges?: FileChangesPort` — живой геттер, который ставит bootstrap (`src/core/bootstrap/tool-context.ts`) из активного `SessionManager` и конфига. `ToolExecutor.fork()` копирует дескрипторы `ctx`, поэтому порт — один на всех субагентов хода.

### 2.2 Точки вызова

- `src/tools/executor.ts:execute()` — после `enforcePathArgs`/`enforceUrlArgs` и создания `pathGuard` (после проверки политики, до вызова хендлера): `this.ctx.fileChanges?.captureBefore(this.ctx, tool, call)`.
- Там же после `finalizeToolResult`: `captureAfter(call.id, result.success)`.
- `src/core/agent/turn-run.ts:runTurn()` — `beginTurn()` на границе хода, рядом с инициализацией чекпоинта.
- Fail-open: ошибки `captureBefore`/`captureAfter` не меняют результат тула, но эмитят диагностику `{ source: "module:changes", operation: "changes.capture", kind: "failed", cause }` через `ctx.onDiagnostic` (INV-15). Если порт отсутствует (тесты, раннеры без сессии) — поведение как сегодня.

### 2.3 Таблица операций

| Тул | `op` | Пути |
|---|---|---|
| `write_file`, `edit_file`, `patch_file`, `append_file`, `download_file` | `write` | `path` |
| `delete_file` | `delete` | `path` |
| `move_file` | `move` | `path` (откуда) + `newPath` (куда) |

Проверка аргументов — по фактическим именам параметров тула; неизвестный тип или отсутствие пути → диагностика, без записи. Ядро не знает про конкретные имена тулов: таблица живёт в модуле.

Arch-гейт `tests/arch/changes-coverage.test.ts`: все тулы с `caps` `{fs:"write"}` или `{fs:"any"}` и `pathArgs` обязаны присутствовать в таблице либо в явном `EXCLUDED` со строкой-причиной. Исключения v1: `create_dir` (нет содержимого файла), `syntax-validator` (временный файл), `bash` (нет `pathArgs`, покрытие невозможно без эвристик).

### 2.4 Модуль

`src/modules/changes/` (не critical, без teardown — платформенный сервис: при его отсутствии агент работает как раньше):

- `store.ts` — журнал, блобы, бюджет, шифрование;
- `capture.ts` — таблица тулов и захват до/после;
- `undo.ts` — разрешение конфликтов и применение;
- `types.ts` — `ChangeEntry`, `UndoResult`, опции;
- `index.ts` — сборка `FileChangesPort`.

Файлы модуля ≤300 строк каждый (правило 6 AGENTS.md).

## 3. Формат данных

```
<configDir>/sessions/<id>/changes/
  index.jsonl        # append-only, по строке на ChangeEntry
  state.json         # { "v":1, "turn": 7 }
  blobs/<sha256>.gz  # gzip(raw content), content-addressed
```

`ChangeEntry`:

```ts
interface ChangeEntry {
  v: 1;
  id: string;              // ch_<random>
  ts: string;              // ISO
  turn: number;
  tool: string;
  callId: string;
  op: "write" | "delete" | "move" | "undo";
  path: string;            // относительно baseDir
  pathAbs: string;         // для сопоставления (нормализованный абсолютный путь)
  before: string | null;   // sha256 или null = файла не было
  after: string | null;    // sha256 или null = файл удалён
  bytes: number;
  mode?: number;
  to?: string;             // только move: путь назначения (относительный)
  toBefore?: string | null; // только move: sha содержимого назначения до переезда
  targetId?: string;       // только undo: id отменяемой записи
  skipped?: "too-large" | "evicted" | "unsupported";
}
```

Правила:

- `before === null` для создания файла; `after === null` для удаления.
- `move` пишет одну запись с `path` (источник) и `to` (назначение); `before` — содержимое источника, `toBefore` — содержимое назначения до переезда (`null`, если его не было).
- SHA256 считается по **сырому** содержимому до gzip. Одинаковое содержимое пишется в блоб один раз.
- `index.jsonl` шифруется построчно тем же `SessionFileEncryptor`, что и `session.jsonl`, если включено `security.sessionEncryption`. Блобы шифруются тем же ключом и помечаются префиксом `enc:` (детекция по префиксу, как в `session-encryption.ts`); при выключенном шифровании — plaintext gzip.
- Незавершённая запись (краш между захватом и `captureAfter`) не попадает в индекс; осиротевший блоб удаляется при ближайшей сборке мусора.
- `state.json` пишется атомарно: tmp + rename.

### 3.1 Бюджет и вытеснение

| Ключ | Дефолт | Назначение |
|---|---|---|
| `changes.enabled` | `true` | выключатель фичи |
| `changes.maxFileBytes` | `2097152` (2 MiB) | файл больше — блоб не пишется, `skipped:"too-large"` |
| `changes.maxTotalBytes` | `67108864` (64 MiB) | бюджет блобов на сессию |
| `changes.maxRevisionsPerFile` | `20` | глубина отката по одному файлу |

При превышении бюджета или глубины самые старые записи помечаются `skipped:"evicted"`, их блобы удаляются, если на них нет ссылок из остальных записей. Откат к вытесненной версии возвращает явную ошибку (см. §6).

## 4. Захват

1. `captureBefore` определяет `op` и путь по таблице. Если файла нет — `before=null`; если есть — `statSync`, проверить размер и симлинк (симлинк → `skipped:"unsupported"`), прочитать, посчитать sha256, записать блоб (если отсутствует).
2. Захваченное кладётся в `Map<callId, Pending>` в памяти модуля. Операции синхронные, поэтому параллельные форки не создают гонки; общий `Map` разделяется всеми форками через общий порт.
3. `captureAfter(callId, success)` при `success === true` дописывает `ChangeEntry` в индекс (после хендлера известен `after`: по содержимому файла/`to`, либо `null` для удаления). При `false` — `Pending` выбрасывается, блоб остаётся до ближайшей сборки мусора.
4. Лимит файловых операций (`security.maxFileOperations`) и защищённые пути проверяются enforcement’ом **до** захвата; snapshot не обходит политику.

## 5. Откат

### 5.1 По файлу

`undo({ path, steps = 1, force = false })`:

1. Нормализовать путь и найти все незаменённые (`targetId` не ссылается на них) записи с этим `pathAbs`, отсортированные по времени.
2. Взять N-ю с конца. Если записей меньше `steps` — ошибка «недостаточно версий».
3. Проверить 현재 состояние: для `write` — sha256 текущего содержимого === `entry.after`; для `delete` — файла нет; для `move` — по `to` лежит ожидаемое содержимое. Расхождение → конфликт; без `force` отказ с путём и советом прочитать файл. `force` обходит только конфликт, но не политику путей.
4. Применить: записать `entry.before` из блоба (null → `unlinkSync`); для `move` — вернуть файл из `to` в `path`, а на месте `to` восстановить `toBefore` (или удалить, если его не было).
5. Добавить в индекс запись `{op:"undo", targetId: entry.id, before: текущий sha, after: восстановленный sha}`. Повторный `undo` шагает на предыдущую запись.

### 5.2 По ходу

`undo({ turn })` (по умолчанию — текущий номер хода из `state.json`):

- выбрать все незаменённые записи с `turn === turn`, применить в обратном порядке;
- каждая запись проходит ту же проверку конфликта; конфликтующая пропускается с сообщением, остальные применяются;
- результат — список `{ path, ok, reason }`.

### 5.3 Семантика создания/удаления

- Откат создания (`before=null`) удаляет файл.
- Откат удаления (`after=null`) восстанавливает файл из блоба с исходным `mode`.
- Откат `write` возвращает содержимое до правки, а не «предыдущую версию из git».

## 6. Поверхности и тексты

### 6.1 Тулы (`src/tools/restore-file.ts`, `src/tools/list-file-changes.ts`)

- `list_file_changes`: `path?`, `limit` (по умолчанию 10, максимум 50), `boundedOutput: true`, `cacheable: false`; возвращает таблицу `id/turn/tool/op/path/ts/skipped`.
- `restore_file`: `path?`, `steps?` (по умолчанию 1), `turn?`, `force?`; `alwaysOn: true`, tags `["file"]`, `security: { caps:[{fs:"write"}], pathArgs:["path"] }`. Описание явно говорит: «coverage: file tools only; bash edits are not tracked; refuses if the file changed since the snapshot — read the file first or pass force».
- Результат `restore_file` содержит короткую сводку и diff между текущим и восстановленным содержимым (`generateDiff` из `src/ui/diff.ts`), не полный файл.
- Все пользовательские строки — через `t()` с симметричными ключами `en`/`ru` в `src/i18n/*.json` (префиксы `changes.*`, `tool.restore_file.*`, `tool.list_file_changes.*`). Ключи веб-словаря не нужны: web-панели в v1 нет.

### 6.2 CLI и slash

- `mma undo <path> [--steps N] [--force]` — откат по файлу.
- `mma undo --turn [N] [--session ID]` — откат хода; по умолчанию последний зарегистрированный.
- `mma undo --list [path]` — список версий.
- `/undo` — каталог команд `src/core/commands/catalog.ts` + хендлер в handler-map `src/cli/repl-commands*.ts` (terminal/tui).
- Новый билдер `buildUndoCommand(program)` в `src/cli/undo-commands.ts`, регистрация в `createProgram()` (`src/cli/commands.ts`).
- Сессия по умолчанию — последняя активная для текущего `baseDir` (как у `mma session show`); при неоднозначности — ошибка с просьбой `--session`.

### 6.3 Наблюдаемость

- Каждый откат пишет событие `change` в `session.jsonl`: `{ type:"change", source:"module:changes", module:"changes", operation:"changes.undo", path, op, targetId }`. Тип добавляется в `src/core/types.ts`; запись — через `SessionManager.appendLog`.
- События захвата в `session.jsonl` не пишутся (индекс — отдельный источник правды), чтобы не раздувать контекст; в лог попадают только ошибки и откаты.

## 7. Безопасность

- `restore_file` проходит тот же enforcement, что и запись: `pathArgs`, защищённые пути, `approve` для защищённых файлов, `writePathAllowlist` онбординга.
- Путь обязан совпадать с записанным в журнале (`pathAbs`); попытка восстановить «похожий» путь — отказ.
- Перед записью — `ctx.pathGuard.recheck(path)` против подмены симлинка. В CLI — та же проверка через `checkToolPath` с конфигом сессии.
- Содержимое блобов — это содержимое файлов проекта: при включённом шифровании сессии шифруются и они; при выключенном — та же модель конфиденциальности, что у `session.jsonl`.
- Удаление сессии удаляет `changes/` вместе с папкой сессии; отдельной команды «очистить историю» в v1 нет.

## 8. Тестирование

- `tests/changes/store.test.ts` — индекс, дедуп блобов, шифрование вкл/выкл, вытеснение по бюджету и глубине, битые/оборванные строки, атомарность `state.json`.
- `tests/changes/undo.test.ts` — create→undo=delete, delete→undo=recreate, write→undo, move→undo, steps=2, конфликт хеша, force, turn-откат, вытесненный снапшот, insufficient history.
- `tests/changes/capture.test.ts` — таблица тулов, fail-open диагностика, unsuccessful write не попадает в журнал, общий порт у форков.
- `tests/arch/changes-coverage.test.ts` — гейт покрытия тулов (§2.3).
- `tests/cli/undo.test.ts` — команда и slash-хендлер, разбор аргументов, выбор сессии.
- Живой прогон: изолированный `MMA_CONFIG_DIR`, агент правит файл в песочнице, вызывает `restore_file`, проверка содержимого на диске (согласно testing.md; без сервера).
- DoD: `bun test` + `bun run quality` зелёные; тест, падающий без правки, на каждое новое поведение.

## 9. Волны реализации

1. Хранилище: `src/modules/changes/**`, ключи конфига, тесты `tests/changes/store.test.ts`.
2. Шов: `ToolContext.fileChanges`, `ToolExecutor` вызовы, `runTurn.beginTurn`, arch-гейт.
3. Тулы и i18n: `restore_file`, `list_file_changes`, тесты `capture`/`undo`.
4. CLI/slash: `mma undo`, `/undo`, тесты, живой прогон.
5. Доки: обновить `docs/agents/architecture.md` и `docs/agents/gates.md`, прогнать `bun test` + `bun run quality`, ревью.

Версия: MINOR на следующем релизе (новые тулы/ключи), `CHANGELOG.md` — только по явной команде. `dev` локально отстаёт, поэтому ветка создана из текущего HEAD; интеграцию делать обычным merge в актуальный `dev`.
