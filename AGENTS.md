# MMA v2 — Micro Models Agent

AI coding agent harness for small models (Qwen3.5-9B, 32K-64K context). Complete rewrite from MMA v1.

> **Design spec:** [docs/specs/2025-07-28-mma-v2-design.md](./docs/specs/2025-07-28-mma-v2-design.md) — architecture, modules, tools, CLI, config, data flow.

> **Этот файл должен периодически обновляться при изменениях в проекте.** При добавлении новых модулей, тулов, команд, изменении архитектуры или конфигурации — обнови соответствующий раздел ниже. AGENTS.md должен всегда отражать актуальное состояние проекта, чтобы агенты и разработчики имели достоверный контекст.

## Tech Stack

- **Runtime:** Bun + TypeScript (ES2022, NodeNext module)
- **Testing:** vitest (`bun test`)
- **Linting:** TypeScript strict mode (`tsc --noEmit`)
- **Dependencies:** commander, js-tiktoken, picocolors, execa, jsonrepair, playwright

## Commands

```bash
# Run agent
bun run mma "<prompt>"

# Run agent, machine-readable JSON result (single-run mode)
bun run mma "<prompt>" --json

# Dev mode (watch)
bun run dev

# Build (tsc + copy skills)
bun run build

# Test (component tests)
bun test

# Typecheck
tsc --noEmit

# Test a single file
bun test tests/<name>.test.ts

# Session management
bun run mma session list
bun run mma session show <id>
bun run mma session delete <id>
```

## Тестирование агента из консоли (agent-driven)

Агент (opencode) может тестировать MMA напрямую через терминал, без интерактивного REPL:

```bash
# Одноразовый прогон: без AGENTS.md, выход сразу после ответа, песочница
bun run mma "<промпт>" --no-agents-md --exit-on-complete -d <путь-к-песочнице>
```

- **Песочница:** всегда тестируй внутри `_testing/` в корне проекта (например `_testing/<case-name>/`), никогда в корне или в `src/`. Папка `_testing/` добавлена в `.gitignore`.
- **`--no-agents-md`** — не грузить AGENTS.md в системный промпт (иначе агент получит инструкции проекта и поведёт себя иначе, чем в чистой среде).
- **`--exit-on-complete`** — завершиться сразу после первого финального ответа; интерактивные тулзы (`question`/`approve`) не блокируют stdin, а возвращают ошибку.
- **`-d <dir>`** — рабочая директория агента (туда он создаёт файлы).
- Каждый прогон создаёт сессию в `~/.mma/sessions/<id>/` (`meta.json` + `history.jsonl` + `session.jsonl`). После прогона можно смотреть:
  ```bash
  bun run mma session list
  bun run mma session show <id>
  ```

**Правила тестового прогона:**
1. Новый тест-кейс = новая подпапка `_testing/<case-name>/`.
2. Промпт формулируй конкретно: что создать, с каким содержимым, куда.
3. Оценивай результат по фактам (файлы на месте, содержимое корректно, exit code), а не по словам агента.
4. Если тестируешь фикс/фичу — сначала `bun test` + `tsc --noEmit`, потом прогон MMA.

## Architecture

6-layer state machine agent:

```
CLI (main.ts → commands.ts / repl.ts)
  → Core (agent.ts state machine: INIT→THINK→ACT→OBSERVE→OUTPUT→ERROR)
    → LLM Layer (provider.ts → openai-compat.ts → token-counter.ts → response.ts)
    │   └── Exponential backoff retry (3 retries, 1s/2s/4s delays, 429/5xx)
    → Tools (registry.ts → executor.ts → 20+ individual tools)
    → Modules (skills, plugins, mcp, pipelines, indexer, memory, context, session, hallucination, execution, updater, user-profile, browser, security)
```

### Security Module

> **Spec:** `docs/specs/2025-07-28-mma-v2-design.md#14-security-module` — Comprehensive security system for MMA v2.
> **Status:** **Phase 1 implemented** (Bash command validation, path restrictions, network filtering, content scanning, subagent recursion control).

The security module provides multiple layers of protection:

#### Implemented Features (Phase 1)

- **Bash Command Validation** (`src/modules/security/command-validator.ts`):
  - Blacklist of dangerous commands (`rm`, `dd`, `chmod`, `wget`, `curl`, `ssh`, etc.)
  - Whitelist mode (optional, strict)
  - Blocking of dangerous flags (`--force`, `-rf`, `--no-preserve-root`)
  - Blocking of dangerous operators (`|`, `>`, `>>`, `;`, `&&`)
  - Command logging to `~/.mma/logs/audit.jsonl`

- **Path Validation** (`src/modules/security/path-validator.ts`):
  - Global denied paths (`.git/`, `node_modules/`, `.env`, `*.key`, etc.)
  - Global allowed paths (optional whitelist mode)
  - Integration with existing `ToolScope` for subagents
  - Applied to all filesystem tools (`read_file`, `write_file`, `delete_file`, `edit_file`, `create_dir`, `move_file`, `list_dir`, `file_info`)

