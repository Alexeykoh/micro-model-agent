# MMA — Архитектура и План Реализации

> Bash-first, JSON-light, small-model-first.

**Ключевые инсайты из исследования:**

| Проблема | Решение | Источник |
|----------|---------|----------|
| "Structure Tax" — маленькие модели ломаются на JSON+код | CodeAct / bash как единый инструмент | F8, F3-small |
| JSON tool calling требует много токенов | Один bash-инструмент ~ 0 токенов overhead | F5-bash |
| Контекст 32K быстро забивается | Auto-compact при 85%, sliding window, priority tiers | F7, F2-small |
| Маленькие модели плохо следуют сложным схемам | Poka-yoke тулы, плоские схемы, минимум параметров | F8 |
| Ошибки парсинга каскадно роняют成功率 (21%) | Few-shot примеры, constrained decoding | F8[3] |
| "Lost in the Middle" для длинных контекстов | System prompt + критические данные в начале и конце | F2-small |
| План теряется при eviction из контекста | Persistent state в файлах (AutoMEM pattern) | F7[8] |
| Большой проект не помещается в контекст | Project map + code index + lazy loading | Aider repo-map, MemGPT |

---

## 1. Высокоуровневая архитектура

```
┌─────────────────────────────────────────────────┐
│                 CLI (commander)                   │
│  MMA --model qwen3.5:9b "make a rest api"        │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│             Agent Loop (ReAct)                   │
│  Observe → Think → Act → Observe → ...          │
│  • Context Manager (бюджет токенов)              │
│  • Tool Router (bash, MCP, skills)               │
│  • Project Index (map + symbol index)            │
│  • Memory Tier (рабочий набор + файловое хранилище)│
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│          LLM Provider Abstraction                 │
│  OpenAI-совместимые (Ollama, vLLM, Together, ...)│
│  • Единый интерфейс: chat/completions            │
│  • Стриминг + tool_choice                        │
│  • Подсчёт токенов                               │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│          Execution Layer (Bash)                   │
│  • Bash как основной инструмент                   │
│  • MCP серверы для протокольных тулов             │
│  • Инъекция Skills/AGENTS.md + Project Map       │
│  • Safety санитайзер + timeout + обрезка          │
└─────────────────────────────────────────────────┘
```

---

## 2. Абстракция провайдера

Единый интерфейс для OpenAI-совместимых API (LM Studio, Ollama, vLLM, Together, OpenAI):

```ts
interface LLMProvider {
  chat(messages, options?): AsyncIterable<Chunk>
  countTokens(text): number
  model: string
  contextWindow: number
}

interface ChatOptions {
  tools?: Tool[]
  tool_choice?: 'auto' | 'none' | { type: 'function', function: { name: string } }
  temperature?: number     // 0.0-2.0, default: 0.7
  top_p?: number           // 0.0-1.0, default: 1.0
  max_tokens?: number      // максимум токенов в ответе
  stop?: string[]          // стоп-токены
  frequency_penalty?: number  // -2.0 to 2.0
  presence_penalty?: number   // -2.0 to 2.0
  seed?: number            // детерминированный вывод (если поддерживается)
}
```

**Дефолтный провайдер — LM Studio:**
- URL: `http://localhost:1234/v1`
- LM Studio — нативный OpenAI-compatible API, zero-config для локальных моделей
- Авто-детекция: если `http://localhost:1234` отвечает → LM Studio
- Fallback: если LM Studio недоступен → пробуем Ollama (`http://localhost:11434/v1`)

**Почему LM Studio как дефолт:**
- GUI для управления моделями (проще для пользователя)
- Нативный OpenAI API без костылей
- Автоматическое управление памятью GPU
- Поддержка всех форматов (GGUF, SafeTensors, etc.)

**Почему только OpenAI-compat?**
- Qwen, Llama, Mistral — все отдают OpenAI API через LM Studio/Ollama/vLLM
- Anthropic — отдельный bridge (можно добавить позже)
- Меньше кода = меньше токенов на описание провайдеров

**Подсчёт токенов:**
- Используем `js-tiktoken` (WASM-версия tiktoken) — быстрый, без нативных зависимостей
- Fallback: подсчёт по ~4 символа на токен (грубая оценка, но sufficient для budget tracking)
- Не включаем в context window: подсчёт токенов должен быть дешёвым по памяти

---

## 3. Bash-First Tool Design (ключевое решение для 9B)

**Два уровня доступа к инструментам:**

### Уровень 1: LLM → bash (для агента)

Вместо 12 отдельных JSON-тулов (как в OpenCode) — **ОДИН** bash-инструмент для LLM:

```
Tool: bash
Description: Execute a shell command in the project directory.
  Use this for ALL file operations, code reading, git, npm, etc.
  Examples:
    bash(cmd="ls -la")              → list files
    bash(cmd="git diff")            → show changes
    bash(cmd="cat src/index.ts")    → read file
    bash(cmd="npm test")            → run tests
Parameters:
  cmd: string — the command to execute (PowerShell on Windows)
  timeout?: number — seconds before timeout (default 120, max 600)
```

### Уровень 2: User → slash-команды (для пользователя)

Slash-команды для ПРЯМОГО доступа к файловой системе БЕЗ LLM:

| Команда | Описание | Пример |
|---------|----------|--------|
| `/bash <cmd>` | Shell команда | `/bash ls -la` |
| `/read <file>` | Прочитать файл | `/read src/index.ts` |
| `/search <pattern>` | Поиск по содержимому | `/search "function login"` |
| `/find <pattern>` | Поиск файлов | `/find "*.test.ts"` |
| `/edit <file>` | Редактировать файл | `/edit src/index.ts` |
| `/write <file>` | Записать файл | `/write src/new.ts` |
| `/git <args>` | Git операции | `/git status` |

**Как это работает вместе:**

```
MMA> /read src/auth/login.ts           ← пользователь читает файл напрямую (0 токенов)
  1: import { signToken } from './jwt';
  ...

MMA> добавь тесты для login             ← LLM делает через bash tool (~5K токенов)
  [tool] bash: cat src/auth/login.ts
  [tool] bash: npm install -D vitest
  [tool] bash: cat > src/auth/__tests__/login.test.ts << 'EOF'...
  ✓ Готово.
```

### Ссылки на файлы через `@`

Файлы и пути передаются через `@` — как в Claude Code / Cursor / Aider:

| Синтаксис | Описание | Пример |
|-----------|----------|--------|
| `@<file>` | Один файл | `посмотри @src/index.ts` |
| `@<dir>/` | Всю директорию | `проверь @src/auth/` |
| `@<file>:<line>` | Конкретную строку | `баг в @src/auth/login.ts:15` |
| `@<file>:<start>-<end>` | Диапазон строк | `покажи @src/index.ts:10-50` |
| `@<glob>` | Глоб-паттерн | `найди баги в @src/**/*.test.ts` |
| `@<file1> @<file2>` | Несколько файлов | `сравни @src/a.ts @src/b.ts` |
| `@<file> -- <prompt>` | Файл + команда | `@src/auth/login.ts -- добавь типизацию` |

**Как обрабатывается:**

```
MMA> добавь тесты для @src/auth/login.ts

[system] Загружаю файлы:
  ✓ @src/auth/login.ts (142 строки, 4.2K токенов)

[context] 8,600 / 32,768 tokens (26%)
[tool] bash: cat src/auth/login.ts
[output] import { signToken } from './jwt';
         ...
```

**Ключевые моменты:**
- `@` передаётся в промпт LLM как `file_path` — модель видит имя файла
- Содержимое файла добавляется в контекст как tool result (с обрезкой > 2000 строк)
- Модель может работать с файлом без `cat` — содержимое уже в контексте
- Несколько `@` — загружаются все файлы, общий бюджет токенов
- Пути относительные (от cwd) или абсолютные
- Глоб-паттерны (`@src/**/*.ts`) — раскрываются в список файлов

