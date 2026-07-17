# MMA — Micro Models Agent

LLM агент-харнес для маленьких моделей (Qwen3.5-9B, 32K-64K контекст).

Работает с OpenAI-совместимыми API: LM Studio, Ollama, vLLM, Together AI и другими.

## Установка

### Глобально через npm (рекомендуется)

```bash
npm install -g micro-models-agent

# Проверка:
mma --version
```

### Из исходников

```bash
git clone <repo>
cd mma
npm install
npm run build
npm link
```

## Удаление

```bash
npm uninstall -g micro-models-agent   # удалить пакет
rm -rf ~/.mma                          # удалить конфиг, кэш, логи, сессии
```

> `~/.mma/` можно не удалять — данные останутся на случай повторной установки.

## Быстрый старт

### 1. Добавьте провайдера

Если у вас уже запущен LM Studio на `localhost:1234`:

```bash
# Провайдер уже есть в конфиге по умолчанию, можно сразу использовать
mma "Привет! Как тебя зовут?"
```

Если нужно добавить другого провайдера:

```bash
# Ollama
mma provider add ollama http://localhost:11434/v1

# vLLM
mma provider add vllm http://localhost:8000/v1

# Together AI
mma provider add together https://api.together.xyz/v1
```

### 2. Добавьте модель

```bash
# mma model add <имя_алиас> <model_id> <контекст_в_токенах>

mma model add qwen3.5-9b qwen3.5-9b-instruct 32768
mma model add qwen2.5-14b qwen2.5-14b-instruct 32768
mma model add deepseek-coder deepseek-coder-6.7b-instruct 16384
```

### 3. Используйте

```bash
# One-shot режим
mma "Создай React-компонент для формы входа"

# Интерактивный режим (REPL)
mma

# С stdin (пайп)
cat package.json | mma "Опиши зависимости"

# С выбором провайдера/модели
mma --provider ollama --model qwen3.5:9b "Напиши Dockerfile для Node.js приложения"
```

## Управление провайдерами и моделями

```bash
# Провайдеры
mma provider list              # Список провайдеров
mma provider use ollama        # Переключиться на провайдера
mma provider add <имя> <url>   # Добавить провайдера
mma provider remove <имя>      # Удалить провайдера

# Модели
mma model list                 # Список моделей активного провайдера
mma model use qwen3.5-9b       # Переключиться на модель
mma model add <имя> <id> <ctx> # Добавить модель
mma model remove <имя>         # Удалить модель
mma model params [имя]         # Параметры модели
mma model set <имя> k=v        # Изменить параметр (temperature=0.5)

# Конфиг
mma config show                # Показать весь конфиг
mma config reset               # Сбросить настройки
mma config thinking [on/off]   # Включить/выключить скрытие размышлений модели

# Обновления
mma update                     # Проверить наличие обновлений
mma update check               # Проверить версию
mma update install             # Скачать и установить обновление
```

### Параметры моделей

По умолчанию:
- `temperature`: 0.7
- `max_tokens`: 4096
- `top_p`: 0.9

Изменить:

```bash
mma model set qwen3.5-9b temperature=0.3 max_tokens=8192
mma model set qwen3.5-9b seed=42        # для воспроизводимости
mma model set qwen3.5-9b seed=null      # сбросить seed
```

## Конфигурация

Конфиг хранится в `~/.mma/config.json`.

```json
{
  "providers": {
    "lmstudio": {
      "type": "openai-compat",
      "url": "http://localhost:1234/v1",
      "apiKey": null,
      "models": {
        "qwen3.5-9b": {
          "model": "qwen3.5-9b-instruct",
          "contextWindow": 32768,
          "params": {
            "temperature": 0.7,
            "max_tokens": 4096
          }
        }
      }
    }
  },
  "active": {
    "provider": "lmstudio",
    "model": "qwen3.5-9b"
  },
  "agent": {
    "maxSteps": 50,
    "autoCompact": true,
    "compactThreshold": 0.85,
    "toolTimeout": 120,
    "maxOutputLength": 2000
  }
}
```