- **Network Validation** (`src/modules/security/network-validator.ts`):
  - Denied domains blacklist
  - Allowed domains whitelist (optional)
  - URL sanitization (removing sensitive query parameters)
  - Applied to `web_fetch`, `web_search`, `web_browse`

- **Content Scanning** (`src/modules/security/content-scanner.ts`):
  - Detection of dangerous patterns in file content (`eval(`, `child_process.exec(`, `rm -rf`, etc.)
  - Applied to `write_file` and `edit_file`

- **Subagent Recursion Control** (`src/tools/subagent.ts`):
  - Maximum recursion depth limit (default: 3)
  - Prevents infinite subagent spawning

- **Audit Logging** (`src/modules/security/audit-log.ts`):
  - Logging of all security-relevant events to `~/.mma/logs/audit.jsonl`
  - Events: tool calls, file operations, bash commands, network requests, security blocks

- **Data Sanitization** (`src/modules/security/data-sanitizer.ts`):
  - Automatic removal of sensitive data (API keys, tokens, passwords) from logs
  - Applied to all log messages and audit entries

#### Configuration

Security settings are part of `AppConfig` in `src/config/types.ts`:

```typescript
interface SecurityConfig {
  bash: BashSecurityConfig;
  paths: PathSecurityConfig;
  network: NetworkSecurityConfig;
  maxRecursionDepth: number;
  maxFileOperations: number;
  rateLimits: RateLimitConfig;
  contentScan: ContentScanConfig;
  sessionEncryption: SessionEncryptionConfig;
  auditNotifier: AuditNotifierConfig;
}
```

Default configuration is defined in `src/config/security.ts` and merged with user settings in `src/config/defaults.ts`.

#### Backward Compatibility

All security features are **opt-in** by default:
- If `security` config is not provided, all operations are allowed (backward compatible)
- Existing code continues to work without modifications
- Security checks can be disabled individually

#### Phase 4: Extended Security Features

> **Status:** Fully implemented and tested (177 tests passing)

##### Session File Encryption (`src/modules/security/session-encryption.ts`)
- Encrypts `history.jsonl` and `session.jsonl` files using AES-256-GCM
- Configurable via `security.sessionEncryption.enabled`
- Custom key path support (`security.sessionEncryption.keyPath`)
- Backward compatible: can read old unencrypted files
- Integrated with `SessionStore` for transparent encryption/decryption

##### Audit Notifications (`src/modules/security/audit-notifier.ts`)
- File-based notifications to `~/.mma/logs/audit-notifications.jsonl`
- Webhook support for real-time notifications
- Configurable severity levels (`low`, `medium`, `high`, `critical`)
- Event type filtering (`security_block`, `bash_command`, `file_operation`, `network_request`, etc.)
- Automatic retry for failed webhook deliveries
- Statistics and analytics via `getStats()`

##### Security Policies (`src/modules/security/security-policies.ts`)
- Three preset policies:
  - **Strict**: Maximum security, minimal flexibility (recommended for production)
  - **Balanced**: Good security with reasonable flexibility (default)
  - **Permissive**: Minimal security, maximum flexibility (recommended for testing)
- Easy switching via `applySecurityPolicy('strict')`
- Custom policy support with overrides
- Use case recommendations

##### CLI Security Commands
```bash
mma security status              # Show current security configuration
mma security policies           # List available security policies
mma security set-policy strict   # Apply strict security policy
mma security enable-encryption  # Enable session file encryption
mma security disable-encryption # Disable session file encryption
mma security enable-audit        # Enable audit notifications
mma security disable-audit       # Disable audit notifications
mma security audit-stats         # Show audit notification statistics
```

### Agent-Level MoE

