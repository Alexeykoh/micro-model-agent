# Manual UI/UX Testing Guide

Ручное тестирование пользовательского интерфейса и опыта MMA: от **первого запуска**,
через **вызов справки** и **все команды CLI/REPL**, до визуального стиля и клавиатуры.

> **Канонический стиль чата:** [docs/design/ui/STYLE.md](../design/ui/STYLE.md).
> Любое расхождение рендера со STYLE.md — это баг, а не «вкусовщина».
>
> **Автотесты (не заменяют этот гайд):** `bun test`; прогон агента из консоли и
> сертификация — [docs/agents/testing.md](../agents/testing.md).

## 0. Как пользоваться гайдом

- Проходи секции по порядку: первый запуск → справка → CLI → REPL → клавиатура → режимы → стиль → i18n.
- Каждый пункт — чекбокс `[ ]`. Отмечай по факту наблюдаемого поведения, а не по коду.
- **Отчёт по багу:** шаг → ожидаемо → фактически → окружение (ОС, терминал, версия `mma --version`, локаль).
- **Приоритеты:** `P0` — блокер/падение/потеря данных; `P1` — вводит в заблуждение/ломает поток; `P2` — косметика.

## 1. Предусловия и окружение

- [ ] Запуск **из корня репо** `E:\projects\micro-models-agent` (иначе `bun run mma` перехватит глобальный пакет — см. предупреждение в `AGENTS.md`).
- [ ] Версия в баннере (`mma <версия>`) совпадает с `package.json` (`node -p "require('./package.json').version"`).
- [ ] Терминал с поддержкой цвета и ширины < 100 колонок (проверить перенос длинных строк).
- [ ] LM Studio / Ollama / иной OpenAI-совместимый сервер запущен и доступен (для «живых» прогонов).
- [ ] Тестовая песочница существует: `_testing/<case-name>/` (в `.gitignore`, агент пишет сюда).

### 1.1. Сброс в состояние «первый запуск»

Первый запуск зависит от наличия `~/.mma` (`%USERPROFILE%\.mma` на Windows). Домен-файлы (`~/.mma/config/*.json`) тоже считаются «конфиг есть».

```powershell
# Закрыть все процессы mma, затем (Windows):
Rename-Item -LiteralPath "$env:USERPROFILE\.mma" -NewName ".mma.bak-$(Get-Date -Format yyyyMMddHHmmss)"
# либо изолированный профиль без трогания реального:
$env:MMA_CONFIG_DIR = "E:\projects\micro-models-agent\_testing\ui-firstrun\.mma"
```

- [ ] Чистый `~/.mma` → `bun run mma` запускает мастер.
- [ ] `MMA_CONFIG_DIR` перенаправляет конфиг/сессии/кэш в указанную папку (проверить `Environment`).

---

## 2. Первый запуск (мастер)

Поток: сообщение `cli.first_run` → мастер (cooked-mode `SetupPrompt`) → сохранение →
**re-exec новым процессом** (`relaunchCli`, guard `MMA_POST_SETUP=1`) → баннер REPL.

- [ ] Запуск `bun run mma` (без промпта, чистый профиль) показывает заголовок мастера и приглашение.
- [ ] Мастер **не** рисует box-рамку вокруг REPL-баннера (рамка `box()` — только для мастера).
- [ ] Ввод в мастер: печать, Backspace, Enter работают; нет «залипшего» промпта/дублей символов.

### 2.1. Язык

- [ ] Меню из двух пунктов: `[1] English`, `[2] Русский`; подсказка с `[1]`.
- [ ] Ввод `1`/`en` → английский; `2`/`ru` → русский (перевод строк мастера).
- [ ] Пустой Enter → дефолт `1` (English).
- [ ] Нечисловой мусор (напр. `xyz`) → безопасный дефолт, без падения.

### 2.2. Провайдер

- [ ] Меню провайдеров (из `BUILTIN_PROVIDERS`), нумерованное, с `[1]` дефолтом.
- [ ] Выбор `openai-compat` → сканирование портов (спиннер `setup.scanning_spinner`).
- [ ] Найдены локальные серверы (LM Studio `:1234`, Ollama `:11434`, vLLM `:8080`, GPT4All `:4891`) → меню с URL + «своя URL».
- [ ] Серверы не найдены → сообщение `setup.no_servers` и ввод `api_base` (дефолт `http://localhost:1234/v1`).
- [ ] Хостовый провайдер (не `openai-compat`) → base URL подставляется автоматически (без вопроса).
- [ ] API key: для `openai-compat` дефолт `not-needed`, для хостовых — пусто.
- [ ] Спиннеры не оставляют «хвостов»/дублей строк при остановке.