**Примеры:**

```bash
# Один файл
MMA> @src/auth/login.ts -- объясни что делает эта функция

# Несколько файлов
MMA> @src/auth/login.ts @src/auth/jwt.ts -- найди связи между ними

# Диапазон строк
MMA> @src/index.ts:10-30 -- что тут происходит?

# Вся директория
MMA> @src/auth/ -- покажи структуру модуля

# Глоб-паттерн
MMA> @src/**/*.test.ts -- сколько тестов?
```

**Почему это работает для 9B:**
- Модель получает контекст файла в tool result — не нужно делать `cat`
- `@` — familiar syntax из Claude Code / Cursor — модель видела в training data
- Экономия токенов: файл загружается один раз, а не через каждый `cat`

**Few-shot примеры (вместо pre-fill):**
Pre-fill `{"cmd": "` хрупок — маленькие модели могут начать генерировать объяснение перед командой. Вместо этого: 2-3 few-shot примера в tool description. Модель учится формату на примерах, а не на подсказке.

---

## 4. Управление контекстом (для 32K-64K)

```
Бюджет токенов (32K модель):
┌──────────────────────────────────────────────┐
│ System Prompt + Skills + AGENTS.md  ~4K      │ ← начало (приоритет)
│ Project Map (дерево + signatures)   ~2K      │ ← compact overview
│ Working Memory (текущий файл)       ~4K      │
│ Conversation (последние 5-8 turns)  ~14K     │ ← живая история
│ Tool Results (обрезанные)           ~4K      │
│ Summarized History                   ~2K     │ ← конец (приоритет)
│ Reserve                              ~2K     │ ← запас на auto-compact
└──────────────────────────────────────────────┘
```

**Механизмы:**

1. **Auto-compact при 85%** — фоновая суммаризация (паттерн Aider)
   - Старые turn-ы сжимаются в 2-3 предложения
   - Критические ошибки/решения НЕ сжимаются (importance scoring)

2. **Active Memory** — модель сохраняет/читает файлы через bash
   - `MMA state set "key" "value"` — сохранить в state
   - `MMA state get "key"` — прочитать
   - Реализует паттерн AutoMEM: модель сама управляет persistent storage

3. **Обрезка результатов тулов**
   - stdout > 2000 символов = обрезка + "... (полный вывод сохранён в .mma/cache/)"
   - Модель может прочитать полный вывод через `cat .mma/cache/<id>.out`

4. **Приоритизация** (идея VISTA proprioceptive dashboard)
   - Каждый блок контекста имеет мета-информацию: размер в токенах, возраст
   - Модель видит эту информацию и может сама решить, что выгрузить

---

## 5. Контекст больших проектов (ключевая проблема)

> 32K токенов = ~400 строк кода. Проект может иметь 100K+ строк.
> Модель должна понимать структуру проекта, связи между функциями, импорты —
> но не держать весь код в контексте одновременно.

### 5.1 Архитектура: Three-Tier Project Context

```
┌─────────────────────────────────────────────────┐
│ Tier 1: Project Map (~2K tokens, всегда в контексте)│
│  • Дерево файлов (только .ts/.tsx/.js/.json/.md)  │
│  • Каждый файл: имя + список exports (function/   │
│    class/type/export) без тела                    │
│  • Формат: компактный, машиночитаемый             │
│  • Генерируется автоматически при старте сессии    │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│ Tier 2: Code Index (~4K tokens, on-demand)       │
│  • Полный индекс: symbol → file:line:signature   │
│  • Включает: functions, classes, types, exports,  │
│    imports, references (кто вызывает кого)        │
│  • Построен через tree-sitter (или regex fallback)│
│  • Периодически перестраивается (post-edit)       │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│ Tier 3: Raw Code (on-demand, через bash)          │
│  • cat / head / grep — модель читает когда нужно  │
│  • Только релевантные секции (не весь файл)       │
│  • Обрезка при > 500 строк → только нужная часть  │
└─────────────────────────────────────────────────┘
```

### 5.2 Project Map — компактное дерево проекта

Генерируется при старте сессии и вставляется в контекст (Tier 1).

**Language-agnostic подход:**

1. **Авто-детекция языка** по конфиг-файлам проекта:

| Файл проекта | Язык | Глоб паттерн |
|-------------|------|-------------|
| `package.json` | JS/TS | `**/*.{js,jsx,ts,tsx,mjs,cjs}` |
| `pyproject.toml` / `setup.py` / `requirements.txt` | Python | `**/*.py` |
| `go.mod` | Go | `**/*.go` |
| `Cargo.toml` | Rust | `**/*.rs` |
| `pom.xml` / `build.gradle` | Java | `**/*.java` |
| `Gemfile` | Ruby | `**/*.rb` |
| `composer.json` | PHP | `**/*.php` |
| `CMakeLists.txt` / `Makefile` | C/C++ | `**/*.{c,cpp,h,hpp}` |
| Нет конфига | Universal | `**/*.{ts,js,py,go,rs,java,rb,php,c,cpp,h,md,json,yaml,toml}` |

2. **Извлечение exports** — regex per language:

```ts
const EXPORT_PATTERNS: Record<string, RegExp> = {
  // JS/TS
  js: /export\s+(?:default\s+)?(?:function|class|type|interface|enum|const|let|var|async function)\s+(\w+)/g,
  // Python
  py: /^(?:class|def)\s+(\w+)/gm,
  // Go
  go: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm,
  // Rust
  rs: /pub\s+(?:fn|struct|enum|trait|type|const|static)\s+(\w+)/g,
  // Java
  java: /(?:public|protected)\s+(?:class|interface|enum|abstract class)\s+(\w+)/g,
  // Generic fallback
  generic: /(?:export|def|func|pub|public)\s+(?:\w+\s+)?(\w+)/g,
};
```

**Формат вывода** (пример для типичного TS проекта):

```
PROJECT: micro-models-agent
├── src/
│   ├── index.ts          exports: main
│   ├── cli.ts            exports: createCli, parseArgs
│   ├── agent/
│   │   ├── loop.ts       exports: AgentLoop, runLoop
│   │   ├── context.ts    exports: ContextManager, compact
│   │   └── memory.ts     exports: Memory, load, save
│   ├── llm/
│   │   ├── provider.ts   exports: LLMProvider (interface)
│   │   ├── openai-compat.ts  exports: OpenAICompat
│   │   └── token-counter.ts  exports: countTokens
│   ├── tools/
│   │   ├── bash.ts       exports: BashTool, sanitize
│   │   ├── mcp.ts        exports: MCPClient
│   │   └── registry.ts   exports: ToolRegistry
│   └── config/
│       ├── config.ts     exports: loadConfig
│       └── types.ts      exports: Config, AppConfig
├── package.json          name: "mma", scripts: [...]
├── tsconfig.json
└── AGENTS.md
```

**Как генерируется:**
- Определяем язык по конфиг-файлам (см. таблицу выше)
- `glob` по расширениям для этого языка
- Для каждого файла: regex提取 exports (per-language pattern)
- Фильтрация: пропускаем `node_modules`, `.git`, `.mma`, `dist`, `build`, `__pycache__`, `vendor`
- Размер: ~50-100 файлов проекта = ~1.5-2K токенов

### 5.3 Code Index — полный индекс символов

Строится через tree-sitter (или regex fallback) и кэшируется в `.mma/index/`.

**Language-agnostic подход:**

| Язык | Tree-sitter грамматика | Fallback regex |
|------|----------------------|----------------|
| JS/TS | `tree-sitter-javascript` + `tree-sitter-typescript` | `export (function\|class\|type\|interface) (\w+)` |
| Python | `tree-sitter-python` | `^(class\|def) (\w+)` |
| Go | `tree-sitter-go` | `^func\s+(\w+)` |
| Rust | `tree-sitter-rust` | `pub (fn\|struct\|enum\|trait) (\w+)` |
| Java | `tree-sitter-java` | `(class\|interface\|enum) (\w+)` |
| Generic | — | `export\|def\|func\|pub (\w+)` |