> **Spec:** `docs/specs/2025-07-30-agent-level-moe.md` — Router + Expert-Agent + Expert-Tools, hierarchical recursive decomposition.
> **Plan:** `docs/specs/2025-07-30-agent-level-moe-plan.md`
>
> Status: **partially implemented (MVP)**. When `moe.enabled: true` is set in config and an orchestrator model is configured, the agent uses a Router → plan → validate → execute (parallel waves) → verify/merge flow. Falls back to single-agent when MoE fails or is disabled.
>
> ### Implemented phases
>
> - **Phase 0** — Tool tags (`tags?: string[]` on `ToolDefinition`), `filterToolsByTags()`, `ToolRegistry.getByTags()`, tag-based tool filtering in LLM calls.
> - **Phase 1** — Expert registry in config (`experts: Record<string, ExpertConfig>` with `model`, `tool_tags`, `max_attempts`), `getExpertConfig()`, `validateExpertConfig()`.
> - **Phase 2** — Subagent file scope (`ToolScope` with `allowed_files` + `read_only_files`), `isPathInScope()` / `isPathWritable()` guards in all filesystem tools, scope propagation from subagent to tool context.
> - **Phase 3** — Plan validation (`plan-validator.ts`): cycle detection, write-write overlap, read-after-write dependency checks, auto-fix for missing `depends_on`.
> - **Phase 4** — Orchestrator Router modes: `plan()` generates an `MoEPlan` from user prompt, `verifyAndMerge()` evaluates results and returns final or re-plan. JSON repair via `jsonrepair`. Max 3 re-plan cycles.
> - **Phase 5** — MoE execution engine (`moe-executor.ts`): topological sort by `depends_on`, parallel wave execution, per-subtask subagent spawning with filtered tools + scope.
> - **Phase 6** — Prompt builder integration: `toolTags` in `AgentDeps` filters LLM-visible tool set, `SubtaskContext` type in core types.
> - **Phase 7** — Retry logic: transient error detection (timeout, 5xx, network), exponential backoff retry up to `max_attempts`, structural failures feed into re-plan.
> - **Phase 8** — Global verification: `StepVerifier.verifyMoEManifest()` runs file existence checks + `tsc --noEmit` + `bun test` on artifacts.
> - **Phase 9** — Main agent loop integration in `agent.ts`: decision point at start of `run()` — if `config.moe.enabled`, delegate to `runWithMoE()`, with graceful fallback to `executeSingleAgentLoop()`.
> - **Phase 10** — This AGENTS.md update.
>
> ### Known limitations (post-MVP)
>
> - Scope expansion via `scope_request` not yet implemented.
> - Per-expert quantization (depends on provider support).
> - Dynamic expert tag discovery by LLM.
> - Cost/budget tracking per subtask.
> - Subagent tool set uses tag filtering from expert config, but the orchestrator model selection is still the base model when no separate orchestrator provider is configured.

## LLM Provider Contract (llama.cpp / OpenAI-compat)

При работе с llama.cpp (и другими бэкендами, использующими Jinja-шаблоны для сообщений) необходимо соблюдать следующие правила. Их нарушение приводит к ошибке `400: Jinja Exception` и полной неработоспособности агента на multi-turn задачах.

### Правило 1: `system` сообщение — всегда и только первое

Большинство Jinja-шаблонов (llama.cpp, vLLM) требуют, чтобы `role: "system"` сообщение было **первым** в массиве `messages`. Если system-сообщение появляется после `user`, `assistant` или `tool` — API возвращает 400.

**Было (сломано):**
```typescript
contextManager.addMessage({ role: "system", content: summary });
// → system ПОСЛЕ tool/assistant → Jinja Exception
```

**Стало (работает):**
```typescript
contextManager.addMessage({ role: "user", content: `<system-summary>${summary}</system-summary>` });
// → user, не system — не нарушает Jinja
```

**Где применяется:** `src/core/agent.ts` — после каждого tool call добавляется сводка результатов. Используй `role: "user"` с обёрткой `<system-summary>`. Никогда не добавляй `role: "system"` динамически.

### Правило 2: Streaming fallback — всегда non-streaming

Некоторые модели (Qwen 3.5-9B через llama.cpp) **не стримят JSON tool_calls** через `delta.tool_calls`. Streaming возвращает только `reasoning_content`, а финальный ответ содержит tool_calls только в non-streaming режиме.

**Логика в `openai-compat.ts`:**
1. Пробуем streaming (`doStream` — SSE через `delta.*`)
2. Если streaming не вернул ни `text`, ни `tool_call` — вызываем fallback `doNonStreaming`
3. Fallback всегда отправляет `stream: false` явно

Условие для fallback: `!hasToolCall && !hasText` — без проверки на `reasoningAcc`, потому что streaming может вернуть пустой ответ (без reasoning) на второй итерации.

### Правило 3: Non-streaming + tools = явный `stream: false`

В `doNonStreaming` тело запроса должно содержать `stream: false`. Без этого поля некоторые бэкенды (llama.cpp, особенно с кастомными шаблонами) могут парсить запрос иначе и вернуть 400.

**Было (сломано):**
```typescript
const body = { model, messages, max_tokens };
```

**Стало (работает):**
```typescript
const body = { model, messages, stream: false, max_tokens };
```

### Правило 4: tool_calls в истории — корректный формат

При добавлении `assistant` сообщения с `tool_calls` в контекст, формат должен строго соответствовать OpenAI API:

```typescript
{
  role: "assistant",
  content: textContent || "",
  tool_calls: [{
    id: tc.id,
    type: "function",
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
    },
  }],
}
```

Поле `type: "function"` обязательно внутри каждого tool_call. Поле `arguments` — строка JSON. Без `type` некоторые бэкенды не распознают tool_call.

### История проблемы

Агент создавал папку (первый tool_call), но на второй итерации модель возвращала пустой ответ. Агент уходил в hallucination retry и зацикливался. Диагностика:

1. `doStream` возвращал пустой стрим (ни text, ни tool_call) на второй итерации
2. Fallback `doNonStreaming` не вызывался из-за условия `&& reasoningAcc` (reasoning был пуст)
3. Даже когда fallback вызвали (после фикса условия), он падал с 400 из-за нарушения Jinja-шаблона (system не первый, отсутствует `stream: false`)
4. Non-streaming без tools работал, но с tools — падал с `400: System message must be at the beginning` или `No user query found in messages`