### 2.3. Модель и проверка соединения

- [ ] Список моделей фетчится (спиннер `setup.fetching_spinner`), показывается до 10; ввод номера выбирает модель.
- [ ] Пустой список → ручной ввод имени (дефолт `qwen/qwen3.5-9b`).
- [ ] Тест чата (спиннер) → зелёное `setup.ok` при успехе, жёлтое `setup.warning` при неудаче (без падения).
- [ ] Долгий/недоступный сервер → таймаут, а не зависание.

### 2.4. Настройки агента и security

- [ ] `setup.agent_settings`: context window (дефолт 32768), max iters (дефолт 1000); нечисло/`0` → дефолт.
- [ ] Блок security: статус «включено», вопрос «настроить?» (дефолт `n`).
- [ ] Ответ `y` → три подвопроса: bash block, flags block, paths restrict (поведение **restrict**-семантики, дефолт `Y`).
- [ ] Ответ `n` → security-вопросы пропущены, значения не применяются.
- [ ] Итоговая сводка (провайдер/модель/URL/key/context/iters/lang) — читаемая, значения совпадают с введёнными.
- [ ] `setup.complete` (зелёный жирный), затем `cli.setup_saved_restart` (dim).
- [ ] Процесс **перезапускается**: в новом процессе баннер REPL, мастер не повторяется.
- [ ] После сохранения повторный `bun run mma` **не** показывает мастер (конфиг обнаружен).

### 2.5. Первый запуск: one-shot (без промпта-мастера)

- [ ] `bun run mma "привет"` на чистом профиле: **не** запускает мастер, но пишет жёлтый `cli.first_run_oneshot`.
- [ ] `bun run mma "..." --json` на чистом профиле: человеческие предупреждения подавлены, stdout — валидный JSON.

### 2.6. Подкоманды на чистом профиле

- [ ] `bun run mma config show` на свежем профиле **не создаёт** дефолтный `config.json` (иначе следующий интерактив скипнет мастер).
- [ ] `bun run mma provider list` / `model list` не падают без конфига.

---

## 3. Справка (Help)

### 3.1. CLI help

- [ ] `bun run mma --help` — список команд, сгруппированный, читаемый; видны глобальные опции.
- [ ] `bun run mma -h` — то же.
- [ ] `bun run mma --version` / `-V` — ровно версия из `package.json`, одна строка.
- [ ] `bun run mma <command> --help` для **каждой** команды (`init`, `config`, `model`, `context`, `usage`, `map`, `provider`, `session`, `security`, `plugins`, `changelog`) — есть описание и аргументы/опции.
- [ ] `bun run mma model certify --help` — все опции с описаниями (`--provider-url`, `--tags`, `--scenarios`, `--reps`, `--force`, `--clean`, `--timeout`).
- [ ] `bun run mma security --help` и `mma plugins --help` — вложенные подкоманды перечислены.
- [ ] Текст справки проходит через `t()` — при `locale: ru` подписи переведены, при `en` — английские.
- [ ] Вывод справки не ломает верстку на узком терминале (переносы, без обрезания).

### 3.2. Guard от опечаток

- [ ] `bun run mma sesion list` → жёлтое `cli.unknown_command` с подсказкой `session`, **exit code 2**, промпт НЕ уходит в LLM.
- [ ] `bun run mma привет` (свободный текст) → уходит в агент как промпт (не путать с опечаткой команды).
- [ ] `bun run mma confg show` → подсказка `config`.

### 3.3. REPL `/help`

- [ ] `/help` группирует команды: `general`, `agent`, `session`, `skill`.
- [ ] Каждая строка: `/name (алиасы)  описание` + строка usage под ней (dim).
- [ ] Алиасы не дублируют команды (не выводятся дважды).
- [ ] `/help` при пустом вводе/после команд возвращает промпт без артефактов.

---

## 4. CLI-команды

Формат: ** invoke → ожидаемое поведение и UI-проверки**.

### 4.1. `setup`

