# Git в MMA: тул, классы операций, веб-поверхность

Дата: 2026-06-08 · Ветка: `feat/git-tool` · Статус: принято

## 0. Постановка

Сейчас агент работает с git только через `bash`: модель собирает shell-строку, а на
Windows пайпы и перенаправления заблокированы — `git diff | head` невозможен,
полный diff летит в контекст целиком. Read-only команды (`git status`, `git log`,
`git diff`, …) мемоизируются (`src/tools/bash-memo.ts`), из разрушительных форм
заблокирована только `git clean -f` (`src/modules/security/command-shapes.ts`).

Веб-поверхность о git не знает ничего: под полем ввода показан только путь
workspace (`js/footer.ts`), в сайдбаре нет вкладки изменений.

Задача — дать git **свой контракт** (не надоумленный bash), классификацию
операций с единой точкой истины и read-only веб-поверхность.

## 1. Решения, зафиксированные с пользователем

| Вопрос | Решение |
| --- | --- |
| Объём вкладки изменений v1 | **Только чтение**: список файлов + diff. Stage/commit — v2 |
| Разрушительные операции (`push --force`, `reset --hard`) | **Через `approve`**, не запрет |
| Чипы git в терминальном REPL | **Только веб** |

## 2. Границы и направление зависимостей

```
                src/tools/git-classes.ts   ← единая классификация (read/mutate/destructive)
                        ▲        ▲
        ┌───────────────┘        └───────────────┐
src/tools/git.ts              src/modules/security/command-shapes.ts
  (тул `git`, argv)              (жёсткий запрет для `bash git …`)
        ▲
src/tools/git-core.ts  ← исполнение: spawn(argv), парсинг porcelain
        ▲        ▲
src/tools/git.ts   src/modules/webui/git/git-api.ts
                        ▲
                   src/core/host-state.ts → снапшот `git`
```

- **`src/tools/git-classes.ts`** — единственный список субкоманд и флагов. Его
  читают и тул, и `command-shapes`. Паритет списков под гвардом
  (`tests/security/git-classes-parity.test.ts`), иначе политики разъедутся.
- **`src/tools/git-core.ts`** — исполнение без шелла (`spawn` с argv-массивом) и
  разбор вывода. Модуль webui импортирует его по существующему паттерну
  (`webui/session/prompt-io.ts` → `tools/approve.ts`); гейт `module-boundaries`
  запрещает только импорты `core/agent/*` и чужие `tool.handler` — сюда не попадает.
- Ядро (`core/host-state.ts`) git **не** исполняет: поле `git?: GitSnapshot | null`
  заполняет web-обвязка. `core` не знает про git — критерий «отключимо и работа
  продолжается» (модуль, не ядро).
- **Без `net`-капа**: `push`/`pull`/`fetch` идут тем же spawn без сети в контрактe
  тула; сетевой доступ — свойство subprocess, как у `bash` (`caps: [{proc:true}]`).

## 3. Классификация операций (INV-G1)

Три класса. Класс определяется по **первому непустому токену argv** (субкоманда)
и по флагам, когда он разрушительный.

### read — ничего не меняют, кешируемы
`status`, `log`, `diff`, `show`, `branch` (без `-d|-D|-m|-c|--move`), `tag` (без `-d|--delete|-f`),
`rev-parse`, `rev-list`, `ls-files`, `ls-remote`, `remote` (без `-r|-v` без аргументов — только `show|get-url`),
`describe`, `blame`, `shortlog`, `cat-file`, `cherry`, `merge-base`, `diff-tree`,
`name-rev`, `symbolic-ref` (только чтение: без `--delete`), `config` (только `get|list|get-regexp`).

### mutate — меняют состояние репозитория, не уничтожая историю
`add`, `rm`, `mv`, `commit`, `reset` (только `--soft|--mixed`, без `--hard`),
`checkout`, `switch`, `restore`, `stash` (`push|pop|apply|list|show`), `apply`,
`branch` (создание), `tag` (создание), `remote add|set-url|rename`,
`fetch`, `pull`, `push` (без force), `rebase` (без `--abort` на общей ветке — см. §4),
`cherry-pick`, `revert`, `merge`, `am`, `notes`, `clean -n` (dry-run).

