# WebUI Files Tab (дерево файлов + attach) — Design

Дата: 2026-10-07
Статус: draft (brainstorming применён)
Ветка: `feat/webui-files-tab`
Тип релиза: MINOR (новая вкладка, новый REST-роут и SSE-событие — аддитивно)

## 0. Цель и метод

Добавить в `mma web` вкладку **Files** в сайдбаре: ленивое дерево файлов рабочего каталога,
просмотр содержимого прямо в приложении (read-only), и прикрепление файла в чат **через
вставку пути** в черновик сообщения (агент читает путь сам через `read_file`).

Дизайн собран интерактивно (тип attach, состав дерева, UX чтения, поверхность просмотра и
триггер attach выбраны пользователем). Техническая база — существующие модули: `IndexerModule`
(ignore-правила + вотчер), `file-api` (джейл + чтение + лимиты), `sidebar` (вкладки +
master-detail, как Trace), `composer`/`tabs` (черновик).

**Ключевое решение по attach:** новых серверных каналов вложений НЕТ. Существующий контракт
вложений (`parseMessageBody` принимает только `data:image/...`) не трогаем — attach это чисто
клиентская вставка текста пути в черновик.

## 1. Инварианты (ломать нельзя)

1. **Публичные контракты только аддитивны.** Существующие REST-роуты, SSE-события,
   `session.jsonl`, plugin API не меняются. Добавляются `GET /api/files`, SSE `files`,
   поле `filesRevision` в снапшот — все аддитивные.
2. **Read-only.** Ни одной write-операции из вкладки Files: нет create/rename/delete/move/edit,
   нет `PUT`/`POST` в files-API. Только листинг и чтение.
3. **Джейл в workspace.** Любой путь резолвится и проверяется так же, как в `file-api`:
   лексический гард → `realpath` → повторный гард → `matchProtectedPath`. Protected-пути
   не показываются и не читаются.
4. **Одна правда о шуме.** Фильтрация дерева использует ignore-примитивы индексатора
   (`isIgnoredDirName`/`isIgnoredFileName`, `IGNORE_DIRS`, `loadIgnoreMatcher` для
   `.gitignore`/`.mmaignore`), а не собственную копию правил.
5. **Degrade gracefully.** Нет индексера/вотчера, `ENOENT`, битый симлинк, недоступный
   workspace — вкладка работает best-effort и не роняет web-хост.
6. **Frontend-модуль — leaf.** `sidebar/files.ts` импортит только `dom/i18n/format/store/api`
   и `sidebar/state.js`; связь с композером — через DI-хук, не обратный импорт
   (guard `tests/webui-frontend-graph.test.ts`).
7. **Backend-хендлер зависит от роли, не от композита.** `files-api` типизирован
   `Pick<...>`/`WorkspaceStore`, не `WebUiState` (guard `tests/webui-boundaries.test.ts`).
8. **i18n-паритет.** Все строки через `t()`, ключи в `en.json` И `ru.json`.
9. **STYLE.md.** Дерево/просмотр — строки, отступы, глифы; никаких boxed-панелей.

## 2. Пользовательские сценарии

- **Навигация.** Открыть вкладку Files → видеть корень workspace; клик по папке раскрывает её
  (lazy fetch), клик по файлу открывает просмотр.
- **Чтение.** Текст с подсветкой синтаксиса, Markdown рендерится, картинки/PDF показываются,
  бинарь/слишком большой — понятная ошибка.
- **Attach.** Навести на строку файла → иконка attach; в шапке просмотрщика — кнопка
  «Прикрепить». Путь вставляется в активный черновик вкладки; можно накопить несколько.
- **Live.** Создал/изменил файл извне → дерево и открытый файл обновляются ≤ ~2с.

## 3. Архитектура и поток данных

```
[fs.watch baseDir] --settled--> IndexerModule.watch(onSettled)
                                     |
                        web attachIndexWatcher(onChange)
                                     |
                 state.filesRevision++  +  SSE {type:"files",phase:"changed"}
                                     |
                  client: refetch expanded dirs / reload open file

[click dir]  --GET /api/files?path=--> files-api (jail + ignore) --> JSON entries
[click file] --GET /api/file?path=--> file-api (jail + limits)  --> text/img  --> viewer
[click attach] --client--> insert `relpath` into tabs.draft (позиция курсора)
```

Бэкенд живёт в `src/modules/webui/`; фронтенд — leaf-модуль `assets/js/sidebar/files.ts`.

## 4. Backend

### 4.1 `GET /api/files?path=<relative-dir>`