**Все фиксы сделаны в:** `src/core/agent.ts`, `src/llm/openai-compat.ts`, `src/modules/context/manager.ts`, `src/modules/hallucination/confidence.ts`.

---

## Key Design Rules

1. **No file >300 lines** — split when approaching limit
2. **Small files, single responsibility** — each file does one thing
3. **KISS state machine** — no god objects, no if-else nesting in agent loop
4. **Single source of truth** — `config/defaults.ts` for config, `tools/registry.ts` for tools
5. **Plugin error isolation** — one plugin crash never stops others
6. **Path safety** — all filesystem tools check `targetPath.startsWith(baseDir)`
7. **TDD** — write test first, then implement, then commit
8. **No hardcoded user-facing strings** — ALL text shown to users MUST go through `t()` from `i18n/index.ts`. Both `en.json` and `ru.json` must have matching keys. No exceptions — CLI labels, error messages, tool outputs, REPL prompts, setup wizard text, everything.
9. **No full-screen TUI** — no alternate screen buffer, no raw-mode, no full-frame redraw. Rich ANSI output is allowed: spinner (single-line `\r` overwrite on stderr), boxed tool cards, aligned tables. Auto-degrades to plain text when `!isTTY` or `CI`.
10. **No keyword matching for task classification** — determining whether a task is multi-step, needs planning, or requires specific tools via keyword/word matching is an anti-pattern. It fails for non-English languages, ambiguous inputs, and novel task patterns. Instead, use the system prompt to instruct the model to use the `plan` tool when appropriate. The model decides whether to create a plan based on task complexity, not hardcoded heuristics.
11. **Interactive tools bypass the execution timeout** — tools that block on user input (`question`, `approve`) must set `interactive: true` on their `ToolDefinition`. The executor skips the 60s timeout for them. Any new user-facing interactive tool must do the same, and must reuse `user-input.ts` instead of creating its own readline interface.

## Project Structure