- [ ] `bun run mma setup` — запускает мастер, сохраняет `~/.mma/config.json`, печатает `cli.config_saved`.
- [ ] Не перезапускает процесс (в отличие от первого `mma`).
- [ ] Прерывание (`Ctrl+C`) в мастере не оставляет битого конфига.

### 4.2. `config`

- [ ] `config set ui.spinner false` → `cli.set_done`; повторный `config show` подтверждает значение.
- [ ] Типы значений: `true`/`false` → boolean, целое → number, `1.5` → float, прочее → string.
- [ ] `config set provider.apiKey secret` → `config show` **скрывает** секрет (редакция).
- [ ] `config show --show-secrets` → секреты показаны как есть.
- [ ] `config show` — валидный JSON в stdout (это `writeMachineJson`, не человеческий лог).
- [ ] `config migrate` при легаси `~/.mma/config.json` и без домен-файлов → миграция + `.bak`, `config.migrate_done` с числом файлов.
- [ ] `config migrate` когда мигрировать нечего → жёлтое `config.migrate_no_legacy`.

### 4.3. `model`

- [ ] `model list` — текущая модель + список доступных, `*` у активной, `✔`/`○`/`·` (cert), `cli.model_hint`.
- [ ] Провайдер недоступен → `cli.model_fetch_failed` (без падения), подсказка сохраняется.
- [ ] `model use <name>` → `cli.model_set`, значение сохранено.
- [ ] `model cert-status <name>` / `cert-list` — читаемые статусы сертификации.
- [ ] `model certify <name> --scenarios <id>` — частичный ре-ран без `--force`, результаты мержатся.
- [ ] `model certify` с неизвестным id → ошибка со списком доступных сценариев.
- [ ] `model uncertify <name>` — запись удаляется, повторный `cert-list` подтверждает.

### 4.4. `context`

- [ ] `context` (без аргумента) — разбивка бюджета (system/reserve/history).
- [ ] `context 64000` → `cli.context_set`.
- [ ] `context 512` (меньше 1024) / нечисло → `cli.invalid_context_size`.
- [ ] `context --system 0.15` / `--reserve 0.2` → `cli.context_fraction_set`.
- [ ] Некорректная доля (напр. `1.5`) → `cli.context_invalid_fraction`.

### 4.5. `usage`

- [ ] `usage` на OpenRouter-конфиге — баланс/лимиты/кредиты (только явный вызов).
- [ ] Zen/Go/локальный провайдер → `cli.usage_unsupported`.
- [ ] Нет ключа → `cli.usage_no_key`; сетевая ошибка → `cli.usage_error`.
- [ ] Команда не зависает и завершается (postAction exit).

### 4.6. `map`

- [ ] `map` / `map summary` — сводка по индексу проекта.
- [ ] `map <action> <query>` — результат либо `indexer.not_indexed` (если индексера нет).
- [ ] Длинный вывод читаем и не ломает таблицу/переносы.

### 4.7. `provider`

- [ ] `provider list` — активный помечен `*`, видны type/baseUrl/prio; при одной записи — легаси-вывод.
- [ ] `provider check` — `✓`/`✗` по каждому провайдеру, `ms` и число моделей; `--timeout <ms>` влияет.
- [ ] `provider use <name>` — `cli.provider_set`; для `entries[]` переключает активную запись, ошибка при неверном имени (красным).
- [ ] `provider add <name> --url <url> --key <k> --priority 1 --context-window 32768 --rpm 60 --parallel 2` — `cli.provider_added` + `cli.provider_switch_hint`.
- [ ] `provider add` без URL и без хостового совпадения → красное `cli.provider_no_url`.
- [ ] Первый `provider add` сидит легаси-провайдера в `entries` (не теряя его).

### 4.8. `session`

- [ ] `session list` — активная `*`, id (12), имя, msgs, дата; пусто → `session.no_sessions`.
- [ ] `session show <id>` — meta (ID/Name/Created/Updated/Messages/Model/Context/Project).
- [ ] При наличии MoE-событий — секция `MoE events` (`plan`/`subtask`/`replan`/`verify` + usage).
- [ ] При наличии `llm_usage` — `cli.session_usage` + hit-rate кэша (`cli.session_cache`).
- [ ] `session show <несуществующий>` → `session.not_found`.
- [ ] `session delete <id>` → `session.deleted`.

### 4.9. `security`