Новый файл `src/modules/webui/file/files-api.ts` (`handleFilesApi`), регистрируется в
`API_GROUPS` (`server.ts:136-141`). Возвращает JSON (в отличие от `/api/file`, который
отдаёт `text/plain` для навигации браузера; тут запрос идёт из JS).

Успех `200 application/json`:

```json
{
  "path": "src/tools",
  "entries": [
    { "name": "sub", "type": "dir" },
    { "name": "bash.ts", "type": "file", "size": 1234 }
  ],
  "truncated": false
}
```

- `path` — нормализованный относительный путь (`""` = корень workspace).
- `entries` — сортировка: папки сверху, затем файлы, регистронезависимо по алфавиту.
  `size` — только у файлов.
- Игнор: `isIgnoredDirName`/`isIgnoredFileName` + `IgnoreMatcher.ignores(rel, isDir)`.
- Кап `MAX_DIR_ENTRIES = 1000`; при упоре `truncated: true` (как карта помечает
  `[!] Index truncated...`), не молчаливое подмножество.

Ошибки — JSON `{ "error": "<code>" }`:
`400 invalid_path` (абсолютный/пустой невалидный), `403 outside_workspace`,
`403 protected_path`, `404 not_found` (нет каталога), `503 workspace_unavailable`.

### 4.2 Общий резолвер путей

Хелпер `resolveWorkspacePath(base, raw)` в `src/modules/webui/file/paths.ts`: лексический
`escapes()` → `realpath` → повторный `escapes()` → `matchProtectedPath`. `file-api.ts`
переводится на него (убираем дублирование), `files-api.ts` использует его же. `file-api`
сохраняет текущий `text/plain`-контракт ошибок; `files-api` маппит классы в JSON-коды.

### 4.3 Live-уведомление

- `IndexerModule.watch(onSettled?: () => void)` (`src/modules/indexer/module.ts:219`):
  в дебаунс-колбэке после `refresh()` вызывает `onSettled?.()`.
- `WebIndexer.watch?(onSettled?: () => void)` (`host-state.ts:34-45`);
  `attachIndexWatcher(indexer, onChange?)` (`index-watcher.ts`) прокидывает колбэк.
- `module.ts` (рядом со строкой 185) передаёт колбэк: `state.filesRevision++` и
  `broadcast({ type: "files", ts: Date.now(), phase: "changed" }, state)`.
- `RuntimeState.filesRevision?: number` (`state.ts`), `HostStateSnapshot.filesRevision?`
  (`core/host.ts`), `HostStateInput.filesRevision?` (`host-state.ts`) — попадает в
  `/api/state`, страхующий 2с-поллинг на случай пропущенного SSE.
- Best-effort как у карты: на Linux `fs.watch` нерекурсивный → новые подпапки требуют
  ручного переиндексирования; документируется в `docs/agents/modules.md`.

## 5. Frontend

### 5.1 Вкладка и дерево

- `assets/js/sidebar/state.ts`: `TABS` += `"files"`, `ICON_NAME.files = "folder-tree"`,
  поле в `SidebarState`. `Alt+1..5` подхватывается автоматически (`core.ts:90-96`).
- `index.html`: кнопка `.sb-tab` + `#pane-files` (по образцу `#pane-map`).
- Новый `assets/js/sidebar/files.ts` (leaf), экспорт в баррел `sidebar.ts`.
- Состояние: `expanded: Set<string>`, `listing: Map<string, DirEntry[]>`, `selectedPath`.
  Ленивая загрузка: раскрытие папки фетчит `/api/files?path=` только если не закэширована;
  Re-index/событие сбрасывает только перечитываемые узлы.
- Рендер по STYLE.md: строки с отступом, chevron-глиф папки, иконка файла (Lucide),
  без рамок. Пустой каталог/ошибка — inline-строка.

### 5.2 Просмотр (read-only, master-detail)

- Клик по файлу: сайдбар получает `.sb.sb-expanded` (680px, общий класс с Trace), в
  `#pane-files` появляется детальная панель справа от дерева. `Escape` закрывает.
- Контент:
  - текст → `fetch("/api/file?path=...")`, рендер в `<pre>` с подсветкой `window.hljs`
    (язык по расширению);
  - `.md` → существующий md-рендерер (`md.ts`);
  - картинки/PDF/медиа → `<img src="/api/file?path=...">` / `<embed>`;
  - `413/415` → локализованная строка `web.file.error.too_large` / `binary_file`.
- В шапке панели: имя файла, путь, кнопка «Прикрепить», `×` закрыть. Никаких write-контролов.

### 5.3 Attach = вставка пути

