# MMA — Micro Models Agent v2

[![npm version](https://img.shields.io/npm/v/micro-models-agent)](https://www.npmjs.com/package/micro-models-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**MMA** — модульный AI-coding агент, оптимизированный для **небольших локальных языковых моделей** (9B параметров, 32K–64K контекст). Работает на ноутбуке, облачное API не требуется.

```bash
npm install -g micro-models-agent
mma "перепиши модуль авторизации на JWT"
```

Создан и протестирован с [Qwen3.5-9B](https://qwen.readthedocs.io/) через LM Studio / Ollama / llama.cpp.

---

## Зачем MMA?

Большинство AI-агентов для кода (Devin, Cursor, Copilot) завязаны на облачные модели или дорогие API. MMA работает иначе:

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
- **Agent-Level MoE** — Router + экспертные сабагенты с фильтрацией инструментов, изолированным контекстом, файловым скоупом и топологическим параллельным выполнением
- **20+ инструментов** — файловая система, шелл, веб-поиск/fetch, браузер (Playwright), планирование, взаимодействие, сабагенты, MCP, пайплайны
- **13 модулей** — скиллы, плагины, MCP-клиент, пайплайны, indexer проекта, постоянная память, контекст, сессии, браузер, выполнение, детекция галлюцинаций, апдейтер, профиль пользователя
- **MCP-клиент** — подключение к любому MCP-серверу (stdio или SSE)
- **YAML-пайплайны** — DAG-движок с параллельными волнами, зависимостями и повторными попытками
- **Управление сессиями** — постоянные JSONL-сессии с REPL-командами
- **Карта проекта** — автоматический обход файлов + извлечение экспортов + дисковый кэш
- **i18n** — все строки интерфейса через `t()`, включены английский и русский
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
bun run mma init
```

Сканирует локальные порты, находит модель, тестирует соединение и записывает конфиг.

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
bun run mma init                       # Интерактивный мастер настройки
bun run mma config set model qwen3.5-9b
bun run mma config show
bun run mma model list                 # Список доступных моделей
bun run mma model use qwen3.5-9b       # Переключить модель
bun run mma provider list              # Список провайдеров
bun run mma session list               # Список сессий
bun run mma session show <id>          # Детали сессии
bun run mma session delete <id>        # Удалить сессию
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
| `/config set <key> <value>` | | Установить значение конфига |
| `/exit` | | Выйти из REPL |

### Разработка

```bash
bun run mma "почини страницу логина"    # Запуск агента
bun run dev                             # Watch-режим (авто-перезапуск при изменениях)
bun run build:prod                      # Сборка для публикации
bun test                                # Запуск тестов
bun run typecheck                       # Проверка типов
```

---

## Конфигурация

3-слойный конфиг: `defaults.ts` → `~/.mma/config.json` (глобальный) → `.mmrc` (проект) + переменные окружения.

Ключевые опции (полный список в `src/config/defaults.ts`):

| Опция | По умолчанию | Описание |
|-------|-------------|----------|
| `model` | `qwen3.5-9b` | Имя модели для бэкенда |
| `provider.baseUrl` | `http://localhost:1234/v1` | URL OpenAI-совместимого API |
| `contextWindow` | `32768` | Контекстное окно модели в токенах |
| `autoPlan` | `true` | Авто-создание планов для многошаговых задач |
| `maxToolIterations` | `25` | Макс. вызовов инструментов за запуск |
| `stuckThreshold` | `8` | Итераций без прогресса до stuck-detection |
| `moe.enabled` | `false` | Включить Agent-Level MoE |
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
    "code": { "model": "qwen3.5-9b", "tool_tags": ["file", "code", "shell"], "max_attempts": 3 },
    "research": { "model": "qwen3.5-9b", "tool_tags": ["research"], "max_attempts": 3 },
    "browser": { "model": "qwen3.5-9b", "tool_tags": ["browser", "vision"], "max_attempts": 3 }
  }
}
```

---

## Архитектура

```
CLI (main.ts → commands.ts / repl.ts / setup.ts)
  → Core (agent.ts state machine → prompt-builder.ts)
    → LLM Layer (provider.ts → openai-compat.ts → response.ts → token-counter.ts)
      → Tools (registry.ts → executor.ts → 20+ tools)
        → Modules (skills, plugins, mcp, pipelines, indexer, memory, context, session,
                   hallucination, execution, updater, user-profile, browser)
```

### Структура проекта

```
src/
├── core/          # Цикл агента, сборщик промптов, типы
├── llm/           # Абстракция провайдера, OpenAI-совместимость, стриминг, подсчёт токенов
├── tools/         # 20+ инструментов с реестром, исполнителем, скоуп-гардами
├── modules/       # 13 модулей (скиллы, плагины, mcp, пайплайны, indexer, память, контекст, сессии, галлюцинации, выполнение, апдейтер, профиль, браузер)
├── cli/           # Точка входа, команды, REPL, мастер настройки
├── config/        # 3-слойный конфиг: defaults → глобальный → проект
├── i18n/          # en.json + ru.json + t()
├── ui/            # Markdown→ANSI форматтер
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
| `web_fetch` | Загрузка веб-страницы (15K символов, 15s таймаут) |
| `web_browse` | Браузер на Playwright (клик, ввод, скролл, скриншот) |
| `plan` | Создание/обновление/отмена планов |
| `todo` | Отслеживание задач |
| `question` | Задать вопрос пользователю |
| `approve` | Запросить подтверждение пользователя |
| `load_skill` | Загрузить скилл во время выполнения |
| `pipeline_run` | Выполнить YAML-пайплайн |
| `mcp_call` | Вызвать инструмент MCP-сервера |
| `search_history` | Поиск по истории сессий |
| `project_map` | Запрос карты проекта (summary, refresh, find) |

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
5. **Безопасность путей** — все файловые инструменты проверяют `targetPath.startsWith(baseDir)`
6. **TDD** — сначала тест, потом реализация, потом коммит
7. **Никаких захардкоженных строк** — весь текст через `t()` i18n
8. **Никакого keyword matching** — LLM решает когда планировать, не эвристики
9. **Без TUI** — минимальный CLI + REPL с markdown→ANSI

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