### destructive — требуют подтверждения; из `bash` запрещены outright
`reset --hard`, `push --force` / `--no-verify` / `--force-with-lease`,
`clean` с `-f`/`-d`/`-x`/`--force`, `branch -D`/`-d`, `tag -d`/`--delete`,
`checkout --force`/`-f`, `stash drop`/`clear`, `rebase --abort` при индексе с конфликтами
(в v1 — считаем `rebase --abort` destructive), `filter-branch`, `gc --prune=…`,
`symbolic-ref --delete`, `remote remove|rm|set-head --delete`,
`update-ref -d`, `commit --amend` (переписывает последний коммит).

Классификация — чистая функция:

```ts
export type GitOpClass = "read" | "mutate" | "destructive";
export function classifyGitArgv(argv: string[]): GitOpClass;   // "unknown" → destructive
export function gitCommandName(argv: string[]): string;        // "reset --hard" / "status"
```

Неизвестная субкоманда **destructive** (fail-closed: молча разрешить новое
неизвестное имя опаснее, чем спросить).

## 4. Две политики, один источник

| Поверхность | read | mutate | destructive |
| --- | --- | --- | --- |
| **тул `git`** | исполнить (+мемо 120с) | исполнить | `approve` → исполнить |
| **`bash` (`git …`)** | как сейчас | как сейчас (policy bash) | **запрет** |

Жёсткий запрет в bash остаётся в `command-shapes.ts`, но его правила переходят
на классификатор: `detectDangerousShape` вызывает `classifyGitArgv` по
разобранным токенам и блокирует любой `destructive` (вместо одного `git clean -f`).
Так `git reset --hard` и `git push --force` через bash перестают проходить.

Это сознательное сужение `bash`-политики: то, что было дырой, а не фичей.
Подтверждается тестами `tests/security/command-blacklist.test.ts` (расширяется).

`approve` для деструктивных в туле — через тул `approve`, а не флаг: агент
обязан показать человеку, что делает.

## 5. Тул `git`

`src/tools/git.ts`, регистрация в `registerAllTools`, `tags: ["shell", "code"]`.

```jsonc
{ "subcommand": "status",          // обязательный
  "args": ["--short", "--branch"], // массив токенов; НЕ строка
  "file": "src/x.ts",              // опц.: путь для diff/show/log
  "stat": false,                   // diff: только --stat сводка
  "lines": 200,                    // обрезка вывода (0 = без лимита)
  "cwd": "." }                     // подкаталог workspace
```

- **argv без шелла.** `spawn("git", [subcommand, ...args])`, без `shell: true`.
  Строка команды модели недоступна → `;` `|` `>` и обход проверок невозможны.
  Флаги `--ext-gui`, `-c`, `--git-dir`, `--work-tree`, `--exec-path` и env
  `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_CONFIG_GLOBAL` **запрещены**
  (иначе jail обходится). Проверка — до исполнения (`src/tools/git-core.ts`).
- **workdir-jail** как у `bash`: `assertWorkdirAllowed(ctx, cwd)` (`src/tools/path-guards.ts`).
- `security: { caps: [{ proc: true }], manual: { reason: "git: классификация субкоманд + approve в хендлере", reviewedBy: "…", date: "2026-06-08" } }`
  — форма под гвардом `tests/tools/security-decl.test.ts` (`pathArgs` не объявляем:
  enforcement путей у `file`/`cwd` делает хендлер через `safeResolvePath`, как `bash`).
- `boundedOutput: true` — тул сам режет (`lines`), усечение по бюджету к нему неприменимо.
- `manualMemo: true` — кешируемость зависит от класса (read → мемо, остальные →
  `memoClear`, сбрасывая и bash-мемо read-only префиксов: `git status` после `git commit`).
- **diff/лог с умной обрезкой.** По умолчанию `--stat` вперёд, затем хунки; при
  упоре — явная строчка «truncated, use stat:true or file:…», чтобы модель делала
  второй вызов осознанно, а не перечитывала гору.
- **`data`** — машинная сигнатура (`{ class, subcommand, exitCode }`), пригодится
  вебу и логам.
- `errorMeta: { code: "git_not_a_repo" | "git_command_blocked" | …, retryable }` —
  подсказка модели без протечки в чат.

## 6. Веб-контур (read-only)

### 6.1 Бэкенд