- Триггер: иконка на строке файла при hover + кнопка в шапке просмотрщика.
- Действие: клиентская вставка относительного пути в **бэктиках** в `tabs.draft` активной
  вкладки, в позицию курсора: `` `src/tools/bash.ts` `` (несколько — через пробел).
  Пусто → вставляется как есть, курсор после.
- `composer` экспортирует `insertIntoDraft(text: string)`; `app.ts` передаёт его в
  `initFiles({ insertPath })` — DI, без импорта composer из leaf-модуля.
- Никаких чипов/состояния вложений — файл в черновике выглядит как обычный текст пути.

## 6. Контракты (сводка)

| Тип | Изменение |
|---|---|
| REST | + `GET /api/files?path=` → JSON `{path, entries, truncated}` / `{error}` |
| SSE | + `{type:"files", ts, phase:"changed"}` (`SseEvent` union, `state.ts`) |
| Snapshot | + `filesRevision?: number` в `HostStateSnapshot`/`HostStateInput`/`RuntimeState` |
| Backend | + `file/paths.ts`, `file/files-api.ts`; правки `file-api.ts`, `server.ts`, `module.ts`, `index-watcher.ts` |
| Indexer | `watch(onSettled?)`; `WebIndexer.watch(onSettled?)` |
| Frontend | + `sidebar/files.ts`; правки `sidebar/state.ts`, `core.ts`, `sidebar.ts`, `index.html`, `app.ts`, `composer.ts` |
| i18n | + `web.sidebar.tab_files`, `web.files.*` (en+ru) |

## 7. Edge cases

- **Mobile ≤760px:** сайдбар скрыт — специальной логики не требуется.
- **Огромный каталог:** `truncated: true` + строка-предупреждение.
- **Симлинк за пределы workspace:** отсекается `realpath`-гардом, файл не показывается.
- **Protected-путь:** не листится и не читается.
- **Файл > 512 КБ:** строка ошибки, attach пути всё равно доступен.
- **Файл удалён после открытия:** при reload — `404`, показываем «файл недоступен», дерево
  обновляется по событию.
- **Нет индексера/вотчера** (тесты/примеры): листинг работает (только явные ignore-имена),
  live-обновление тихо отсутствует.
- **Trace-expanded vs Files-expanded:** одновременно видима одна панель, класс `.sb-expanded`
  снимается при смене вкладки.

## 8. i18n (en + ru)

`web.sidebar.tab_files`, `web.files.empty`, `web.files.error`, `web.files.truncated`,
`web.files.attach`, `web.files.attached`, `web.files.open_failed`, `web.files.no_workspace`.
Существующие `web.file.error.*` (too_large/binary_file/...) переиспользуются.

## 9. Тестирование

- **Backend unit** (`tests/modules/webui/files-api.test.ts`): джейл (`../`, абс. путь,
  симлинк), protected-путь, ignore (`.gitignore`/`.mmaignore`/IGNORE_DIRS), сортировка,
  кап `truncated`, `503` без workspace, JSON-коды ошибок.
- **Live** (`tests/modules/indexer/watch.test.ts` или web): `watch(onSettled)` зовёт колбэк
  после дебаунса; `module.ts` бампит `filesRevision` и шлёт SSE `files`.
- **Frontend** (новый тест `sidebar/files`): lazy-fetch раскрытия, кэш, вставка пути в
  черновик, закрытие по Escape.
- **Обновить существующие:** `tests/webui-sidebar-dom.test.ts` (сейчас 3 вкладки),
  `tests/webui-assets.test.ts` (guard-строки вкладок/импортов), при необходимости
  `tests/webui-boundaries.test.ts`/`webui-frontend-graph.test.ts`.
- **E2E** (`tests/e2e/`, только по явной команде): открыть Files, раскрыть папку, открыть
  файл, нажать attach, проверить путь в композере; бинарь → ошибка.
- Ворота: `bun test` + `tsc --noEmit` + `bun run quality`.

## 10. Вне scope (YAGNI)

Редактирование/создание/удаление/переименование; git-декорации (статусы изменений);
drag-and-drop attach; мультивыбор файлов; поиск/фильтр по дереву; загрузка файлов с клиента.

## 11. Открытые вопросы

- Формат вставки пути: **бэктики** (`` `src/foo.ts` ``) — принято по умолчанию; при желании
  заменить на `@src/foo.ts`. Меняется одной строкой.
- Показывать ли скрытые файлы (`.foo`) в дереве: по умолчанию **показывать** (кроме
  protected), т.к. attach=путь и агент их читает; при шуме — отфильтровать `dotfiles`
  отдельным решением.