**Формат (универсальный):**

```json
{
  "language": "typescript",
  "symbols": {
    "AgentLoop": { "file": "src/agent/loop.ts", "line": 12, "type": "class", "sig": "class AgentLoop { constructor(provider, tools) }" },
    "runLoop": { "file": "src/agent/loop.ts", "line": 45, "type": "function", "sig": "async function runLoop(prompt, options): Promise<Result>" },
    "connectDB": { "file": "src/db/connection.ts", "line": 5, "type": "function", "sig": "async function connectDB(url: string): Promise<Pool>" }
  },
  "references": {
    "AgentLoop": ["src/cli.ts:23", "src/index.ts:15"],
    "connectDB": ["src/api/router.ts:3", "src/db/schema.ts:1"]
  },
  "imports": {
    "src/agent/loop.ts": ["./context", "./memory", "../llm/provider"],
    "src/api/router.ts": ["../db/connection", "../db/schema"]
  }
}
```

**Как строится:**
- Определяем язык → загружаем tree-sitter грамматику (или fallback regex)
- AST-парсинг: извлечение определений (function/class/type/interface/struct/func)
- Извлечение references: grep по `имя_символа` в файлах того же языка
- Извлечение imports: regex per language (`import ... from`, `require`, `from ... import`)
- Кэшируется: `.mma/index/code-index.json`
- Перестраивается при edit (post-hook) или вручную `MMA index rebuild`
- Размер: ~4-8K токенов для проекта в 100 файлов

### 5.4 Как модель использует индекс

**Workflow исследования проекта:**

```
1. Модель видит Project Map в контексте (Tier 1)
   → "Нужно найти где определена функция runLoop"
   → Видит: src/agent/loop.ts exports: runLoop

2. Если нужна подсказка — читает Code Index через bash:
   bash(cmd="cat .mma/index/code-index.json | grep runLoop")
   → Видит: runLoop определена в src/agent/loop.ts:45, signature: async function runLoop(...)

3. Читает нужный файл:
   bash(cmd="cat src/agent/loop.ts")
   → Получает код функции

4. Если нужно найти кто вызывает runLoop:
   bash(cmd="grep -rn 'runLoop' src/")
   → Или: cat .mma/index/code-index.json | grep -A2 '"runLoop"' (references)
```

**Ключевой принцип:** модель не держит 10 файлов в контексте. Она:
1. Смотрит на Project Map (всегда доступен)
2. Query-ит Code Index (grep по .mma/index/)
3. Читает конкретные файлы/строки (cat/sed)
4. Забывает файл после использования (auto-compact убирает)

### 5.5 Инкрементальная перестройка индекса

- **При edit**: `BashTool` после записи файла запускает `MMA index update <file>`
- **Полная перестройка**: `MMA index rebuild` (по команде или при обнаружении рассинхрона)
- **Проверка актуальности**: хэш файла в index vs хэш на диске

### 5.6 Зачем это работает для 9B

| Факт | Импликация |
|------|-----------|
| Project Map ~2K токенов | Всегда в контексте, не давит |
| Code Index ~4-8K токенов | НЕ в контексте, только on-demand grep |
| grep/cat работают через bash | Единый интерфейс, модель не учится новым туулам |
| Индекс = plain text / JSON | grep-аемый, не требует специальных тулов |
| Инкрементальный rebuild | Быстрый (<100ms для одного файла) |

---

## 6. MCP Интеграция

- Используем `@modelcontextprotocol/client` для подключения MCP-серверов
- **Два режима** (зависит от размера модели):

**Режим A: bash-обёртка (для 3-9B моделей):**
```
MMA mcp call filesystem read /path/to/file
```
- MCP-тулы НЕ добавляются в LLM tool list
- Модель вызывает MCP через bash — единый интерфейс
- Меньше тулов = меньше confusion для маленьких моделей

**Режим B: прямой tool list (для 14B+ моделей):**
- MCP-тулы добавляются как обычные tool definitions
- Более эффективно, но требует хорошего instruction following

**STDIO transport** для локальных серверов, **SSE** для удалённых.

---

## 7. Система Skills / AGENTS.md

- **AGENTS.md** — читается из корня проекта, вставляется в system prompt
- **SKILL.md** — загружаются по @mention или флагам (`--skill docker`)
- **Хранилище skills**: `~/.mma/skills/<name>/SKILL.md`
- **Бюджет токенов**: если skills > 2K токенов — суммаризация с приоритетами

---

## 8. Конфигурация провайдеров и моделей

### 8.1 Структура конфига