```
src/
├── core/               # Agent loop + prompt builder + types
│   ├── agent.ts        # State machine (INIT→THINK→ACT→OBSERVE→OUTPUT→ERROR)
│   ├── prompt-builder.ts # Collect PromptBlock[], sort by priority, fit 8K budget
│   └── types.ts        # AgentState, PromptBlock, ToolCall, ToolResult, LLMResponse
├── llm/                # LLM communication layer
│   ├── provider.ts     # LLMProvider interface (chat, countTokens)
│   ├── openai-compat.ts # OpenAI-compatible REST + SSE streaming
│   ├── token-counter.ts # js-tiktoken wrapper
│   ├── response.ts     # Parse stream chunks → typed LLMResponse
│   └── orchestrator.ts # Optional orchestrator model (planning, conflict resolution)
├── tools/              # Tool system
│   ├── registry.ts     # Single source of truth for tool definitions
│   ├── executor.ts     # Dispatch pipeline: plugins → validate → handler → plugins → log
│   ├── types.ts        # ToolDefinition, ToolContext, ToolResult
│   ├── read-file.ts    # Path-safe file reading with offset/limit, chunking at 300 lines, full path in output header
│   ├── write-file.ts   # Create/overwrite with intermediate dir creation
│   ├── edit-file.ts    # Find-replace in existing files
│   ├── glob-tool.ts    # Glob pattern matching
│   ├── grep-tool.ts    # Regex content search (via ripgrep)
│   ├── bash.ts         # Shell command execution (async spawn, background mode for long-running commands)
│   ├── process-list.ts, process-log.ts, process-kill.ts  # Background process management
│   ├── subagent.ts     # Isolated sub-agent spawning
│   ├── web-search.ts, web-fetch.ts, web-browse.ts
│   ├── browser.ts      # Playwright browser tool (open, click, type, scroll, screenshot)
│   ├── attach-image.ts # Attach image from file/URL/clipboard → multimodal message
│   ├── user-input.ts   # Interactive user input primitive (menu, selection parsing, askUser)
│   ├── plan.ts, todo.ts, question.ts, approve.ts
│   ├── load-skill.ts, pipeline-run.ts, mcp-call.ts, search-history.ts
│   └── ...             # list-dir, create-dir, delete-file, move-file, file-info
├── modules/            # All modules implement AgentModule interface
│   ├── registry.ts     # ModuleRegistry: collect blocks/tools/plugins from modules
│   ├── types.ts        # AgentModule, AgentPlugin interfaces
│   ├── skills/         # Skills loader (builtin/global/project) + keyword matcher (anti-pattern — needs LLM-based matching)
│   ├── plugins/        # PluginManager with lifecycle hooks + error isolation
│   ├── mcp/            # MCP client (stdio/SSE) + server registry
│   ├── pipelines/      # DAG-based workflow engine (YAML → execute)
│   ├── indexer/        # Automatic project map: file walker + export extraction + disk cache
│   │   ├── walker.ts   # Recursive walker, language detection, export extraction
│   │   ├── cache.ts    # JSON cache of index results
│   │   └── module.ts   # AgentModule — PromptBlock + project_map tool + watch plugin
│   ├── memory/         # Persistent markdown (conventions.md, decisions.md, errors.md)
│   ├── context/        # ContextManager (budget calc, sliding window compaction)
│   ├── session/        # Multi-session management
│   │   ├── types.ts    # SessionMeta, SessionMessage
│   │   ├── store.ts    # JSONL persistence on disk (~/.mma/sessions/<id>/)
│   │   ├── manager.ts  # Session lifecycle (create, list, switch, delete)
│   │   └── module.ts   # AgentModule — PromptBlock + Plugin hooks
│   ├── hallucination/  # Pre-output validation pipeline
│   │   ├── factual.ts  # Cross-check paths vs known set
│   │   ├── consistency.ts # Track decisions, detect contradictions
│   │   └── confidence.ts # Short/repetitive/uncertain markers
│   ├── execution/      # Task execution guarantees
│   │   ├── planner.ts  # Plan creation utilities (no heuristics — model decides via prompt)
│   │   ├── tracker.ts  # Step status, progress display
│   │   ├── verifier.ts # File existence + syntax + test checks
│   │   ├── stuck-detector.ts # Iteration/error thresholds, off-track guard
│   │   └── auditor.ts  # Final audit after all steps
│   ├── processes/      # Background & foreground process management
│   │   ├── runner.ts   # Async spawn (non-blocking), kill-by-call-id on timeout, tree-kill
│   │   ├── registry.ts # Background process registry: pid tracking, output buffer, kill/killAll
│   │   └── detect.ts   # Long-running command heuristic (dev servers, watchers)
│   ├── updater/        # Background npm registry version check
│   ├── user-profile/   # OS/shell/preferences → ~500 token compressed block
│   └── browser/        # Playwright browser module (session, snapshot, actions, cookies)
│       ├── types.ts    # BrowserConfig, BrowserState, ElementEntry, ActionResult
│       ├── session.ts  # BrowserSession — Playwright lifecycle + action dispatch
│       ├── snapshot.ts # Page → numbered accessibility tree (interactive elements)
│       ├── actions.ts  # Script builders for click, type, scroll
│       ├── cookie-store.ts # Cookie/session persistence to disk
│       └── module.ts   # AgentModule — PromptBlock + Plugin hooks
├── cli/                # CLI + REPL
│   ├── main.ts         # Entry point (commander subcommands)
│   ├── commands.ts     # init, config, model, provider, session subcommands
│   ├── repl.ts         # Readline loop with slash commands
│   ├── completer.ts    # Provider-based tab completion
│   └── setup.ts        # Interactive setup wizard (port scan → test)
├── config/             # 3-layer config: defaults → global → project + env
├── i18n/               # en.json + ru.json + t() function
├── ui/                 # Rendering layer
│   ├── md-formatter.ts # Markdown→ANSI (headings, tables, quotes, checkboxes, hr, inline)
│   ├── table.ts        # Aligned tables via string-width + renderTable(headers, rows)
│   ├── box.ts          # Boxes with titles, dividers, ANSI-safe text wrapping
│   ├── spinner.ts      # Zero-dep ANSI spinner (stderr, single-line overwrite)
│   ├── renderer.ts     # Rich/plain Renderer + boxed tool cards + summarizeArgs
│   ├── diff.ts         # LCS-based diffs for file edits
│   └── output.ts       # writeOutput/writeError/writeSuccess/writeWarning
├── logger/             # Structured logger with levels + child loggers
└── migration/          # MMA v1→v2 detection, backup, safe startup
```

## Question Tool

Interactive Q&A for clarifying ambiguous tasks, gathering preferences, and offering choices to the user.

### API

The model sends a `question` tool call with one or more questions:

```json
{
  "questions": [
    {
      "question": "Which framework do you prefer?",
      "header": "Framework choice",
      "options": [
        { "label": "React", "description": "Library from Meta" },
        { "label": "Vue", "description": "Progressive framework" },
        { "label": "Svelte", "description": "Compile-time framework" }
      ],
      "multiple": false,
      "custom": true
    }
  ]
}
```

**Parameters:**

| Field | Required | Description |
|-------|----------|-------------|
| `question` | yes | Complete question text |
| `header` | no | Short label (max 30 chars) shown above the question |
| `options` | no | Array of `{label, description}` choices; omit for free-text |
| `multiple` | no | Allow selecting more than one option |
| `custom` | no | Allow typing a custom answer (default: true when options present) |

### UX

- **No options:** free-text input, returns the text.
- **Single selection:** numbered menu `[1] React — ...`, user enters a number.
- **Multiple selection:** comma-separated numbers `1,3`.
- **Custom entry:** automatically appended as the last option when `custom: true`.
- **Sequential questions:** shown as `Question 1/3` in the header.

### Implementation

- `src/tools/user-input.ts` — shared interactive primitive (`parseSelection`, `formatMenu`, `askChoice`, `askText`, `askUser`).
- `src/tools/question.ts` — tool definition, normalizes legacy `{question: string}` format, calls `askUser()` sequentially per question.
- `src/tools/approve.ts` — thin wrapper: two options (Yes/No), `success:false` on reject.