- [ ] `security status` — все флаги (bash/paths/network/contentScan/recursion/fileOps/rateLimit/encryption/audit), `yes`/`no`.
- [ ] `security policies` — `strict`/`balanced`/`permissive` с именем, описанием, `recommendedFor`.
- [ ] `security set-policy balanced` → `policy_applied` + описание; неверный пресет → `invalid_preset`.
- [ ] `security enable-encryption` / `disable-encryption` → статус меняется, user-поля (keyPath) сохраняются.
- [ ] `security enable-audit` / `disable-audit` → `enabled` флипается, webhookUrl/filePath сохраняются.
- [ ] `security audit-stats` — total, by severity, by type (нули тоже показаны).

### 4.10. `plugins`

- [ ] `plugins list` — внешние плагины; пусто → `cli.plugins.none` + `only_external`.
- [ ] `plugins list --all` (`-a`) — включая builtin (mark `[builtin]`), без строки `only_external`.
- [ ] Version/source отображаются корректно, `-` при отсутствии.

### 4.11. `changelog`

- [ ] `changelog` — заголовок + последняя запись.
- [ ] `changelog --from <version>` — диапазон от версии до текущей; не найдено → `changelog_not_found`.
- [ ] Вывод читаем, без «сырых» markdown-артефактов.

### 4.12. Глобальные флаги CLI

- [ ] `-d <dir>` — агент работает в указанной директории (видно в баннере `repl.work_dir`).
- [ ] `--no-agents-md` — в баннере `repl.agents_label` = `repl.disabled` (красным).
- [ ] `--exit-on-complete` — завершение после первого финального ответа, интерактивные тулы не блокируют stdin.
- [ ] `--reasoning <level>` (`auto`/`none`/`low`/`medium`/`high`/`max`) — уровень в промпте.
- [ ] `--verbose` — включает подробный вывод, не подавляет info-логи.
- [ ] `--context-log` — создаётся `<session>/context.diff` в git-подобном формате; секреты редактурируются.

---

## 5. REPL: слэш-команды

### 5.1. general

- [ ] `/help`, `/exit` (+ `/quit`, `/q`), `/clear` — работают; `/exit` корректно завершает.
- [ ] `/run <prompt>` — запускает агента с данным промптом; без аргумента → usage.
- [ ] `/image <path|url|clipboard>` (+ `/img`) — картинка прикрепляется (`image.attached`), нет файла → `image.not_found`, пустой клипборд → `image.clipboard_empty`.
- [ ] `/image clipboard` на не-TTY / без картинки — понятная ошибка, не падение.

### 5.2. agent

- [ ] `/config` — model/provider/context(с разбивкой)/max_iters/stuck/reasoning/logLevel/locale/session.
- [ ] `/config migrate` — та же логика, что CLI `config migrate`.
- [ ] `/status` — компактная сводка model/provider/session.
- [ ] `/reasoning` — toggle show/hide; `/reasoning high` — установка уровня; неверный уровень → жёлтая подсказка с валидным списком.
- [ ] `/verbose` — toggle quiet↔verbose; `/verbose normal` — явный уровень; неверный → жёлтая подсказка. В quiet info-логи и тела тулов скрыты.
- [ ] `/provider` / `/provider list` / `/provider use <name>` / `/provider add <name> [--url --key --priority --context-window --rpm --parallel]`.
- [ ] `/provider add` без значения флага → `repl.provider_add_missing_value` (красным, stderr).
- [ ] `/provider add` без URL → `cli.provider_no_url`; после успеха `repl.provider_switch_hint` с именем.
- [ ] `/model` / `/model list` / `/model use <name>` — список моделей с cert-марками, переключение.
- [ ] `/context` — разбивка + usage; `/context 64000`; `/context system 0.1`; невалид → подсказки.
- [ ] `/reload` — перезагрузка модулей, затем сводка model/context/provider.
- [ ] `/wizard` (+ `/setup`) — повторный мастер, `config_saved`, конфиг переприменён к агенту.
- [ ] `/sysprompt` — токены, рамка `─`, текст, `excluded_blocks` при наличии.
- [ ] `/map [action] [query]` — как CLI `map`.
- [ ] `/lsp status|restart|check <path>` — статус/сброс disabled/чек; нет модуля → `repl.lsp_not_available`.
- [ ] `/plugins [--all]` — как `plugins list`; по умолчанию builtin скрыты с подсказкой.