`src/modules/webui/git/git-api.ts` — группа префикс-роутов (в `API_GROUPS`,
правило #17):

| Маршрут | Ответ |
| --- | --- |
| `GET /api/git` | снапшот: `repo, branch, detached, aheadBehind, dirty, worktrees[], tags[], notARepo?` |
| `GET /api/git/changes` | `{ files: [{ path, index, worktree, oldPath? }] }` (`--porcelain -z`) |
| `GET /api/git/diff?path=<f>&staged=0|1` | `{ diff, truncated, bytes }` |

- Все три **только GET**. Пишущих git-роутов в v1 нет (решение §1).
- Кап: `ROUTE_BODY_CAPS["GET /api/git/diff"]` не нужен (кап тела — запрос);
  ответ режет сервер: `GIT_DIFF_MAX_BYTES = 256 KiB`, `GIT_DIFF_MAX_LINES = 3000`,
  `truncated: true` сверх. Файл разрешён **только внутри workspace**
  (`resolveWorkspacePath`, `src/modules/webui/file/paths.ts`), protected-пути
  и `.git/` — 403/404 как в `/api/file`.
- Вне git-репозитория — `{ repo: false }`, 200 (не ошибка: молча скрываем чипы).
- Кеш на сервере: снапшот живёт `GIT_SNAPSHOT_TTL_MS = 5000`, чтобы 10 вкладок
  не плодили `git status` каждые 200 мс; инвалидация — рост `filesRevision`
  (вотчер уже есть, `src/modules/webui/index-watcher.ts`).

### 6.2 Снапшот в состоянии

`src/core/host-state.ts`: `HostStateSnapshot.git?: GitSnapshot | null`, заполняет
web-обвязка из `git-core.ts` (без await в горячем пути — кеш, `buildHostState`
синхронный: кладём последний снимок + `gitRev`). Смена `git.branch`/`dirty`
детектируется клиентом по подписи (как `feed.lastEnvSig`), чтобы не перерисовывать
футер каждый тик.

### 6.3 Чипы под полем ввода

`js/footer.ts` остаётся листовым (тестируется в изоляции): добавляем вход
`git?: GitChips` и **чистую** функцию сборки строк. Рендер — в
`js/feed/git-chips.ts` (не трогаем `renderWorkspace`, если растёт — выносим).

Порядок слева направо и правила схлопывания (адаптивность, см. §7):

```
[⎇ branch] [⌂ worktree] [● N] [↑N ↓M] [◇ tag]
```

- `⎇ branch` — не скрывается никогда; при переполнении — ellipsis, полный путь в
  `title`/tooltip.
- Detached HEAD → `⎇ (detached@abc1234)`.
- `● N` — только если N > 0; клик открывает вкладку Changes.
- `↑N ↓M` — только если nonzero и есть upstream.
- `◇ tag` — только если HEAD на теге.
- Не-репозиторий → чипы скрыты целиком (не показываем «no git» — шум).

### 6.4 Вкладка «Изменения»

- `TABS`: `"git"` после `"files"` (счёт Alt+1..9 индексируется этим массивом —
  проверка в `tests/webui-sidebar-*`/i18n); `ICON_NAME.git = "git-branch"`
  (добавить иконку в `js/icons.ts`), `pane-git` в `index.html`,
  `SETTINGS_PANEL.git = "workspace"`.
- Секции unstaged / staged (в v1 read-only, но разделяем — как в IDE),
  глифы статуса (`M`/`A`/`D`/`R`/`?`), клик по файлу → diff в модалке
  (`js/dialog.ts`), `<pre>` с текстовым содержимым (никакого innerHTML — XSS-guard).
- Индикатор вкладки (`sb-dot`): точка, если dirty > 0 (механика как у trace).
- Обновление: при активой вкладке — `fetch /api/git/changes` на рост
  `filesRevision` + при смене вкладки, без поллинга (см. §8).

## 7. Адаптивность UI

Три перелома, существующие в styles.css (`mqMobile`/`mqNarrow` в сайдбаре):

| Ширина | Что делаем |
| --- | --- |
| ≥ 900px | все чипы |
| 640–899px | чипы: branch, worktree, dirty (count-only: `●3`), ahead/behind — схлопнуты в `↑↓` без чисел |
| < 640px (моб.) | только `⎇ branch` + `●N` без подписей; ahead/behind и tag — в `title` единственного чипа |

Реализация: CSS-классы `.gchip-optional`/`.gchip-count-only` + media-запросы
(не JS-резайзер), чтобы не считать ширину в рантайме; при переполнении —
`.ws-git { overflow: hidden }` и порядок `flex-shrink` такой, что branch не
схлопывается. Сайдбар на мобильном и так дровер (`mqNarrow`), вкладка
Changes внутри него работает как стек: список → diff на весь дровер с кнопкой
назад (паттерн `files/split.ts`).

## 8. Производительность и честность

- **Никакого поллинга git.** Снимок — по требованию (`GET /api/git`) и при
  инвалидации вотчером; в `buildHostState` только кеш.
- Урок `system-prompt-freeze.test.ts`: изменчивое состояние **нельзя** в
  system prompt. git-статус в промпт агента **не кладём** вообще (модель зовёт
  тул `git`).
- `git status --porcelain=v1 -z --branch` — один вызов на ветку+dirty; ahead/behind
  только при наличии upstream (`rev-parse --abbrev-ref @{u}` может упасть — не ошибка).
- Все git-вызовы сервера — с таймаутом (`LSP_DEFAULT_TIMEOUT_MS`-подобный
  `GIT_TIMEOUT_MS = 5000`) и с `--no-optional-locks`, чтобы не блокировать
  пользовательский git и не писать `.git/index.lock`.

## 9. Безопасность (сводка)

1. argv-spawn: шелл-мета символы физически не попадают в командную строку.
2. Запрет `--git-dir`/`--work-tree`/`-c`/env-подмены + workdir-jail → нельзя
   вывести операции за workspace.
3. Класс `destructive`: тул → `approve` (одноразовое разрешение, как у protected-путей);
   `bash` → блокировка формой (`command-shapes` → классификатор).
4. Веб: только GET; diff-path резолвится внутри workspace; protected/`.git` — 403.
5. Санитизация секретов в выводе git-тула (`git log` может содержать токены в
   сообщениях коммитов) — существующий `data-sanitizer`/egress-путь, без новых кодов.
6. Egress: `push` — исходящая сетевая операция. Для v1 остаётся как у bash
   (без отдельного гейта); вынесено в долг (см. §11).

## 10. Гварды (правило 5: инвариант = проверка)

| Проверка | Файл |
| --- | --- |
| INV-G1 единая классификация, паритет bash↔tool | `tests/security/git-classes-parity.test.ts` |
| классы и fail-closed на неизвестном | `tests/core/git-classes.test.ts` |
| тул: argv-spawn, blocked-флаги, мемо по классу, approve для destructive, boundedOutput | `tests/tools/git-tool.test.ts` |
| форма декларации (новый тул) | `tests/tools/security-decl.test.ts` (существующий) |
| деструктивные формы в bash во всех политиках | `tests/security/command-blacklist.test.ts` (расширить) |
| REST: только GET, вне-репо, jail path, cap diff | `tests/modules/webui/git-api.test.ts` |
| чипы: порядок/схлопывание/скрытие не-репо (чистый рендер) | `tests/webui-git-chips.test.ts` |
| XSS-guard на новых рендерах (diff как текст) | `tests/webui-xss-guard.test.ts` (существующий) |
| i18n-паритет `web.git.*` + `web.sidebar.tab_git` | `tests/i18n.test.ts` (существующий) |
| ≤300 строк на новых файлах | `tests/arch/file-size.test.ts` (существующий) |

## 11. Долг (реестр, правило 9)

Откладываем сознательно, с записью в `docs/agents/debt.md`:

- `git-push-egress-ungated` — `push` не под outbound-политикой (как bash).
  Критерий выхода: push под `outbound-policy` + секрет-скан перед push.
  Триггер: волна egress для subprocess-тулов.
- `git-actions-ui-v2` — stage/commit/discard из вкладки Changes + вывод
  `approve` в веб (сейчас approval-механизма для git в вебе нет).
  Триггер: следующая итерация UI.

## 12. Что НЕ делаем

- Slash-команды `/git`, `/commit` — вне объёма (обсуждались, не выбраны).
- Chips в терминальном REPL — только веб (§1).
- GitHub/PR/issues — только через внешний MCP, не в ядро.
- Запись коммит-хэша в `session.jsonl` — вне объёма v1.