### Timeout Bypass

`question` and `approve` are marked `interactive: true` in `ToolDefinition`. The executor (`executor.ts`) skips the 60-second timeout for interactive tools — they block until the user answers.

### Known Limitations

- Multiple subagents in MoE parallel waves asking questions on the same stdin would conflict. Not supported.
- No REST/SSE event system (unlike opencode). Questions work only in CLI/REPL with direct stdin.

## Session Management

Sessions persist conversation history to `~/.mma/sessions/<id>/` as `meta.json`, `history.jsonl`, and `session.jsonl`.

### REPL slash commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `/sessions` | `/ls` | List all sessions (* active) |
| `/new <name>` | `/create` | Create a new session |
| `/resume <id\|name>` | `/switch`, `/use` | Switch to a session |
| `/rename <name>` | | Rename current session |
| `/delete <id>` | `/rm` | Delete a session |

### CLI subcommands

```bash
mma session list              # List all sessions
mma session show <id>         # Show session details
mma session delete <id>       # Delete a session
```

### Data layout

```
~/.mma/sessions/
├── ses_abc123/
│   ├── meta.json        # SessionMeta (name, model, counts, timestamps)
│   ├── history.jsonl    # JSONL of SessionMessage[] (user/assistant/tool summaries)
│   └── session.jsonl    # Detailed execution log: tool calls, args, results, timing, errors
└── ses_def456/
    ├── meta.json
    ├── history.jsonl
    └── session.jsonl
```

### Config

In `config/defaults.ts` / `~/.mma/config.json`:

```json
{
  "session": {
    "autoSave": true,
    "maxSessions": 50,
    "isolateMemory": false
  }
}
```

Messages are persisted to `history.jsonl` on each iteration. `session.jsonl` records full tool call details (arguments, raw output, duration, success/failure) for debugging and post-mortem analysis. Context compaction no longer duplicates existing messages — it writes a single compacted summary to the session. The `search_history` tool searches across all `history.jsonl` files.

## Browser Tool

Playwright-based headless browser for web navigation, form filling, and page interaction.

### Actions

| Action | Parameters | Description |
|--------|-----------|-------------|
| `open` | `url` | Navigate to URL, returns element snapshot |
| `click` | `target` (number) | Click element by snapshot index |
| `type` | `target`, `text` | Type text into element |
| `scroll` | `direction` (up/down/top/bottom) | Scroll page |
| `back` | — | Go back in history |
| `forward` | — | Go forward in history |
| `screenshot` | — | Capture page screenshot (vision models only) |
| `snapshot` | — | Re-read current page elements |
| `wait` | `ms` | Wait for page changes |
| `close` | — | Close browser session |

### Accessibility Tree Snapshot

Instead of raw HTML, returns compact numbered element list:

```
Page: "Example Domain"
URL: https://example.com

[1] link "More information..." → http://www.iana.org/domains/example
[2] textbox "Search" 
[3] button "Submit"
```

Model interacts using element numbers (e.g., `click(target: 1)`).

### Vision Fallback

- **Vision models** (gpt-4o, claude, etc.): receive screenshot as base64 image
- **Text-only models** (qwen3.5-9b, etc.): receive text-only message + snapshot

### Stuck Detection

Tracks repeated actions (same action + same URL × 3). Warns model to try different approach.

### Cookie Persistence

Cookies saved to `.mma/browser/cookies.json` between sessions. Enables staying logged in across agent runs.

### Config

```json
{
  "browser": {
    "enabled": true,
    "headless": true,
    "maxElements": 30,
    "viewportWidth": 1280,
    "viewportHeight": 720,
    "navigationTimeout": 15000
  }
}
```

## Project Map

MMA automatically builds and maintains a map of the current workspace.

- Triggered at agent startup; cached to `<project>/.mma/index-cache.json`.
- Re-scans on file changes via a file watcher and exposes the result as a system prompt block.
- `project_map` tool lets the model query the current map:

| Action | Parameters | Description |
|--------|-----------|-------------|
| `summary` | — | Languages, file counts, top directories, key exports |
| `refresh` | — | Force a full re-index |
| `find` | `query` | Search files by path or exported symbol name |

- Source: `src/modules/indexer/` (`walker.ts`, `cache.ts`, `module.ts`).

## UI Rendering