Можно также создать `.mmrc` в корне проекта — он смержится поверх глобального конфига.

### Переменные окружения

| Переменная | Описание |
|-----------|----------|
| `MMA_PROVIDER` | Провайдер по умолчанию |
| `MMA_MODEL` | Модель по умолчанию |
| `MMA_STDIN=1` | Принудительное чтение stdin |
## Режимы запуска

### One-shot

```bash
mma "Объясни этот код: function fib(n) { return n < 2 ? n : fib(n-1) + fib(n-2); }"
```

### Stdin (пайп)

```bash
cat main.ts | mma "Найди потенциальные баги"
curl -s https://api.example.com/data | mma "Проанализируй JSON"
```

### REPL

```bash
mma
```

В REPL доступны команды:

| Команда | Описание |
|---------|----------|
| `/read <file>` | Показать файл с нумерацией строк |
| `/write <file>` | Записать файл (до EOF) |
| `/edit <file> <n>` | Заменить строку N в файле |
| `/find <pattern>` | Поиск файлов по glob |
| `/search <pattern>` | Поиск содержимого |
| `/bash <cmd>` | Выполнить shell-команду |
| `/git <args>` | Git-операции |
| `/memory` | Показать память |
| `/memory add <type> <text>` | Добавить в память |
| `/memory search <query>` | Поиск в памяти |
| `/skill` | Список навыков |
| `/sessions` | Список сессий |
| `/resume <id>` | Восстановить сессию |
| `/save [name]` | Сохранить сессию |
| `/clear` | Очистить контекст |
| `/help` | Справка |
| `/exit` | Выход |

## Синтаксис `@file`

Загружает файлы в контекст агента:

```bash
mma "@src/index.ts -- объясни эту функцию"

# Несколько файлов
mma "@src/auth/login.ts @src/auth/jwt.ts -- сравни"

# Диапазон строк
mma "@src/index.ts:10-30 -- что здесь происходит?"

# Вся директория
mma "@src/auth/ -- покажи структуру модуля"
```

## Навыки (Skills)

Навыки — это Markdown-файлы с инструкциями для модели. Загружаются из:
- `~/.mma/skills/<name>/SKILL.md`
- `.agents/skills/<name>/SKILL.md`
- `.claude/skills/<name>/SKILL.md`

```bash
# Использовать навык
mma "@docker -- помоги контейнеризовать приложение"
```

## Агент: как это работает

1. Вы даёте задачу (prompt)
2. Модель генерирует план и вызывает инструменты через `<tool_call>`
3. Агент выполняет инструменты и возвращает результат модели
4. Модель анализирует результат и решает, что делать дальше
5. Цикл продолжается до завершения задачи (макс. 50 шагов)

### Инструменты агента

| Инструмент | Описание |
|-----------|----------|
| `read_file` | Чтение файла с нумерацией строк |
| `write_file` | Атомарная запись/создание файла |
| `edit_file` | Find & replace (точное совпадение) |
| `list_dir` | Список директории |
| `create_dir` | Рекурсивное создание директории |
| `delete_file` | Удаление файла/директории |
| `copy_file` | Копирование |
| `move_file` | Перемещение/переименование |
| `file_info` | Метаданные файла |
| `glob_search` | Поиск по паттерну |
| `grep_search` | Поиск по содержимому (regex) |
| `tree` | Дерево директорий |
| `bash` | Выполнение команд (npm, git, docker) |

## Индексация проекта

Агент автоматически строит карту проекта и индекс кода:

```bash
# Вручную перестроить
/build index rebuild
/build project-map
```

## Работа с сессиями

```bash
# Автосохранение при выходе
/save my-session-name

# Список сессий
/sessions

# Восстановить
/resume my-session-name
```

## Разработка

```bash
npm run build          # Компиляция TypeScript
npm run dev            # Watch-режим
npm test               # Тесты
npm run test:all       # Все тесты
npm run test:watch     # vitest watch
```

### Публикация новой версии

```bash
npm version patch     # или minor, major
npm publish
```

## Лицензия

MIT