### 5.3. session

- [ ] `/sessions` (+ `/ls`) — таблица (без box-рамки: bold-заголовок + dim-линейка), активная `●`, hint resume.
- [ ] `/new [name]` (+ `/create`) — сессия создана, экран очищен, `session.chat_cleared`.
- [ ] `/resume` — список доступных; `/resume <id|prefix|name>` — загрузка истории, `session.resumed`, `user_label`/`assistant_label`.
- [ ] `/resume <нет> — `session.no_match`.
- [ ] `/rename <name>` — `session.renamed`; без имени → usage; без активной → `session.no_active`.
- [ ] `/delete <id>` (+ `/rm`) — `session.deleted`; нет совпадения → `session.no_match`; без аргумента → usage.

### 5.4. skill

- [ ] `/skill` / `/skill list` — доступные скиллы, `[loaded]`-маркер, токены, описание.
- [ ] `/skill loaded` — загруженные + budget (used/total/remaining).
- [ ] `/skill load <name>` / `/skill unload <name>` — успех зелёным / ошибка красным.
- [ ] `/skill search <q>` — совпадения или `repl.no_skill_match`.
- [ ] `/skill bogus` — красная `repl.skill_unknown_sub` + usage.

---

## 6. Ввод и клавиатура

- [ ] **Esc Esc** во время прогона — прерывание (`repl.interrupt`), агент глушится; быстрый двойной Esc ловится.
- [ ] **Ctrl+C** во время прогона — прерывание + таймер форс-выхода (`repl.ctrl_c_interrupt`, затем `repl.force_exit` через ~5с).
- [ ] **Ctrl+C** в покое — корректный выход (exit 0), сессия сохраняется.
- [ ] **Ctrl+O** — перепечатывает последнее действие (или `repl.last_action_none`).
- [ ] **Ctrl+V** — вставка картинки из клипборда (в покое), сообщение `image.attached`.
- [ ] **Многострочный ввод:** строка с висящим `\` или незакрытыми `{` продолжается (промпт `you_reasoning_cont`).
- [ ] **Tab completion:** команды с описаниями; файловые пути; цикл по кандидатам; Esc возвращает исходный ввод.
- [ ] **↑/↓** — история команд/навигация по кандидатам completion.
- [ ] **Пустой Enter** — перерисовка промпта без запуска агента.
- [ ] **Строка, начинающаяся с `/`** — команда; иначе — промпт агенту (`>` эхо).
- [ ] Промпт показывает уровень reasoning (`auto` / `auto→<level>` / фиксированный).
- [ ] Ввод не «протекает» в поток вывода агента во время стрима (frame suspend/resume).

---

## 7. One-shot и JSON-режимы

- [ ] `bun run mma "<промпт>"` — стрим ответа, спиннер, лог тулов (`◇ <friendly label> · args ✓ ms`), футер модель/провайдер/длительность.
- [ ] `bun run mma "<промпт>" --json` — только валидный JSON в stdout; человеческий вывод подавлен; схема `run-result`/`json-payload`.
- [ ] `bun run mma "<промпт>" --json` при ошибке — валидный JSON-документ ошибки (без стектрейса), exit 1.
- [ ] Обрезка по `max_tokens` при уже стримленном тексте — non-fatal warning `error.llm_output_truncated` в чат, ответ остаётся.
- [ ] `--verbose` в one-shot — подробный вывод; без него — quiet.
- [ ] Перенос длинных строк, code-block gutter `│` (без `┌─┐`), markdown корректен.

---

## 8. Интерактивные тулы агента

Агент может остановиться и спросить пользователя. Это **интерактивные** тулы:
`question` (свободный вопрос/меню, глиф `?`, без спиннера — `SPINNERLESS_TOOLS`) и
`approve` (меню Yes/No). Вопрос идёт через `PromptIO`, который на время берёт терминал
и возвращает состояние стрима после ответа.

- [ ] Промпт «спроси меня, какой фреймворк выбрать» → агент вызывает `question`; в чате глиф `?` (спиннера нет), нумерованное меню вариантов.
- [ ] Выбор номером → продолжение с учётом ответа; `/verbose` показывает детали.
- [ ] Неверный ввод в меню → повторный запрос, **меню печатается один раз** (не дублируется).
- [ ] Вариант «свой ответ» (custom) при `allowCustom` → ввод свободного текста.
- [ ] Несколько вопросов за раз → заголовок `tool.question.progress` (`Question i/N`).
- [ ] Свободный вопрос без опций → обычный ввод строки.
- [ ] `approve`: действие, требующее подтверждения → меню `tool.approve_prompt`; `Yes` → `tool.approved`, `No` → `tool.rejected`.
- [ ] `--exit-on-complete` / one-shot + `question`/`approve` → `tool.interactive_disabled`, stdin **не блокируется**, прогон завершается.
- [ ] Protected path (`write_file` в `.env`/`*.key`/`.git/…`) → **жёлтая** мягкая директива «спроси пользователя»; сырой `file.protected_path_ask`/`[SECURITY BLOCKED]` в чат **не** попадает.
- [ ] Во время вопроса DSR-запрос курсора не шлётся (важно для Windows/ConPTY).
- [ ] Ответ на вопрос возвращает промпт и не оставляет артефактов кадра.

---

## 9. План и todo

`plan` (структурный тул) рендерит чек-лист `formatPlanChecklist`; `todo` управляет подзадачами.

- [ ] После `plan create` в чате появляется блок: `◇ <title>  ▰▱▱▱▱▱▱▱▱▱ done/total`.
- [ ] Шаги: `✓` done, `◇` in_progress (cyan), `✗` failed (red), `–` skipped (dim), `○` pending (dim); активный шаг — жёлтый.
- [ ] Подзадачи выводятся с отступом (`✓`/`○`).
- [ ] `plan update` → одна строка `ui.plan_update` (`step N → status`), **без** сырого JSON шага.
- [ ] `todo` → короткая строка `ui.todo_action` (`action · count`), без JSON.
- [ ] Перед действием, затрагивающим файл из шага, печатается `↳ ui.step_context` (`step id: desc`).
- [ ] `plan update` **не** перезаписывает шаги (валидируется 1:1); битый update не ломает список.
- [ ] Список не дублируется и не «съезжает» при нескольких итерациях; прогресс-бар консистентен.

---

## 10. Прогресс и телеметрия хода

- [ ] Футер хода: `⟡ <model> · <provider> · <duration>`.
- [ ] Контекст-бар (`ui.showContextStats`): заполнение, % и компакция (`⟳ Context compacted (N)` только при росте счётчика).
- [ ] API-строка (`prompt + completion = total`) и cost-строка при `showContextStats`.
- [ ] Cache-строка (`formatCacheLine`): `repl.cache` (hit + saved) при токенах кэша; `repl.cache_nosave` без экономии; `repl.prefix` только при **реальном** разрыве префикса (не `none`/`unknown`).
- [ ] В футере тула — `ctx`-дельта (`+N` зелёным / `N ↓` жёлтым) и `cost` при наличии.
- [ ] Quiet: серия read-only тулов сворачивается в `│ N actions ✓ · duration · /verbose`; одиночный — в одну строку.
- [ ] Вывод тула ограничен (`MAX_OUTPUT_LINES`), при превышении — `... (N more lines)`.
- [ ] Метрики показываются **один раз за ход**, не спамят на каждой итерации.
- [ ] На бэкенде без cache-токенов лишняя cache-строка не печатается.

---

## 11. MoE и субагенты

Agent-Level MoE (`moe.enabled`) и тул `subagent` меняют поток, но не должны шуметь в чате.

- [ ] При `moe.enabled` внутренние MoE-статусы (plan/re-plan/execute/scope) видны **только** при `ui.verbose`/`/verbose`/`--verbose`.
- [ ] `mma session show <id>` показывает секцию `MoE events` (plan/subtask/replan/verify + usage по expert_tag).
- [ ] `Esc` во время MoE прерывает прогон без fallback; очередь сабтасков не стартует.
- [ ] `subagent` рендерится как обычный тул (execute/meta), без утечки системного имени.
- [ ] Ошибка сабтаска/битый план → понятный partial failure в чате, не сырая директива.
- [ ] `ui.verbose=false` (default) — чат чистый, никаких «plan/re-plan» one-liners.

---

## 12. Оверфлоу, failover и баннерные пробы

- [ ] **Prompt overflow (AGENTS.md/карта проекта слишком велики):** на старте `prompt.overflow.startup` сообщает суммарную потребность (`~N токенов`) и конкретный фикс (`mma context <N>` / `contextBudget.systemPrompt`).
- [ ] При `instructions.summarize` — `prompt.overflow.summarizing`/`compressing`, затем блок суммаризируется; при сбое — `summarize_failed` + truncation.
- [ ] Подсказка предлагает прочитать полный AGENTS.md через `read_file` (hint-блок).
- [ ] **Context probe:** `repl.context_probe_small` (загружено меньше настроенного, жёлтым) / `repl.context_probe_big` (dim). Не-LM-Studio → тихо, без строки.
- [ ] **Provider failover:** при >1 `provider.entries[]` недоступный **неактивный** провайдер → предупреждение `repl.provider_down`.
- [ ] **LSP-баннер:** `✓ <lang> (1.2s)` для живых серверов, `✗ <lang> — timeout/failed` для упавших; LSP disabled/no-server → строки нет.
- [ ] **MCP-баннер:** при включённых MCP-серверах строка `repl.mcp_label` с числом и именами.
- [ ] Ни одна из проб не блокирует старт (баннер печатается сразу, пробы — в фоне).
- [ ] **Auto-update:** `updater.available` / `updater.installed` (с changelog) появляются, не ломая промпт; в dev-режиме самообновление не запускается.

---

## 13. Секьюрность в рантайме и protected paths

Проверяется не только флаг/статус (см. §4.9), но и фактическое поведение.

- [ ] `security enable-encryption` → новые `history/session`-файлы зашифрованы; `session show` читает их; `disable-encryption` возвращает читаемый вид.
- [ ] `security enable-audit` → события пишутся/уведомляются; `audit-stats` увеличивает счётчики (total/severity/type).
- [ ] `security set-policy strict` → опасная команда блокируется; в чат идёт **жёлтая** подсказка, а не сырой `[SECURITY BLOCKED]`.
- [ ] `set-policy permissive`/`balanced` меняют строгость предсказуемо.
- [ ] `paths.enabled` → запись за пределы разрешённых путей блокируется с понятным сообщением.
- [ ] Rate limits (`rpm`/`parallel`) из `provider add` соблюдаются (нет 429-шторма).
- [ ] Все security-подсказки локализованы и не выглядят как «красная ошибка».

---

## 14. Изображения и vision

- [ ] `/image <path>` / `/image <url>` / `Ctrl+V` → `image.attached` с размером; картинка уходит в контекст.
- [ ] `browser` screenshot при `capabilities.vision=true` → возвращается изображение (`image_url`); без vision → текстовый snapshot с пометкой.
- [ ] Base64 картинки **не** попадает в `role:"tool"` (только текст) и прикрепляется к следующему user-сообщению.
- [ ] Переключение `/model use`/`/provider use` меняет capabilities без перезапуска (vision-гейт пересчитывается).
- [ ] Ручной override `modelCapabilities[model]` перекрывает пресет и probe.
- [ ] Слишком большая картинка ресайзится (≤800px), не роняя прогон.

---

## 15. Стриминг и markdown

- [ ] Rich-TTY: текст стримится посимвольно/пословно; частичная строка **не** двоится и не «съезжает» при переносе.
- [ ] Частичная строка, которая перенеслась бы за ширину терминала, замораживается (нет некорректного откатa курсора).
- [ ] Code-block: gutter `│` (без `┌─┐`), отступ `reservedCols` учитывает префикс `- ` в списках.
- [ ] Таблицы: bold-заголовок + dim-линейка + выровненные колонки (без box-drawing `│─┼`).
- [ ] Reasoning: `✦ <label> · `, текст dim; `/reasoning` переключает показ; уровень фиксируется в промпте.
- [ ] Метка размышления вращается (`ui.thinking_label*`), первая фаза — каноничная.
- [ ] Длинный thinking не перемешивается с телом ответа (thought-блок корректно закрывается duration).

---

## 16. Соответствие стилю (STYLE.md)

- [ ] Никаких boxed-панелей в чате: code-block — gutter `│`, таблицы — bold-заголовок + dim-линейка (`src/ui/table.ts`).
- [ ] Системные имена тулов (`read_file`, `bash`, …) **никогда** не видны — только `tool.friendly.*`.
- [ ] Цвет `◇` совпадает с цветом ярлыка; категории: recon cyan / mutate magenta / execute blue / meta dim.
- [ ] Разделители `·` между ярлыком и аргументами, между статусом и содержимым; аргументы dim.
- [ ] Quiet по умолчанию: одна строка на действие, метрики раз за ход; детали — `/verbose`, `--verbose`, `Ctrl+O`.
- [ ] Семантические цвета: `✓` зелёный, `⚠` жёлтый, `✗` красный (только реальные сбои), security-блоки — жёлтые, не красные.
- [ ] Спиннеры обновляются in place, без скролл-спама; thinking `✦` re-запускается на фазу.
- [ ] Ошибки спокойны: одна строка + максимум одна подсказка; model-facing recovery-директивы в чат не попадают.
- [ ] Emoji-иконки тулов не рендерятся.
- [ ] Первый запуск: `box()` только в мастере; баннер REPL — строки с отступами, без рамки.

---

## 17. Локализация (en / ru)

- [ ] Переключение `locale` (в мастере / `/config` / `config set locale ru`) меняет язык всех пользовательских строк.
- [ ] `en` и `ru` в паритете: нет «сырых» ключей вида `repl.foo` и нет английских строк в ru-режиме (и наоборот).
- [ ] Tool labels локализованы (`tool.friendly.*`): «Чтение файла» / «Reading file».
- [ ] Подсказки справки, ошибок, usage, session-таблиц переведены.
- [ ] Русский текст не ломает выравнивание колонок/переносы.

---

## 18. Кросс-платформенные / краевые случаи

- [ ] **Не-TTY** (пайп/редирект): REPL fallback не сыпет escape-последовательностями; `--json` чист.
- [ ] **Очень узкий терминал** (40–60 колонок): строки переносятся, глифы/таблицы не рвутся.
- [ ] **Курсор/ConPTY (Windows):** мастер не получает ответы «R» от DSR (в `question()` DSR не шлётся).
- [ ] **Прерывание мастера** (`Ctrl+C`) не оставляет полу-записанный конфиг.
- [ ] **Падение агента/тула:** чистый одно-строчный `✗`, shutdown отрабатывает, REPL остаётся жив.
- [ ] **Долгие прогоны:** контекст-бар/компакция (`⟳`) отображаются корректно; статус-луп останавливается.
- [ ] **Крэш:** запись в `~/.mma/logs/crash.jsonl`, а не голый стек в stderr.
- [ ] **Обновление пакета:** авто-апдейтер не блокирует старт; в dev-режиме (`src/`) не пытается самообновиться.
- [ ] **Цвет:** `NO_COLOR=1` и `CI=1` отключают цвета; вывод остаётся структурно читаемым (глифы/отступы сохраняются).
- [ ] **Конфиг проекта:** `.mmrc` в рабочей директории перекрывает глобальный конфиг; приоритет AGENTS.md — `baseDir` → `baseDir/.mma` → `configDir` (видно в баннере `repl.agents_label`).
- [ ] **Environment-строка:** `Environment: … mma <версия>` совпадает с `package.json` (иначе правки «не работают» — см. §1).

---

## 19. Быстрый smoke-чеклист (5–10 минут)

- [ ] Чистый профиль → `bun run mma` → мастер → REPL-баннер.
- [ ] `mma --help`, `mma --version`, `mma <cmd> --help` для 3–4 команд.
- [ ] REPL: `/help`, `/config`, `/status`, `/model`, `/sessions`.
- [ ] Один «живой» промпт: увидеть `◇`-строку тула, `✓`, метрики, футер.
- [ ] `/new`, `/rename`, `/resume`, `/delete`.
- [ ] Интерактив: промпт, вызывающий `question`, и `approve` (меню Yes/No).
- [ ] Многошаговый промпт: `plan`-чек-лист (`▰▱`) и `todo`-строка.
- [ ] `--json` one-shot: валидный JSON.
- [ ] `locale ru` → ключевые строки переведены.
- [ ] Esc Esc / Ctrl+C / Ctrl+O / Tab-completion.

---

## 20. Шаблон отчёта о баге

```
Заголовок:      <кратко>
Приоритет:      P0 | P1 | P2
Окружение:      ОС, терминал, mma <версия>, locale, provider
Шаги:           1) …  2) …  3) …
Ожидалось:      …
Фактически:     …
Стиль (STYLE):  пункт, который нарушен (если применимо)
Сессия/лог:     путь к session.jsonl / context.diff (если есть)
```