`.mmrc` в корне проекта или `~/.mma/config.json` (глобальный):

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
            "top_p": 0.9,
            "max_tokens": 4096,
            "frequency_penalty": 0.0,
            "presence_penalty": 0.0,
            "seed": null
          }
        },
        "qwen2.5-14b": {
          "model": "qwen2.5-14b-instruct",
          "contextWindow": 32768,
          "params": {
            "temperature": 0.5,
            "top_p": 0.95,
            "max_tokens": 8192
          }
        },
        "llama3.1-8b": {
          "model": "llama-3.1-8b-instruct",
          "contextWindow": 131072,
          "params": {
            "temperature": 0.6,
            "top_p": 0.9,
            "max_tokens": 4096
          }
        }
      }
    },
    "ollama": {
      "type": "openai-compat",
      "url": "http://localhost:11434/v1",
      "apiKey": null,
      "models": {
        "qwen3.5:9b": {
          "model": "qwen3.5:9b",
          "contextWindow": 32768,
          "params": {
            "temperature": 0.7,
            "top_p": 0.9,
            "num_ctx": 32768
          }
        }
      }
    },
    "together": {
      "type": "openai-compat",
      "url": "https://api.together.xyz/v1",
      "apiKey": "${TOGETHER_API_KEY}",
      "models": {
        "qwen-2.5-coder-32b": {
          "model": "Qwen/Qwen2.5-Coder-32B-Instruct",
          "contextWindow": 32768,
          "params": {
            "temperature": 0.3,
            "max_tokens": 8192
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

### 8.2 Приоритет конфигурации

| Приоритет | Источник | Пример |
|-----------|----------|--------|
| 1 (высший) | Флаги CLI | `MMA --provider lmstudio --model qwen2.5-14b` |
| 2 | Переменные окружения | `export MMA_PROVIDER=lmstudio MMA_MODEL=qwen2.5-14b` |
| 3 | `.mmrc` (корень проекта) | `{ "active": { "provider": "lmstudio" } }` |
| 4 | `~/.mma/config.json` (глобальный) | `{ "active": { "provider": "lmstudio" } }` |
| 5 (дефолт) | Хардкод | LM Studio, qwen3.5-9b |

### 8.3 CLI команды для управления

```
MMA provider list                    — список всех провайдеров
MMA provider use <name>              — переключить провайдер
MMA provider add <name> <url>        — добавить провайдер
MMA provider remove <name>           — удалить провайдер

MMA model list                       — список моделей текущего провайдера
MMA model list --provider ollama     — список моделей конкретного провайдера
MMA model use <name>                 — переключить модель
MMA model params <name>              — показать параметры модели
MMA model params <name> set temp=0.5 top_p=0.95  — изменить параметры

MMA config show                      — показать текущий конфиг
MMA config edit                      — открыть .mmrc в редакторе
MMA config reset                     — сбросить к дефолтам
```

**Примеры использования:**

```bash
# Посмотреть какие провайдеры доступны
$ MMA provider list
  lmstudio  http://localhost:1234/v1     (active)
  ollama    http://localhost:11434/v1
  together  https://api.together.xyz/v1

# Переключиться на Ollama
$ MMA provider use ollama
  ✓ Провайдер: ollama (http://localhost:11434/v1)
  ✓ Модель: qwen3.5:9b

# Посмотреть модели LM Studio
$ MMA model list --provider lmstudio
  qwen3.5-9b       32K context   temp=0.7 top_p=0.9
  qwen2.5-14b      32K context   temp=0.5 top_p=0.95
  llama3.1-8b      128K context  temp=0.6 top_p=0.9

# Переключить модель и параметры
$ MMA model use qwen2.5-14b
  ✓ Модель: qwen2.5-14b-instruct
  ✓ Контекст: 32K
  ✓ Параметры: temp=0.5, top_p=0.95, max_tokens=8192

# Изменить параметры на лету
$ MMA model params qwen2.5-14b set temperature=0.3 max_tokens=4096
  ✓ Параметры обновлены: temp=0.3, max_tokens=4096

# Добавить новый провайдер
$ MMA provider add vllm http://localhost:8000/v1
  ✓ Провайдер vllm добавлен
  Добавьте модели: MMA model add vllm <model-name> <context-window>
```

### 8.4 Авто-детекция провайдера

При старте MMA проверяет доступность провайдеров:

```
Инициализация...
  ✓ LM Studio: http://localhost:1234/v1 (доступен)
  ✓ Ollama: http://localhost:11434/v1 (доступен)
  ✗ Together: https://api.together.xyz/v1 (нет API ключа)
```

Если `.mmrc` нет — используем дефолт: LM Studio + первая найденная модель.

---

## 9. Структура проекта

```
mma/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Точка входа CLI
│   ├── cli.ts                # Настройка commander
│   ├── agent/
│   │   ├── loop.ts           # ReAct цикл
│   │   ├── context.ts        # Менеджер контекста (бюджет, compact, evict)
│   │   └── memory.ts         # Persistent state (паттерн AutoMEM)
│   ├── llm/
│   │   ├── provider.ts       # Интерфейс LLMProvider
│   │   ├── openai-compat.ts  # Реализация OpenAI-совместимости
│   │   └── token-counter.ts  # Подсчёт токенов (js-tiktoken + fallback)
│   ├── tools/
│   │   ├── bash.ts           # Выполнение bash
│   │   ├── sanitizer.ts      # Санитайзер команд (blacklist, regex)
│   │   ├── mcp.ts            # MCP клиент-обёртка
│   │   └── registry.ts       # Реестр инструментов
│   ├── indexer/
│   │   ├── project-map.ts    # Генерация дерева файлов + exports
│   │   ├── code-index.ts     # AST-индекс символов (tree-sitter)
│   │   └── cache.ts          # Кэш индекса (.mma/index/)
│   ├── skills/
│   │   ├── loader.ts         # Загрузка Skills/AGENTS.md
│   │   └── store.ts          # Хранилище skills
│   └── config/
│       ├── config.ts         # Конфигурация
│       └── types.ts          # Определения типов
├── .mma/                      # Директория состояния рантайма
│   ├── state/                # Файлы persistent state
│   ├── cache/                # Кеш выводов тулов
│   └── index/                # Кэш project map + code index
│       ├── project-map.txt
│       └── code-index.json
└── AGENTS.md                 # Инструкции агента для проекта
```

---

## 10. Паттерны безопасности (из исследования Claude Code)

| Паттерн | Реализация |
|---------|-----------|
| Read-only allowlist | `ls, cat, echo, pwd, head, grep, find, git log` — без подтверждения |
| Timeout | По умолчанию 120s, макс 600s, SIGTERM→SIGKILL |
| Лимит вывода | 2000 символов в ответе, полный вывод в `.mma/cache/<id>.out` |
| Детекция опасных команд | Чёрный список в `sanitizer.ts`: `rm -rf /, :(){ :|:& };:`, forks, etc. |
| Санитайзер команд | Regex-based фильтрация + парсинг compound commands (`&&`, `||`, `;`, `|`) |
| Система разрешений | Разрешать/блокировать по паттернам команд |
| Семантические exit codes | `grep` exit 1 = не ошибка, `git diff` exit 1 = есть diff |

**sanitizer.ts — отдельный модуль (не в bash.ts):**
- Чёрный список: `rm -rf /`, `fork炸弹`, `chmod 777`, `dd if=...of=/dev/...`
- Парсинг compound commands: разбиваем `cmd1 && cmd2 || cmd3` и проверяем каждую часть
- Process wrappers: `timeout`, `time`, `nice` — strip перед проверкой (как Claude Code)
- Whitelist для read-only: `ls`, `cat`, `head`, `tail`, `grep`, `find`, `git log`, `git status`

---

## 11. Дизайн цикла агента (ReAct вариант)

```
LOOP:
  1. СОБРАТЬ контекст:
     a. System prompt + Skills + AGENTS.md
     b. Project Map (Tier 1, всегда в контексте)
     c. Working Memory (текущий файл/задача)
     d. Conversation history (последние turns)
  2. ВЫЗВАТЬ LLM с контекстом + tool definition (bash)
  3. ЕСЛИ модель вернула текст → вывести пользователю, ГОТОВО
  4. ЕСЛИ модель вернула tool_call("bash", { cmd }) →
     a. Санитайзер проверяет команду
     b. Выполнить команду с timeout
     c. Обрезать вывод если > 2000 символов
     d. Добавить { role: "tool", content: вывод } в сообщения
     e. Если файл был изменён → обновить project map (инкрементально)
     f. ПЕРЕЙТИ К ШАГУ 1
  5. ЕСЛИ использование токенов > 85% → запустить фоновую компактацию
```

**Для 9B моделей:**
- `tool_choice: "auto"` — модель решает сама
- Few-shot примеры в tool description (2-3 пары cmd/observation)
- Если модель 2 раза подряд вернула ошибку парсинга → переключиться в "chat-only" режим с упрощённым промптом

---

## 12. Фазы реализации

### MVP (Minimum Viable Product)

Цель: **рабочий агент, который можно использовать в реальном проекте.**

| Фаза | Что делаем | Результат | Зависит от | Время |
|------|-----------|-----------|------------|-------|
| **M0** | Каркас проекта (package.json, tsconfig, npm scripts, smoke test) | CLI запускается | — | 30 мин |
| **M1** | CLI (commander) + LM Studio провайдер (дефолт) + bash tool | One-shot: `MMA "запрос"` | M0 | 2-3 ч |
| **M2** | Interactive REPL + slash-команды (`/bash`, `/read`, `/search`, `/find`) | Диалог сессия | M1 | 2-3 ч |
| **M3** | `@file` синтаксис + загрузка файлов в контекст | `@src/index.ts -- объясни` | M1 | 1-2 ч |
| **M4** | Менеджер контекста (бюджет токенов, auto-compact при 85%) | Работает в 32K | M1 | 3-4 ч |
| **M5** | Безопасность (sanitizer, allowlist, timeout, детекция опасных команд) | Безопасный запуск | M1 | 2-3 ч |
| **M6** | Память проекта (project.md, conventions.md, decisions.md) | Агент запоминает контекст | M4 | 3-4 ч |
| **M7** | Конфиг провайдеров (`.mmrc`, LM Studio/Ollama/Together, параметры моделей) | Переключение провайдеров | M1 | 2-3 ч |

**MVP = M0-M7. Итого: ~18-25 часов.**

**Что умеет MVP:**
```
$ MMA
MMA v0.1 — qwen3.5-9b (LM Studio)
Context: 32K | Tokens: 5,200 / 32,768 (16%)
Память: 3 записи загружено

MMA> @src/auth/login.ts -- добавь типизацию
  [загружаю файл...]
  [tool] bash: cat src/auth/login.ts
  [tool] bash: cat > src/auth/login.ts << 'EOF'...
  ✓ Готово.

MMA> /memory add decision "Используем Zod для валидации"
  ✓ Сохранено в .mma/memory/decisions.md

MMA> provider use ollama
  ✓ Провайдер: ollama (localhost:11434)
```

---

### Post-MVP

Цель: **масштабирование, экосистема, продвинутые фичи.**

| Фаза | Что делаем | Результат | Зависит от |
|------|-----------|-----------|------------|
| **P1** | Project indexer (project-map + code-index) | Понимание структуры проекта | M4 |
| **P2** | MCP клиент (bash-обёртка для MCP серверов) | Доступ к MCP экосистеме | M1 |
| **P3** | Skills / AGENTS.md (загрузка, инъекция в system prompt) | Расширяемость | M4 |
| **P4** | Продвинутая память (errors.md, history.md, auto-learning) | Агент обучается на ошибках | M6 |
| **P5** | Инкрементальная индексация (tree-sitter, post-edit rebuild) | Быстрый поиск символов | P1 |
| **P6** | Hooks (PreToolUse, PostToolUse) | Программируемый перехват | M5 |
| **P7** | Piped mode (`cat file | MMA "review"`) | Интеграция в пайплайны | M1 |
| **P8** | Advanced context (ACE, importance scoring, VISTA dashboard) | Оптимальное использование контекста | M4 |
| **P9** | Полировка (ошибки, краевые случаи, документация, тесты) | Релиз | все |
| **P10** | Сессии (сохранение/восстановление диалогов) | Как в Claude Code / Cursor — `/sessions`, `/resume`, auto-save | M2, M4 |

**Post-MVP = P1-P10.**

---

### Граф зависимостей

```
M0 → M1 → M2 ──────────────────────┐
       │     │                      │
       │     ├── M3 (@file)         │
       │     │                      │
       │     ├── M4 (context) ──→ M6 (memory) ──→ P4 (auto-learning)
       │     │      │
       │     │      ├── P1 (indexer) ──→ P5 (tree-sitter)
       │     │      │
       │     │      └── P3 (skills/AGENTS.md)
       │     │
       │     ├── M5 (security) ──→ P6 (hooks)
       │     │
       │     └── M7 (config) ──→ P2 (MCP)
       │
       └── P7 (piped mode)

M4 ──→ P8 (advanced context)
все ──→ P9 (polish)
P10 (sessions) ──→ M2, M4
```

---

### P10. Сессии (сохранение/восстановление диалогов)

Как в Claude Code / Cursor / Aider — полная поддержка сессий.

**Фичи:**

| Команда | Описание |
|---------|----------|
| `/sessions` | Список сохранённых сессий (дата, превью, размер) |
| `/resume <id>` | Восстановить сессию по ID |
| `/save [name]` | Сохранить текущую сессию с именем |
| `/clear` | Очистить контекст (новая сессия без сохранения) |
| `/new` | То же что `/clear` (алиас) |

**Автоматическое сохранение:**
- При каждом `/exit` или SIGINT → авто-сессия `auto-<timestamp>`
- При превышении лимита токенов → авто-сессия перед compact
- При crash → сохранение последнего состояния

**Хранилище:**
```
.mma/
├── sessions/
│   ├── auto-2026-07-16T14-30.json    # Авто-сессия
│   ├── my-feature.json                # Именованная сессия
│   └── index.json                     # Индекс сессий
```

**Формат сессии (JSON):**
```json
{
  "id": "ses_abc123",
  "name": "my-feature",
  "created": "2026-07-16T14:30:00Z",
  "provider": "lmstudio/qwen3.5-9b",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." },
    { "role": "tool", "content": "..." }
  ],
  "context": {
    "totalTokens": 12400,
    "compactCount": 2
  },
  "cwd": "E:\\projects\\micro-models-agent"
}
```

**Восстановление сессии:**
- `/resume auto-2026-07-16T14-30` → загружает messages, provider, cwd
- Контекст восстанавливается из messages
- Память проекта загружается заново
- Провайдер и модель берутся из сессии (или текущие, если не совпадают)

**Лимиты:**
- Максимум 50 сессий (старые авто-сессии удаляются)
- Максимум размера сессии: 10MB
- Хранение: `.mma/sessions/` (gitignore)

---

### Критерии готовности MVP

| Критерий | Как проверяем |
|----------|--------------|
| CLI запускается | `MMA --help` выводит справку |
| One-shot работает | `MMA "создай файл test.ts"` создаёт файл |
| Interactive работает | `MMA` → диалог → `/exit` |
| `@file` работает | `@src/index.ts -- что тут?` загружает файл |
| Slash-команды работают | `/read src/index.ts` выводит файл |
| Контекст не переполняется | 20+ шагов без потери контекста |
| Безопасность | `MMA "rm -rf /"` блокируется |
| Память работает | `/memory add` → `/memory show` → запись видна |
| Провайдеры переключаются | `provider use ollama` → модель отвечает |
| Работает на реальном проекте | 100+ файлов, агент не теряется |

---

## 13. Основные зависимости

```json
{
  "dependencies": {
    "commander": "^12.0.0",
    "@modelcontextprotocol/client": "next",
    "js-tiktoken": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "vitest": "^3.0.0",
    "tsx": "^4.0.0",
    "tree-sitter": "^0.22.0",
    "tree-sitter-typescript": "^0.23.0"
  }
}
```

**Убрано:**
- ~~`zod`~~ — не нужен для валидации схем (bash-first, JSON-light)
- ~~`confbox`~~ — конфиг простой, хватит `JSON.parse` + `process.env`
- ~~`klona`~~ — deep clone не нужен, объекты простые

**Добавлено:**
- `js-tiktoken` — подсчёт токенов (WASM, без нативных зависимостей)
- `tree-sitter` + `tree-sitter-typescript` — devDependencies для индексации

**Почему НЕ Vercel AI SDK:**
- Добавляет слой абстракции над OpenAI API → лишние токены и сложность
- Для 9B моделей минимализм критичен — прямые REST API вызовы
- Меньше зависимостей = меньше кода = меньше шансов на баги

---

## 14. Qwen-специфичные оптимизации

| Особенность Qwen | Наш подход |
|-----------------|------------|
| Tool calling через Hermes template | Форматируем запрос в правильном chat template |
| Thinking mode (Qwen3) | `enable_thinking=False` для tool use |
| Устойчивость к system prompts | Можно давать более длинные system prompt (~4K) |
| Поддержка 128K контекста | Используем только 32K как активное окно |
| Улучшения JSON генерации | Всё равно используем bash (не JSON тулы) |

---

## 15. Память агента (Hermes-like)

### 15.1 Зачем нужна память

MMA работает в проекте и должен **запоминать**:
- Архитектурные решения ("мы используем Zustand вместо Redux")
- Конвенции кода ("все функции — snake_case, компоненты — PascalCase")
- Ошибки и их решения ("не используй `any` — линтер ругается")
- Контекст проекта ("бэкенд на Fastify, фронт на Next.js")
- Историю изменений ("в прошлый раз рефакторили auth модуль")

Без памяти MMA каждый раз начинает с нуля — "как новый стажёр".

### 15.2 Архитектура памяти

```
.mma/
├── memory/
│   ├── project.md          # Контекст проекта (auto-generated)
│   ├── conventions.md      # Конвенции кода (auto + manual)
│   ├── decisions.md        # Архитектурные решения
│   ├── errors.md           # Известные ошибки и решения
│   └── history.md          # История ключевых изменений
├── index/                  # Project map + code index
├── cache/                  # Кеш выводов тулов
└── state/                  # Persistent state
```

### 15.3 Типы памяти

| Тип | Файл | Что хранит | Кто пишет |
|-----|------|-----------|-----------|
| **Project Context** | `project.md` | Стек, структура, зависимости | Auto (при старте) + Manual |
| **Conventions** | `conventions.md` | Паттерны кодирования, стиль | Auto (из анализа кода) + Manual |
| **Decisions** | `decisions.md` | "Почему мы сделали X, а не Y" | Manual (по запросу) |
| **Errors** | `errors.md` | "Эта ошибка → это решение" | Auto (из bash output) + Manual |
| **History** | `history.md` | Ключевые изменения по датам | Auto (после каждого edit) |

### 15.4 Автоматическое обучение

**При старте сессии:**
```
Инициализация...
  ✓ Загрузка памяти проекта (12 записей)
  ✓ Контекст: Fastify backend, Next.js frontend, PostgreSQL
  ✓ Конвенции: snake_case функции, PascalCase компоненты, no any
```

**После каждого edit:**
```
[tool] bash: cat > src/auth/login.ts << 'EOF'...

[memory] Обнаружено изменение: src/auth/login.ts
  → Добавлен экспорт: validatePassword
  → Конвенция: функция экспортируется напрямую (не через index.ts)
```

**После ошибки:**
```
[tool] bash: npm test
[output] FAIL src/auth/login.test.ts
  TypeError: Cannot read property 'hash' of undefined

[memory] Ошибка: TypeError в login.test.ts
  → Причина: bcrypt не импортирован
  → Решение: import bcrypt from 'bcrypt'
  → Сохранено в .mma/memory/errors.md
```

**При обнаружении паттерна:**
```
[analysis] Проанализировал 15 файлов:
  → Все API routes используют async/await
  → Все ошибки обрабатываются через try/catch
  → Все response форматы: { success: boolean, data?: T, error?: string }

[memory] Конвенция: API response format → { success, data, error }
  → Сохранено в .mma/memory/conventions.md
```

### 15.5 Ручное управление памятью

| Команда | Описание |
|---------|----------|
| `/memory` | Показать всю память проекта |
| `/memory show <type>` | Показать конкретный тип |
| `/memory add <type> <text>` | Добавить запись |
| `/memory remove <type> <id>` | Удалить запись |
| `/memory search <query>` | Поиск по памяти |
| `/memory export` | Экспорт памяти в .md |
| `/memory clear` | Очистить память (с подтверждением) |

**Примеры:**
```
MMA> /memory add decision "Используем Zod для валидации схем API"

MMA> /memory show conventions
  Conventions (5 записей):
  1. Функции: snake_case
  2. Компоненты: PascalCase
  3. Константы: UPPER_SNAKE_CASE
  4. Файлы: kebab-case
  5. Импорты:绝对ный путь от src/

MMA> /memory search "auth"
  Найдено 3 записи:
  - [decisions] Auth модуль: JWT + refresh tokens
  - [errors] bcrypt TypeError → импорт缺失
  - [conventions] Auth middleware: always check token before route handler
```

### 15.6 Формат записей памяти

```markdown
<!-- .mma/memory/decisions.md -->
# Архитектурные решения

## [2026-07-16] Выбор ORM
- **Решение**: Prisma
- **Причина**: Type-safe, хорошая миграция, large community
- **Альтернативы**: TypeORM (медленные миграции), Drizzle (молодой)
- **Контекст**: Проект использует PostgreSQL

## [2026-07-16] Структура API
- **Решение**: Flat routes в src/api/
- **Причина**: Проще чем nested, достаточно для 20 endpoints
- **Альтернативы**: Module-based (overkill для нашего масштаба)
```

### 15.7 Интеграция с контекстом

Память загружается в system prompt при старте:

```
System: Ты — MMA, агент для проекта my-project.

## Память проекта
Контекст: Fastify backend, Next.js frontend, PostgreSQL, Prisma ORM
Конвенции: snake_case функции, PascalCase компоненты, no any
Известные ошибки: bcrypt TypeError → проверяй импорт
Последние изменения: 2026-07-16 — добавлен auth модуль

## Инструменты
Use bash tool for all operations...
```

**Бюджет памяти:** максимум 2K токенов на память. Старые записи архивируются.

---

## 16. Глобальная установка + детекция проектов

### 16.1 Установка

```bash
# Глобально (один раз)
npm install -g mma

# Или локально в проекте
npm install --save-dev mma
```

### 16.2 Детекция проекта

При запуске MMA определяет где он находится:

```
$ cd ~/my-project
$ MMA

Определение проекта...
  ✓ Найден package.json → Node.js проект
  ✓ Найден .mmrc → конфиг MMA
  ✓ Найден .mma/ → память проекта существует
  ✓ Контекст: Fastify + Next.js + PostgreSQL
```

**Алгоритм детекции:**

| Приоритет | Маркер | Тип проекта |
|-----------|--------|-------------|
| 1 | `package.json` | Node.js / TypeScript |
| 2 | `pyproject.toml` / `setup.py` | Python |
| 3 | `go.mod` | Go |
| 4 | `Cargo.toml` | Rust |
| 5 | `pom.xml` / `build.gradle` | Java |
| 6 | `Gemfile` | Ruby |
| 7 | `composer.json` | PHP |
| 8 | `CMakeLists.txt` / `Makefile` | C/C++ |
| 9 | `.git` (без других маркеров) | Generic project |
| 10 | Нет маркеров | Unknown — спросить у пользователя |

### 16.3 Изоляция проектов

**Каждый проект — изолированная память:**

```
~/.mma/
├── global/
│   ├── config.json         # Глобальный конфиг
│   └── memory.md           # Глобальная память (跨项目)
└── projects/
    ├── my-project/          # Хэш или slug имени
    │   ├── .mma/
    │   │   ├── memory/
    │   │   ├── index/
    │   │   └── cache/
    │   └── .mmrc            # Локальный конфиг проекта
    ├── another-project/
    │   ├── .mma/
    │   └── .mmrc
    └── ...
```

**Ключевой момент:** `.mma/` директория living в корне проекта, НЕ в `~/.mma/`. Это:
- Версионируется в git (`.mma/memory/` можно коммитить)
- Изолирована между проектами
- Автоматически загружается при `cd` в проект

### 16.4 Команды для работы с проектами

| Команда | Описание |
|---------|----------|
| `MMA init` | Инициализировать MMA в текущем проекте |
| `MMA projects` | Список всех проектов с памятью |
| `MMA project use <name>` | Переключить проект |
| `MMA project info` | Показать информацию о текущем проекте |
| `MMA project clean` | Очистить кэш и индекс проекта |

**Пример:**
```
$ MMA init
  Инициализация MMA в ~/my-project...
  ✓ Создан .mma/ директория
  ✓ Создан .mmrc с дефолтами
  ✓ Определён тип: Node.js (package.json)
  ✓ Провайдер: LM Studio (localhost:1234)
  ✓ Модель: qwen3.5-9b (32K context)

$ MMA projects
  Проекты с памятью:
  ├─ my-project        Fastify + Next.js   12 записей   (сейчас здесь)
  ├─ api-gateway       Express + Redis      8 записей
  └─ cli-tools         Commander + Inquirer 3 записи

$ MMA project info
  Проект: my-project
  Тип: Node.js (TypeScript)
  Стек: Fastify, Next.js, PostgreSQL, Prisma
  Конфиг: .mmrc
  Память: 12 записей (3 decisions, 5 conventions, 4 errors)
  Индекс: 45 файлов, 180 символов
```

### 16.5 Пример типичной сессии с памятью

```bash
$ cd ~/my-project
$ MMA

MMA v0.1 — qwen3.5-9b (LM Studio)
Context: 32K | Tokens: 5,200 / 32,768 (16%)
Память: 12 записей загружено

MMA> добавь endpoint для users

[memory] Загружаю контекст проекта:
  → Fastify backend, Prisma ORM, PostgreSQL
  → Конвенция: API routes в src/api/users.ts
  → Конвенция: ответы { success, data, error }
  → Решение: использовать существующий User model

[tool] bash: cat src/api/users.ts
[output] (если существует) или (не найден)

[tool] bash: cat src/db/schema.prisma
[output] model User { id Int, email String, name String }

[tool] bash: cat > src/api/users.ts << 'EOF'
import { FastifyInstance } from 'fastify';
import { prisma } from '../db';

export async function userRoutes(app: FastifyInstance) {
  app.get('/users', async (req, reply) => {
    const users = await prisma.user.findMany();
    return { success: true, data: users };
  });

  app.get('/users/:id', async (req, reply) => {
    const { id } = req.params;
    const user = await prisma.user.findUnique({ where: { id: Number(id) } });
    if (!user) return { success: false, error: 'User not found' };
    return { success: true, data: user };
  });
}
EOF

[memory] Добавлено: src/api/users.ts
  → Конвенция подтверждена: ответы { success, data, error }
  → Новый endpoint: GET /users, GET /users/:id
```

---

## 17. Антипаттерны — чего избегать (из исследования)

| # | Антипаттерн | Почему плохо | Наше решение | Источник |
|---|------------|-------------|-------------|----------|
| 1 | **JSON tool calling для моделей <32B** | "Structure tax" — модель тратит когнитивные ресурсы на формат JSON вместо решения задачи. До 20% потеря в成功率 | bash как единый тул, plain text команды | F8[1-4] |
| 2 | **Дефолтный контекст Ollama = 2K** | Ollama молча обрезает контекст >2K. Пользователь не замечает что 90% данных потеряно | Принудительно задаём `num_ctx=32768` при запросах | F6-small[4] |
| 3 | **Naive context eviction** | Обычное удаление старых сообщений роняет успех на 34.7pp | ACE-подобный подход: raw+compressed копии, importance scoring | F7[1-3] |
| 4 | **Дамп полных файлов в контекст** | Файл на 500 строк = ~2K токенов. 10 файлов = весь контекст | Обрезка stdout > 2000 символов, ленивая загрузка | F7[7], REPORT |
| 5 | **Загрузка всех tool definitions сразу** | 12 тулов × ~100 токенов = 1200 токенов на описание. MCP может добавить ещё 142K | Один bash-тул (~50 токенов). MCP deferred | F7[7], F5-bash[4] |
| 6 | **Relative paths в тулах** | Модель путает `./src/index.ts` и `src/index.ts`, ошибки в ~15% случаев | Пoka-yoke: absolute paths, working directory в контексте | F8[5] |
| 7 | **Under-specification тулов** | "Use this tool" без WHEN/как — модель не понимает когда применять | Few-shot примеры в tool description, edge cases | F6[10] |
| 8 | **Over-constraint тулов** | Слишком строгие правила → модель боится использовать тул | Баланс:清晰ные границы + escape hatch ("если не уверен — спроси") | F6[10] |
| 9 | **Parsing errors без recovery** | 21.3% потеря при первой ошибке парсинга. Каскадный эффект | Fallback в chat-only режим, retry с упрощённым промптом | F8[3] |
| 10 | **Игнорирование semantic exit codes** | `grep` exit 1 = "нет совпадений" (не ошибка). `git diff` exit 1 = "есть изменения" | Whitelist: grep/git-diff/git-grep exit 1 ≠ ошибка | F1[7] |
| 11 | **Синхронная суммаризация** | Блокирует main loop пока модель сжимает историю | Фоновая компактация (как Aider: background thread) | F2[3-4] |
| 12 | **Нет auto-compact** | Контекст заполняется, модель теряет трек задачи | Auto-compact при 85%, резерв 2K токенов | REPORT[7] |
| 13 | **Путаница провайдеров** | openai ≠ openai-compat: `strict: true`, `tool_choice`, parallel calls не везде работают | Единый OpenAI-compat слой + feature detection | REPORT[6] |
| 14 | **Хардкод языков в indexer** | Если indexer знает только .ts/.js — не работает на Python/Go/Rust | Language-agnostic: glob по detected extensions + regex-based extraction | — |
| 15 | **Отсутствие hooks** | Нет точки перехвата для валидации команд, логирования, аудита | PreToolUse hooks (как Claude Code): валидация до исполнения | F1[11], F4[8] |

---

## 18. CLI UX — как пользователь запускает и использует агента

### 18.1 Три режима запуска

**One-shot** — один запрос → ответ → выход:
```bash
MMA "создай REST API для todos"
MMA --model qwen3.5:9b "объясни этот код"
npm run mma -- "сделай рефакторинг auth модуля"
```

**Interactive REPL** — диалог сессия:
```bash
MMA
MMA --model qwen3.5:9b
```
```
Micro Models Agent (MMA) v0.1 — qwen3.5:9b (Ollama)
Context: 32K tokens | Model: qwen3.5:9b

MMA> добавь тесты для auth модуля
  → bash: find src/auth -name "*.ts"
  → bash: cat src/auth/login.ts
  → bash: npm install -D vitest
  → bash: cat > src/auth/__tests__/login.test.ts << 'EOF'...
  → bash: npm test

Готово. Создал 3 тест-файла в src/auth/__tests__/.

MMA> запусти все тесты
  → bash: npm test
  12 passed, 0 failed.

MMA> /exit
```

**Piped** — stdin → stdout:
```bash
cat src/index.ts | MMA "найди баги в этом коде"
echo "Express server with JWT auth" | MMA "сгенерируй скелет проекта"
cat error.log | MMA "проанализируй ошибку и предложи фикс"
```

### 18.2 Флаги CLI

```
MMA [опции] [запрос]

Опции:
  --model <name>       Модель (default: qwen3.5:9b)
  --provider <url>     URL провайдера (default: http://localhost:11434/v1)
  --context <tokens>   Размер контекста (default: 32768)
  --skill <name>       Загрузить skill (--skill docker)
  --verbose            Показывать bash команды и вывод
  --compact            Авто-compact (default: on)
  --no-compact         Отключить auto-compact
  --max-steps <n>      Максимум шагов ReAct цикла (default: 50)
  --help               Помощь
  --version            Версия
```

### 18.3 Конфигурация (4 уровня приоритета)

| Приоритет | Источник | Пример |
|-----------|----------|--------|
| 1 (высший) | Флаги CLI | `MMA --model qwen3.5:9b` |
| 2 | Переменные окружения | `export MM_MODEL=qwen3.5:9b` |
| 3 | Файл `.mmrc` (корень проекта) | `{ "model": "qwen3.5:9b" }` |
| 4 (низший) | Глобальный `~/.mma/config.json` | `{ "provider": "http://..." }` |

**`.mmrc` пример:**
```json
{
  "model": "qwen3.5:9b",
  "provider": "http://localhost:11434/v1",
  "context": 32768,
  "skills": ["docker", "git"],
  "maxSteps": 50,
  "verbose": false
}
```

**`AGENTS.md`** в корне проекта — system prompt augmentation (не конфиг, а инструкции для агента).

### 18.4 Вывод в one-shot режиме

```
$ MMA --verbose "создай express сервер"

⠋ Планирую...
  → bash: mkdir -p src && npm init -y
  → bash: npm install express
  → bash: cat > src/index.ts << 'EOF'...
✓ Готово. Создан src/index.ts с Express сервером на порту 3000.
```

Без `--verbose` — только финальный ответ. С `--verbose` — все bash команды и вывод.

### 18.5 Вывод в interactive режиме

```
MMA> проанализируй структуру проекта

[context] 4,200 / 32,768 tokens (13%)
[tool] bash: find src -name "*.ts" | head -20
[output] src/index.ts
         src/cli.ts
         src/agent/loop.ts
         ...
[response] Проект содержит 15 TypeScript файлов в 4 папках.
           Основные модули: CLI, Agent Loop, LLM Provider, Tools.
```

С `--verbose`: context usage, tool commands, raw output.
Без `--verbose`: только финальный response агента.

### 18.6 Специальные команды и инструменты (interactive режим)

**Системные команды:**

| Команда | Описание |
|---------|----------|
| `/exit`, `/quit` | Выход из сессии |
| `/help` | Список команд и флагов |
| `/clear` | Очистить контекст (сброс истории) |
| `/compact` | Ручная компактация контекста |
| `/map` | Показать project map |
| `/index` | Перестроить code index |
| `/model <name>` | Сменить модель на лету |
| `/provider <name>` | Сменить провайдер на лету |
| `/verbose` | Переключить verbose режим |
| `/state` | Показать persistent state |
| `/config` | Показать/изменить конфиг |

**Инструменты (slash-команды для прямого доступа):**

| Команда | Описание | Пример |
|---------|----------|--------|
| `/bash <cmd>` | Выполнить shell команду | `/bash ls -la` |
| `/read <file>` | Прочитать файл | `/read src/index.ts` |
| `/read <file> <offset> <limit>` | Прочитать секцию файла | `/read src/index.ts 50 100` |
| `/write <file>` | Записать файл (с подтверждением) | `/write src/new.ts` |
| `/edit <file>` | Редактировать файл (interactive diff) | `/edit src/index.ts` |
| `/search <pattern>` | Поиск по содержимому файлов | `/search "function login"` |
| `/search <pattern> <glob>` | Поиск с фильтром | `/search "import" "*.ts"` |
| `/find <pattern>` | Поиск файлов по имени | `/find "*.test.ts"` |
| `/git <args>` | Git операции | `/git status`, `/git diff` |
| `/npm <args>` | npm операции | `/npm test`, `/npm install vitest` |

**Как работают инструменты:**

Инструменты выполняются НАПРЯМУЮ (без LLM), как в Claude Code:

```
MMA> /read src/auth/login.ts
  1: import { signToken } from './jwt';
  2: import { validateUser } from './db';
  3: 
  4: export async function login(email: string, password: string) {
  5:   const user = await validateUser(email, password);
  6:   if (!user) return { success: false, error: 'Invalid credentials' };
  7:   const token = signToken(user);
  8:   return { success: true, token, user };
  9: }

MMA> /search "signToken" "*.ts"
  src/auth/login.ts:1   import { signToken } from './jwt';
  src/auth/jwt.ts:12    export function signToken(user: User): string {
  src/auth/__tests__/jwt.test.ts:5  const token = signToken({...});

MMA> /bash npm test
  ✓ src/auth/__tests__/login.test.ts (2 tests)
  ✓ src/auth/__tests__/jwt.test.ts (2 tests)
  4 passed, 0 failed

MMA> добавь тесты для router
  (здесь уже LLM анализирует контекст и делает через bash)
```

**Ключевой момент:** slash-команды — это ПРЯМОЙ доступ к файловой системе и инструментам БЕЗ LLM. Они работают мгновенно, не тратят токены, не требуют подключения к модели.

**Два режима работы:**

| Режим | Кто выполняет | Токены | Скорость |
|-------|--------------|--------|----------|
| `/read`, `/bash`, `/search` | Система (напрямую) | 0 | Мгновенно |
| `"добавь тесты"` | LLM (через bash tool) | ~2K-10K | 5-30 сек |

### 18.7 Обработка ошибок

**Нет Ollama:**
```
$ MMA "создай сервер"

✗ Не удалось подключиться к http://localhost:11434/v1
  Убедитесь что Ollama запущен: ollama serve

  Альтернативы:
    MMA --provider http://your-vllm:8000/v1 "создай сервер"
    MM_PROVIDER=http://together.ai/v1 MMA "создай сервер"
```

**Модель не найдена:**
```
✗ Модель 'qwen3.5:9b' не найдена в Ollama

  Доступные модели:
    qwen2.5:7b, qwen2.5:14b, llama3.1:8b, mistral:7b

  Скачать: ollama pull qwen3.5:9b
```

**Превышен лимит шагов:**
```
⚠ Достигнут лимит в 50 шагов. Агент не завершил задачу.

  Текущий прогресс: установлен Express, создан router, но тесты не запущены.
  Продолжить? (y/n)
```

**Безопасность — заблокированная команда:**
```
[blocked] rm -rf /
  Команда заблокирована sanitizer: опасная операция.
  Используйте более безопасную альтернативу.
```

### 18.8 Пример типичной сессии (verbose)

```bash
$ MMA --verbose

Micro Models Agent (MMA) v0.1 — qwen3.5:9b (Ollama)
Context: 32K | Tokens: 4,200 / 32,768 (13%)

MMA> проанализируй проект и предложи рефакторинг

[context] 4,200 / 32,768 tokens (13%)
[tool] bash: find . -name "*.ts" -not -path "*/node_modules/*"
[output] 15 files found
[tool] bash: cat .mma/index/project-map.txt
[output] PROJECT: micro-models-agent
         ├── src/
         │   ├── index.ts    exports: main
         │   ├── cli.ts      exports: createCli
         │   ...

Анализирую структуру... Вижу 3 потенциальные проблемы:

1. **Circular dependency**: `loop.ts` ↔ `context.ts`
2. **Large file**: `loop.ts` (340 строк) — стоит разбить
3. **Missing abstraction**: `bash.ts` и `sanitizer.ts` связаны, но в разных папках

Начать с выноса `executor.ts` из `loop.ts`?

MMA> да

[context] 8,100 / 32,768 tokens (25%)
[tool] bash: cat src/agent/loop.ts
[output] (обрезано до 50 строк из 340)
[tool] bash: head -80 src/agent/loop.ts
[output] import { ContextManager } from './context';
         import { BashTool } from '../tools/bash';
         ...
[tool] bash: cat > src/agent/executor.ts << 'EOF'
         import { BashTool } from '../tools/bash';
         import { sanitize } from '../tools/sanitizer';

         export async function executeTool(
           tool: BashTool, cmd: string
         ): Promise<string> {
           const sanitized = sanitize(cmd);
           return tool.execute(sanitized);
         }
         EOF
[context] 12,400 / 32,768 tokens (38%)

✓ Создан `src/agent/executor.ts`.
  Теперь нужно обновить импорты в `loop.ts`. Продолжить?

MMA> /state

Persistent state:
  files_created: 3 (executor.ts, login.test.ts, ...)
  files_modified: 1 (loop.ts)
  decisions: "Рефакторинг loop.ts → executor.ts + loop.ts"

MMA> /exit
До свидания. Сессия: 8 шагов, 12,400 токенов.
```

---

## Что дальше?

После утверждения плана — запуск **MVP (M0-M7)**.

**M0 — Каркас (30 мин):**
1. `npm init`, установка зависимостей
2. `tsconfig.json` (ESM, strict)
3. `npm run mma` скрипт → `tsx src/index.ts`
4. Smoke test: CLI запускается, выводит help

**M1 — CLI + провайдер + bash (2-3 ч):**
1. CLI точка входа (commander)
2. LM Studio провайдер (дефолт, fetch к localhost:1234)
3. Bash инструмент для LLM (execute + timeout + обрезка)
4. ReAct цикл (one-shot)
5. Тест: `MMA "создай файл test.ts"`

**M2 — Interactive REPL + slash-команды (2-3 ч):**
1. REPL цикл (ввод → LLM → вывод)
2. Slash-команды: `/bash`, `/read`, `/search`, `/find`, `/exit`
3. Прямой доступ к файлам без LLM

**M3 — @file синтаксис (1-2 ч):**
1. Парсер `@path` в вводе пользователя
2. Загрузка файлов в контекст
3. Поддержка диапазонов: `@file:10-50`

**M4 — Контекст-менеджер (3-4 ч):**
1. Подсчёт токенов (js-tiktoken)
2. Бюджет: system prompt 4K, conversation 16K, tools 4K
3. Auto-compact при 85%

**M5 — Безопасность (2-3 ч):**
1. Санитайзер команд (blacklist regex)
2. Allowlist для read-only команд
3. Timeout + обрезка вывода

**M6 — Память проекта (3-4 ч):**
1. `.mma/memory/` — project.md, conventions.md, decisions.md
2. `/memory` команды
3. Загрузка в system prompt

**M7 — Конфиг провайдеров (2-3 ч):**
1. `.mmrc` — провайдеры, модели, параметры
2. `provider use`, `model use`, `model params`
3. Авто-детекция LM Studio/Ollama

**Итого MVP: ~18-25 часов.**
