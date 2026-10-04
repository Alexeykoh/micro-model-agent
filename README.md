# MMA — Micro Models Agent v2

[![npm version](https://img.shields.io/npm/v/micro-models-agent)](https://www.npmjs.com/package/micro-models-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**MMA** — универсальный агент-харнесс, оптимизированный для **небольших локальных языковых моделей** (9B параметров, 32K–64K контекст). Работает на ноутбуке, облачное API не требуется. Это не «агент только для кода»: разработка, поиск в интернете, автоматизация, работа с API, умный дом, персональный ассистент — любой сценарий.

```bash
npm install -g micro-models-agent
mma "перепиши модуль авторизации на JWT"
mma "какая погода в Москве и собери сводку за неделю"
```

Создан и протестирован с [Qwen3.5-9B](https://qwen.readthedocs.io/) через LM Studio / Ollama / llama.cpp.

---

## Зачем MMA?

Большинство агентов (Devin, Cursor, Copilot) завязаны на облачные модели или дорогие API — и предполагают, что задача про код. MMA работает иначе: это **общий** харнесс, где программирование — лишь один из сценариев.

- **Создан для моделей 9B** — оптимизирован под Qwen3.5-9B на обычном железе
- **Не требует облака** — полностью работает офлайн с любым OpenAI-совместимым бэкендом
- **Выживает в узком контексте** — умное sliding-window compaction держит 32K-модели продуктивными
- **Отлавливает галлюцинации** — 3-стадийный пайплайн валидации ловит выдумки, к которым склонны маленькие модели
- **Agent-Level MoE** — иерархическая декомпозиция задач: маленькие модели справляются со сложной многошаговой работой

---

## Возможности

- **6-состояний цикл агента** (INIT → THINK → ACT → OBSERVE → OUTPUT → ERROR) — чистый, предсказуемый, отлаживаемый
- **Управление бюджетом контекста** — динамический бюджет под модель, sliding-window compaction с извлечением фактов/решений/ошибок
- **Детекция галлюцинаций** — фактическая (пути файлов), согласованности (откат решений), уверенности (короткие/повторяющиеся ответы)
- **Гарантии выполнения** — авто-планирование через LLM (без keyword-эвристик), stuck-detection, off-track предупреждения, авто-продвижение плана
- **Agent-Level MoE** — Router + экспертные сабагенты с фильтрацией инструментов, изолированным контекстом, файловым скоупом, топологическим параллельным выполнением, re-plan-циклом и машиночитаемой верификацией (`success_criteria`)
- **Инструменты** — ФС, шелл, веб-поиск/fetch, браузер (Playwright), планирование, память, сабагенты, MCP, пайплайны, LSP, процессы. Ядро (~26) + модульные `plan`/`todo`/`verify`/`lsp_check`/`project_map`/`set_thinking`/`scope_request`; `question`/`approve` включаются только в веб-режиме
- **24 модуля** — скиллы, плагины, MCP, пайплайны, indexer, память, контекст, сессии, браузер, выполнение, детекция галлюцинаций, апдейтер, профиль пользователя, LSP, сертификация моделей, безопасность, артефакты, процессы, ценообразование, онбординг, провайдеры, reasoning, setup, webui
- **Веб-режим `mma web`** — браузерный чат (SSE + REST) на том же ядре и сессиях, без TTY; первый запуск открывает мастер настройки прямо в браузере
- **Онбординг** — `mma setup` (мастер провайдера), `mma meet` («Познакомимся»: интервью в глобальную память), `mma agents init` (генерация/улучшение `AGENTS.md`)
- **MCP-клиент** — подключение к любому MCP-серверу (stdio или SSE)
- **Модуль безопасности** — включён по умолчанию (balanced): валидация bash-команд, path/network-политики (SSRF), сканирование контента, шифрование сессий, audit-лог; always-on защита путей (`.git/`, `.env*`, ключи)
- **LSP-диагностика** — TypeScript/CSS/HTML серверы: проверка типов после каждой правки и по запросу
- **YAML-пайплайны** — DAG-движок с параллельными волнами, зависимостями и повторными попытками
- **Промпт-кешинг** — cache-подсказки (llama.cpp / OpenAI / OpenRouter) + метрики hit-rate и экономии (`⟡` cache line)
- **Context log** — `--context-log` пишет весь уходящий в модель контекст в git-подобный diff (`context.diff`)
- **Управление сессиями** — постоянные JSONL-сессии, REPL-команды, `mma session export`
- **Карта проекта** — обход файлов + извлечение экспортов + дисковый кэш с валидацией свежести (signature)
- **Единый `/config`** — реестр настроек с валидацией + сахар `/model`, `/provider`, `/context`, `/reasoning`, `/verbose`
- **i18n** — все строки интерфейса через `t()`, включены английский и русский
- **Вывод без гонок** — single-writer `OutputChannel`: никаких прямых `console.*`/stdout вне CLI и машинного JSON
- **8K–120K контекст** — адаптируется под любое контекстное окно модели
- **Без TUI** — минимальный CLI + REPL с markdown→ANSI форматированием
- **llama.cpp / Jinja proven** — проверено на граничных случаях Jinja-шаблонов (system-first, streaming fallback, явный `stream: false`)

---

## Установка

### Требования

- **Среда выполнения:** [Bun](https://bun.sh) (рекомендуется) или Node.js ≥ 20
- **LLM-бэкенд:** Любой OpenAI-совместимый сервер (LM Studio, Ollama, vLLM, llama.cpp, Together AI)

### Через npm (рекомендуется)

```bash
npm install -g micro-models-agent@latest
```

После установки команда `mma` будет доступна в терминале. Если после установки `mma` не находится — попробуйте переоткрыть терминал или выполните:

```bash
# PowerShell
npm uninstall -g micro-models-agent
npm install -g micro-models-agent@latest

# Проверка
mma --version
```

### Из исходников

```bash
git clone https://github.com/your-org/micro-models-agent
cd micro-models-agent
bun install
bun run build:prod
```

---

## Быстрый старт

### 1. Запустите LLM-бэкенд

Направьте MMA на любой OpenAI-совместимый эндпоинт. Пример с LM Studio:

```bash
# LM Studio слушает http://localhost:1234 по умолчанию
```

### 2. Запустите мастер настройки

```bash
bun run mma setup
```

Сканирует локальные порты, находит модель, тестирует соединение и записывает конфиг. Устаревший алиас: `bun run mma init`.

### 3. Используйте агента

```bash
# Одноразовый режим
bun run mma "создай REST API на Express и добавь тесты"

# Интерактивный REPL
bun run dev
```

---

## Использование

### CLI

```bash
bun run mma "<prompt>"

# Подкоманды
bun run mma setup                      # Интерактивный мастер настройки
bun run mma init                       # Устаревший алиас mma setup (мастер провайдера)
bun run mma meet                       # «Познакомимся» — интервью, пишет в память
bun run mma agents init                # Создать/улучшить AGENTS.md для workspace
bun run mma config set model qwen/qwen3.5-9b
bun run mma config show
bun run mma model list                 # Список доступных моделей (✔ = сертифицирована)
bun run mma model use qwen3.5-9b       # Переключить модель
bun run mma model certify <name>       # Сертификация модели на бэкенде
bun run mma model cert-status <name>   # Статус сертификации
bun run mma model cert-list            # Все сертификации
bun run mma model uncertify <name>     # Отозвать сертификацию
bun run mma provider list              # Список провайдеров
bun run mma provider add local --url http://localhost:1234/v1  # Добавить провайдера
bun run mma provider use opencode-zen  # Хостед-провайдер (zen / go)
bun run mma context                    # Токены/бюджет контекста (--system/--reserve)
bun run mma map [summary|refresh|find] # Карта проекта
bun run mma usage                      # Баланс провайдера (OpenRouter /key, /credits)
bun run mma security status            # Текущая конфигурация безопасности
bun run mma security policies          # Доступные политики (strict/balanced/permissive)
bun run mma security set-policy strict # Применить политику
bun run mma plugins list               # Загруженные плагины (--all — включая встроенные)
bun run mma session list               # Список сессий
bun run mma session show <id>          # Детали сессии
bun run mma session export <id>        # Экспорт сессии (--format md|json|jsonl, --out -)
bun run mma session delete <id>        # Удалить сессию
bun run mma web [--port N] [--host H] [--token T] [--no-open]  # Браузерный чат

# Флаги одноразового запуска
bun run mma "<prompt>" --json              # Машиночитаемый JSON-результат
bun run mma "<prompt>" -d <dir>            # Рабочая директория агента
bun run mma "<prompt>" --no-agents-md      # Не грузить AGENTS.md в системный промпт
bun run mma "<prompt>" --exit-on-complete  # Выйти после первого финального ответа
bun run mma "<prompt>" --context-log       # Записать контекст в <session>/context.diff
bun run mma "<prompt>" --verbose           # Подробный вывод (уровень verbosity)
bun run mma "<prompt>" --reasoning <auto|low|medium|high|max>
```

### REPL

```bash
bun run dev
```

| Команда | Алиасы | Описание |
|---------|--------|----------|
| `/help` | | Показать справку |
| `/sessions` | `/ls` | Список сессий (* = активная) |
| `/new <name>` | `/create` | Создать новую сессию |
| `/resume <id\|name>` | `/switch`, `/use` | Переключиться на сессию |
| `/rename <name>` | | Переименовать текущую сессию |
| `/delete <id>` | `/rm` | Удалить сессию |
| `/model [name]` | | Показать/сменить модель |
| `/provider [list\|use <name>\|add …]` | | Провайдеры (список/переключить/добавить) |
| `/status` | | Статус: модель, плагины, сессия, стоимость |
| `/config [<ключ> [<значение>]]` | | Единый реестр настроек (`/config reset <key>`) |
| `/context` | `/ctx` | Токены и бюджет контекста |
| `/reasoning [show\|hide\|level <...>]` | | Показ reasoning / уровень (`auto`/`low`/…/`max`) |
| `/verbose [quiet\|normal\|verbose]` | | Уровень детализации вывода |
| `/memory [get\|set\|unset\|find\|forget]` | | Просмотр/правка памяти |
| `/meet` | `/познакомимся` | Онбординг-интервью (пишет в глобальную память) |
| `/map [summary\|refresh\|find]` | | Карта проекта |
| `/export [md\|json\|jsonl]` | | Экспорт текущей сессии |
| `/image <path\|url>` | | Прикрепить изображение (или Ctrl+V) |
| `/run <cmd>` | | Выполнить shell-команду без агента |
| `/sysprompt` | | Показать системный промпт |
| `/wizard` | | Мастер настройки |
| `/skill <name>` | | Загрузить скилл |
| `/plugins` | | Плагины (`--all` — все) |
| `/lsp [status\|restart\|check <path>]` | | Диагностика LSP |
| `/reload` | | Перечитать конфиг и модули |
| `/clear` | | Очистить экран (контекст сессии сохраняется) |
| `/exit` | | Выйти из REPL |

Горячие клавиши: `Esc Esc` — прервать агента; `Ctrl+C` — выход; `Ctrl+V` — вставить изображение из буфера обмена; `Shift+Enter` — перенос строки.

### Веб-режим (`mma web`)

Тот же `bootstrap()` / `Agent` / сессии, но в браузере (SSE + REST, без TTY):

```bash
bun run mma web                                        # откроет браузер
bun run mma web --port 8080 --host 127.0.0.1 --no-open
```

- **Первый запуск** с пустым конфигом: мастер прямо в браузере (язык → провайдер → ключ → модель → контекст → безопасность → проверка). Чат закрыт, пока настройка не завершена (сервер отвечает `409 setup_required`).
- Панель настроек: модели/провайдеры, контекст, reasoning, память, скиллы, плагины/MCP, безопасность; slash-команды (`/help`, `/status`, `/config`, `/model`, `/provider`, `/memory`, …) работают и в браузере.
- Env: `MMA_WEBUI_PORT`, `MMA_WEBUI_HOST`, `MMA_WEBUI_TOKEN`, `MMA_WEBUI_OPEN=0`, `MMA_WEBUI_MAX_CLIENTS`.

### Разработка

```bash
bun run mma "почини страницу логина"    # Запуск агента
bun run dev                             # Watch-режим (авто-перезапуск при изменениях)
bun run build:prod                      # Сборка для публикации (clean → bundle → frontend → assets → minify)
bun test                                # Запуск тестов
bun run typecheck                       # Проверка типов бэкенда (tsc --noEmit)
bun run typecheck:frontend              # Проверка типов фронтенда (tsconfig.frontend.json)
bun run lint                            # Линтер Biome
bun run quality                         # typecheck + frontend + lint + fallow (dead-code gate)
```

> Прод-сборка (`build:prod`) очищает `dist`, выносит зависимости из бандла
> (`--packages external`) и минифицирует весь `dist` через esbuild. Пакет ~1.7 MB;
> в рантайме ничего не докачивается — всё приходит с `npm install`.

---

## Конфигурация

3-слойный конфиг: `defaults.ts` → `~/.mma/config/*.json` (глобальные домены; legacy `~/.mma/config.json` мигрируется автоматически, с бэкапом) → `.mmrc` (проект) + переменные окружения `MMA_*`.

Ключевые опции (полный список в `src/config/defaults.ts`, просмотр/правка — `/config` в REPL или `mma config show`):

| Опция | По умолчанию | Описание |
|-------|-------------|----------|
| `model` | `qwen/qwen3.5-9b` | Имя модели для бэкенда |
| `provider.baseUrl` | `http://localhost:1234/v1` | URL OpenAI-совместимого API (или `provider.entries[]` для failover) |
| `contextWindow` | `32768` | Контекстное окно модели в токенах |
| `contextBudget.systemPrompt` | `0.10` | Доля окна под системный промпт |
| `contextBudget.responseReserve` | `0.15` | Резерв под ответ |
| `autoPlan` | `true` | Авто-создание планов для многошаговых задач |
| `reasoning.mode` | `auto` | `auto` (политика) или фиксированный `none`…`max` |
| `reasoning.baseline` | `low` | Стартовый уровень в auto (растёт на сигналах) |
| `maxToolIterations` | `1000` | Макс. вызовов инструментов за запуск |
| `stuckThreshold` | `6` | Итераций без прогресса до stuck-detection |
| `moe.enabled` | `false` | Включить Agent-Level MoE |
| `security.enabled` | `true` | Модуль безопасности (balanced-политика по умолчанию) |
| `ui.verbosity` | `normal` | `quiet` / `normal` / `verbose` |
| `locale` | `en` | Язык интерфейса (`en` / `ru`) |
| `logLevel` | `info` | Уровень логирования |

### Agent-Level MoE

```json
{
  "moe": { "enabled": true },
  "orchestrator": {
    "model": "qwen3-70b-414k",
    "provider": { "baseUrl": "http://localhost:1234/v1" }
  },
  "experts": {
    "code": { "model": "qwen/qwen3.5-9b", "tool_tags": ["file", "code", "shell"], "max_attempts": 3 },
    "research": { "model": "qwen/qwen3.5-9b", "tool_tags": ["research"], "max_attempts": 3 },
    "browser": { "model": "qwen/qwen3.5-9b", "tool_tags": ["browser", "vision"], "max_attempts": 3 }
  }
}
```

---

## Архитектура

```
CLI (main.ts → commands.ts / repl.ts / setup.ts / web-command.ts)
  → Core (agent.ts state machine → bootstrap.ts buildSystemInfo)
    → LLM Layer (provider.ts → openai-compat.ts → cache-usage.ts → token-counter.ts)
      → Tools (registry.ts → executor.ts → core tools + module-registered)
        → Modules (skills, plugins, mcp, pipelines, indexer, memory, context, session,
                   hallucination, execution, updater, user-profile, browser, lsp,
                   security, certification, artifacts, processes, pricing,
                   onboarding, providers, reasoning, setup, webui)
  → Output (OutputBus → OutputChannel single writer; JSON/SSE sinks)
```

### Структура проекта

```
src/
├── core/          # Цикл агента, bootstrap/системный промпт, WebHost, типы
├── llm/           # Абстракция провайдера, OpenAI-совместимость, стриминг, токены, кеш-метрики
├── tools/         # Ядро инструментов (~26) + реестр, исполнитель, скоуп-гарды
├── modules/       # 24 модуля (скиллы, плагины, mcp, пайплайны, indexer, память, контекст,
│                  #   сессии, галлюцинации, выполнение, апдейтер, профиль, браузер, LSP,
│                  #   безопасность, сертификация, артефакты, процессы, цены, онбординг,
│                  #   провайдеры, reasoning, setup, webui)
├── output/        # Single-writer OutputChannel + OutputBus, JSON/SSE sinks
├── cli/           # Точка входа, команды, REPL, мастера (setup), `mma web`
├── config/        # 3-слойный конфиг: defaults → домены → проект
├── i18n/          # en.json + ru.json + t()
├── ui/            # Markdown→ANSI форматтер, renderer, line-editor
└── logger/        # Структурированный логгер с уровнями и дочерними логгерами
```

---

## Инструменты

| Инструмент | Описание |
|------------|----------|
| `read_file` | Чтение файла с offset/limit |
| `write_file` | Создание/перезапись с созданием директорий |
| `edit_file` | Поиск-и-замена в существующих файлах |
| `glob` | Поиск по glob-паттернам |
| `grep` | Поиск по содержимому через ripgrep |
| `list_dir` | Список содержимого директории |
| `create_dir` | Создание директории (рекурсивно) |
| `delete_file` | Удаление файла или пустой директории |
| `move_file` | Перемещение/переименование файла или директории |
| `file_info` | Метаданные файла/директории |
| `bash` | Выполнение shell-команд |
| `subagent` | Изолированный сабагент со скоупом |
| `web_search` | Поиск в интернете |
| `web_fetch` | Загрузка веб-страницы → markdown (~5K символов, 15s таймаут, SSRF-safe редиректы) |
| `web_browse` | JS-less HTTP fetch страницы без движка (до 3K символов) |
| `browser` | Браузер на Playwright (клик, ввод, скролл, скриншот) |
| `plan` | Создание/обновление/отмена планов |
| `todo` | Отслеживание задач |
| `load_skill` | Загрузить скилл во время выполнения |
| `pipeline_run` | Выполнить YAML-пайплайн |
| `mcp_call` | Вызвать инструмент MCP-сервера |
| `search_history` | Поиск по истории сессий |
| `project_map` | Запрос карты проекта (summary, refresh, find) |
| `chunk_query` | Параллельная обработка больших текстов чанками |
| `download_file` | Скачать бинарный файл по URL на диск |
| `process_list` / `process_log` / `process_kill` | Управление фоновыми процессами |
| `remember` / `recall` | Постоянная память агента |
| `attach_image` | Прикрепить изображение (файл/URL/буфер обмена; в контекст — при vision-модели) |
| `enable_tools` | Включить скрытые группы инструментов на ходу |
| `lsp_check` | Диагностика LSP (TypeScript/CSS/HTML) |
| `verify` | Верификация шагов плана |
| `session_info` | Сведения о текущей сессии (id, модель, контекст, сообщения) |
| `set_thinking` | Сменить уровень reasoning для следующих итераций |
| `scope_request` | Запросить расширение файлового скоупа сабагента |
| `question` / `approve` | Интерактивные меню (регистрируются только в веб-режиме `mma web`) |

> Примечание: в терминале интерактивные тулзы `question`/`approve` не регистрируются — модель задаёт вопросы текстом. В `mma web` они работают через SSE + `POST /api/answer`.

---

## Тестирование

```bash
bun test                              # Модульные + компонентные тесты
bun test tests/agent.test.ts          # Один файл
bun run test:integration              # Интеграционные тесты (требуют LLM-бэкенд)
bun run typecheck                     # Проверка типов
```

### Тестирование агента из консоли (agent-driven)

MMA можно тестировать в одноразовом headless-режиме без интерактивного REPL — это удобно для проверки фич и регрессий из терминала или другим агентом:

```bash
# Одноразовый прогон: без AGENTS.md, выход сразу после ответа, песочница
bun run mma "<промпт>" --no-agents-md --exit-on-complete -d <путь-к-песочнице>
```

- **Песочница** — всегда внутри `_testing/` в корне проекта (например `_testing/<case-name>/`), никогда в корне или в `src/`. Папка `_testing/` добавлена в `.gitignore`.
- **`--no-agents-md`** — не грузить AGENTS.md проекта в системный промпт (чистая среда).
- **`--exit-on-complete`** — выйти сразу после первого финального ответа; интерактивные тулзы (`question`/`approve`) не блокируют stdin, а возвращают ошибку.
- **`-d <dir>`** — рабочая директория агента (туда он создаёт файлы).
- Каждый прогон сохраняется в сессию `~/.mma/sessions/<id>/` — можно посмотреть через `bun run mma session list` / `session show <id>`.

---

## Принципы дизайна

1. **Ни одного файла >300 строк** — разделяй при приближении к лимиту
2. **Маленькие файлы, одна ответственность** — каждый файл делает одно дело
3. **KISS state machine** — никаких god-объектов, никакой вложенности if-else в цикле агента
4. **Изоляция ошибок плагинов** — падение одного плагина не останавливает другие
5. **Безопасность путей** — файловые инструменты резолвят `realpath` (защита от symlink/junction вне `baseDir`) и блокируют always-on защищённые пути (`.git/`, `.env*`, ключи)
6. **Single-writer вывод** — всё через `OutputChannel`; прямой stdout только в CLI и машинном JSON
7. **TDD** — сначала тест, потом реализация, потом коммит
8. **Никаких захардкоженных строк** — весь текст через `t()` i18n
9. **Никакого keyword matching** — LLM решает когда планировать, не эвристики
10. **Без TUI** — минимальный CLI + REPL с markdown→ANSI

---

## Лицензия

MIT

---

## Благодарности

- [Qwen3.5-9B](https://qwen.readthedocs.io/) — основная целевая модель
- [LM Studio](https://lmstudio.ai/) — рекомендуемый локальный инференс-сервер
- [llama.cpp](https://github.com/ggerganov/llama.cpp) — инференс-движок

---

**Сделано для локальных моделей. Работает везде.**