Agent output flows through `src/ui/renderer.ts` (`Renderer`), chosen automatically: **rich** when `process.stdout.isTTY && !process.env.CI`, otherwise **plain**. Colors come from `src/ui/colors.ts` (`createColors`), enabled only on a TTY and disabled in CI / on `NO_COLOR` (overrides picocolors' win32 default-on).

**Event flow:** `Agent.run()` takes `(onChunk, onMeta, onTool, onPhase)`. The renderer maps:
- `text` → markdown-formatted streaming (via `FormattingStream`)
- `meta` → raw status/output lines (reasoning, tool results, MoE status)
- `onTool` `start`/`end` events → boxed tool cards (rich) or `⚙ name` prefixes (plain)
- `onPhase` `thinking`/`done` → thinking spinner (e.g. `⠋ Thinking…`) while the model loads and generates; auto-cleared on first chunk, tool card, or `done`

**Rich mode extras:**
- Spinner (`src/ui/spinner.ts`) on stderr during LLM wait and tool execution — single-line `\r` overwrite, cleared before any text write.
- Tool cards: `┌─ ✓ write_file ─┐` with args summary, wrapped body, duration.
- Markdown v2: aligned tables (`│` borders), blockquotes, checkboxes, hr, italic, links.

**Config:** `ui.spinner` in `config/defaults.ts` toggles the spinner. Tool `friendly` labels come from i18n `tool.friendly.*`. All user-facing strings still go through `t()` (rule #8) — this includes REPL header, `/help` groups, setup wizard, and tool cards.

## Plugins

> **Guide:** [docs/plugins.md](./docs/plugins.md) — hooks, загрузка, примеры.

Плагины перехватывают события агента. Интерфейс — `AgentPlugin` (`src/modules/types.ts`), диспетчер — `src/modules/plugins/manager.ts`. Изоляция ошибок: падение плагина не останавливает агента и других плагинов.

**Загрузка:** встроенные (`src/modules/plugins/builtin/`), глобальные `~/.mma/plugins/*.{ts,js}`, проектные `<project>/.mma/plugins/*.{ts,js}` (`.ts` — только под Bun). Экспорт `default` или `plugin`.

**Хуки:**

| Хук | Момент | Особенность |
|-----|--------|-------------|
| `onBuildPrompt` | сборка системного промпта (1 раз) | строка добавляется блоком `low`-приоритета |
| `onBeforeThink` | перед каждым LLM-вызовом | |
| `onAfterThink(ctx, response)` | после ответа LLM | `response` = `LLMResponse` или `null` |
| `onBeforeTool` | перед тулом | `false` = заблокировать (короткозамыкает) |
| `onAfterTool` | после тула | может мутировать `result.output` |
| `onToolCall` | LLM вернул тул-вызов | `ctx.toolName`, `ctx.args` |
| `onToolStart` / `onToolEnd` | тул-карточка открыта/закрыта | `onToolEnd` даёт `result` + `durationMs` |
| `onPhase` | спиннер: `thinking` / `done` | |
| `onText` / `onMeta` | чанк стриминга | вернуть строку — заменить на экране, `undefined` — пропустить |
| `onError` | ошибка LLM | |
| `onSessionStart` / `onSessionEnd` | жизненный цикл сессии | |

**UI-хуки** (`onPhase`, `onToolStart`/`onToolEnd`, `onText`/`onMeta`) дают плагинам видимость и контроль над тем, что видит пользователь: спиннер, тул-карточки, стриминг. `onText`/`onMeta` влияют только на отображение, `result.text` не меняется.

## Context Budget (dynamic, from model.contextWindow)

| contextWindow | System (10%) | Reserve (15%) | History (75%) |
|---------------|-------------|---------------|---------------|
| 32K           | 3K          | 5K            | 24K           |
| 64K           | 6K          | 10K           | 48K           |
| 128K          | 13K         | 19K           | 96K           |

Compaction triggers at 75% history budget or every 15 iterations. Keeps last 6 turns full; older turns → structured summary preserving created/updated files, plan state, key decisions, and errors. The summary is saved once to the session log — no duplication of old messages. Token counting uses `js-tiktoken` via injected `TokenCounter` when available, falling back to `content.length / 2` heuristic for backwards compatibility.

## Process Management

Long-running commands (dev servers, watchers) no longer block the agent.

### Bash behavior

- The `bash` tool uses **async spawn** (non-blocking event loop); the old `execSync` blocking behavior is gone.
- Commands detected as long-running (heuristic in `src/modules/processes/detect.ts`: `run dev`, `--watch`, `vite`, `next dev`, `uvicorn`, etc.) start in the **background** automatically and return a process id immediately instead of hanging.
- Force background with `background: true`, force foreground with `background: false`.
- Foreground commands are killed on the executor timeout (60s) via kill-by-call-id; the tool also has its own 120s backstop timeout.

### Management tools

| Tool | Purpose |
|------|---------|
| `process_list` | List background processes: id, PID, command, status, last output line |
| `process_log` | Show buffered output of a background process (`id`, optional `tail`) |
| `process_kill` | Kill a background process tree (`id`) — works even though `kill`/`pkill` are blocked by the bash security blacklist |

- PIDs are tracked in `src/modules/processes/registry.ts` (per-session, capped at 20 entries, 300 log lines each). Output buffers are capped.
- Windows: processes are killed with `taskkill /pid <pid> /T /F`; POSIX: process-group kill (`detached` spawn).
- `Agent.shutdown()` kills all remaining background processes (no orphans).

## Execution Guarantees

### Plan Enforcement

- `autoPlan: true` adds a strong system prompt directive to create a plan for any multi-step task
- The plan is always visible in the system prompt as a checklist `[x]` / `[ ]`
- The execution module warns the model when a tool call targets files outside the current step
- After `write_file` / `edit_file`, the execution module auto-advances the plan if all files mentioned in the current step exist

### Stuck Detection

- `stuckThreshold` (default 8) — too many iterations on the same step injects a recovery message
- `tool repetition` — 3 identical tool calls with the same arguments inject a recovery message
- `off-track` — tool calls touching files not in the current step trigger a warning

### Auto-Verification

- Builtin `lint-on-write` plugin runs after every `write_file` / `edit_file`
- TypeScript files: per-file `tsc --noEmit --skipLibCheck` + project-wide `tsc --noEmit --skipLibCheck` when `tsconfig.json` exists (debounced at 2s)
- JavaScript files: `node --check`
- Syntax errors are appended to the tool result so the model can fix them immediately
- **Final Audit**: Before declaring task complete, the Auditor checks plan completion (all steps done, no missing files) and runs project-wide typecheck. If incomplete, a warning is injected into context and the agent continues working.

### Final Audit Gate

- Triggered when the model returns a final answer (no tool calls) and a plan is active
- Runs `Auditor.audit(plan)` which checks: file existence from step descriptions + project-wide `tsc --noEmit --skipLibCheck`
- If audit fails (`passed: false`), injects `<system-summary>` warning with pending steps and typecheck errors
- Agent continues the loop instead of breaking — bounded by `maxToolIterations`
- Session log records audit events with type `"audit"`

## Agent Loop States

```
INIT    → collect system prompt blocks → build context
THINK   → call LLM → validate response (hallucination check)
ACT     → parse tool_call → execute via ToolExecutor
OBSERVE → process results → check termination → loop or done
OUTPUT  → show text to user → wait for input
ERROR   → retry or escalate
```

## Orchestrator (optional)

If `orchestrator.model` configured: larger model handles planning, conflict resolution, audit. Worker (9B) executes steps. If not set — everything runs on one model.

## Hallucination Detection Pipeline

```
LLM response → ConfidenceCheck (short/repetitive) 
             → FactualCheck (paths vs known set) 
             → ConsistencyCheck (decision reversal)
```

Results: `pass` → show | `warn` → show with ⚠️ | `retry` → re-call LLM | `block` (3+ retries) → ask user

## Migration Safety

MMA v2 auto-detects v1 config on first load. If `~/.mma/config.json` lacks `version: "2.0.0"` or has v1-only fields (`apiBase`, `temperature`):
1. Backs up `config.json` → `config.json.bak`
2. Backs up entire `~/.mma/` → `~/.mma.bak/`
3. Starts fresh with v2 defaults
4. Old plugins/skills with incompatible format are skipped gracefully

## Versioning Rules (Semantic Versioning)

### When to bump which part:

| Version Part | When to Bump | Examples |
|-------------|--------------|----------|
| **MAJOR** (X.0.0) | Breaking changes: API changes, config schema changes, removed commands/tools, architecture rewrites | v1.0.0 → v2.0.0 (MMA v1→v2 rewrite), config version field change |
| **MINOR** (0.Y.0) | New features, new commands, new tools, new modules, new REPL commands, new CLI subcommands | Add `/reload`, `mma model list`, new security policy, new skill, new plugin hook |
| **PATCH** (0.0.Z) | Bug fixes, typo fixes, i18n additions, doc updates, performance improvements, test additions, dependency updates (non-breaking) | Fix crash in `bash` tool, add ru translation, update README, fix typo in error message |

### Release Process:

1. **Code changes complete** → `bun test` + `tsc --noEmit` must pass
2. **Update version** in `package.json`:
   ```bash
   # For patch
   npm version patch
   
   # For minor  
   npm version minor
   
   # For major
   npm version major
   ```
3. **Build**: `bun run build`
4. **Publish**: `npm publish --access public`
5. **Git tag**: `npm version` creates tag automatically, push with `git push --follow-tags`
6. **Update CHANGELOG** (if exists) or AGENTS.md with notable changes

### Commands that require MINOR bump:
- New CLI subcommand (`mma <new-cmd>`)
- New REPL slash command (`/new-cmd`)
- New tool in `tools/`
- New module in `modules/`
- New provider capability (e.g., `listModels()` in LLMProvider)
- New config option that changes behavior
- New security policy/feature

### Commands that require PATCH bump:
- Bug fixes in existing commands/tools
- i18n string additions/fixes
- Documentation updates
- Test additions
- Performance optimizations
- Dependency updates (non-breaking)

### Commands that require MAJOR bump:
- Removing/renaming CLI commands
- Changing config schema (breaking)
- Removing tools/modules
- Changing Agent loop state machine
- Changing LLMProvider interface (breaking)
- Architecture rewrites

### Current Version: 0.12.1
- **0** = pre-1.0 (initial development)
- **12** = minor features added (model list, context, reload, security policies, MoE phases, etc.)
- **1** = patch fixes (duplicate i18n key, help auto-generation verification)
