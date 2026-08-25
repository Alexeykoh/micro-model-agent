# MMA v2 — Micro Models Agent

AI coding agent harness for small models (Qwen3.5-9B, 32K-64K context). Complete rewrite from MMA v1.

> **Design spec:** [docs/specs/2025-07-28-mma-v2-design.md](./docs/specs/2025-07-28-mma-v2-design.md) — architecture, modules, tools, CLI, config, data flow.

> **Literature:** [docs/literature.md](./docs/literature.md) — agent harness engineering best practices audit (Anthropic, OpenAI, LangChain, HuggingFace, deepset, Martin Fowler).

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

# Build (bundle + copy skills — use this for npm releases)
bun run build:prod

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

## Наблюдения за маленькими моделями

> **Журнал:** [docs/small-model-observations.md](./docs/small-model-observations.md)

При обнаружении систематической особенности поведения маленьких моделей (Qwen3.5-9B и подобных) —
например, «модель создаёт файлы через bash вместо `write_file`» — **обязательно** запиши наблюдение
в `docs/small-model-observations.md`: симптом, где проявилось (сессия/сценарий сертификации),
реакция harness (существующий механизм или новый фикс), статус. Не исправляй такое поведение
точечным костылём без фиксации в журнале: паттерны повторяются между сессиями и сценариями,
и знание о них должно пережить рефакторинги. Формат записи описан в самом файле.

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
  - Blocking of dangerous operators (`|`, `>`, `>>`, `;`, `&&` — when `blockDangerousFlags` is enabled)
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
  enabled: boolean;
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

Security is **disabled by default** (`SecurityConfig.enabled: false`):

- All validators (command, path, network, content scan) return `allowed: true` when `enabled` is `false`
- The default `DEFAULT_SECURITY_CONFIG` has empty/benign defaults — blacklists exist as templates, not active rules
- To enable security: set `security.enabled: true` and configure individual modules (bash, paths, network, contentScan)
- Each sub-module also has its own `enabled` flag for granular control
- Existing code continues to work without modifications

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

## Model Certification

> **Spec:** `docs/specs/2026-08-05-model-certification-design.md` — offline harness that runs test scenarios through the real agent against a (model, provider) pair.

**Status:** Implemented.

Purpose: distinguish "this model works with MMA on this backend" from "untested". A certification is **not** a general endorsement — it states that on a specific provider URL the model ran the suite and passed N/M repetitions.

- **Commands:** `mma model certify <name> [--provider-url <url>] [--tags core,security,image,network,browser,moe] [--scenarios <ids>] [--reps N] [--force] [--clean]`, `mma model cert-status <name>`, `mma model cert-list`, `mma model uncertify <name>`.
- **Targeted re-run:** `--scenarios <ids>` (comma-separated, case-insensitive) runs only those scenarios and MERGES the fresh results into the existing certification entry — previous results for non-rerun scenarios are preserved verbatim (`mergePartialResults()` in `cli.ts`). A partial run does NOT require `--force` (it's an incremental update); a full-suite re-run still does. Unknown ids abort with the list of available scenarios.
- **Per-rep timeout:** default 300s; override via CLI `--timeout <ms>` (run-level) or per-scenario `timeoutMs` (YAML + `CertScenario`, validated >= 1000). Priority: `scenario.timeoutMs` → `opts.timeoutMs` → 300_000. Scenario 3.5 ships with `timeoutMs: 600_000` — slow local reasoning models (~30-45s per LLM call, ~12 iterations) complete the task correctly but miss the old default (see docs/small-model-observations.md).
- **Audit gate vs exit-on-complete:** the harness runs the agent with `--exit-on-complete`; its fast-exit on a hallucination-retry-flagged first response does NOT bypass the final audit gate when a plan is active (`agent.ts`) — otherwise a model that answers "done" without finishing the plan passes silently.
- **Tags:** `core` (default, no external deps), `security` (requires config, applied per-scenario), `image`, `network`, `browser`, `moe`.
- **Per-scenario config:** scenarios can declare `config:` overrides that are deep-merged into the base config and written to the sandbox as `<sandbox>/.mma/config.json`. The spawned process reads it via `MMA_CONFIG_DIR` env var. This enables security/MoE/LSP testing without requiring the user's global config to have those features enabled.
- **Manifest:** **global** `~/.mma/certifications.json` — entries keyed by `(model, providerUrl)`, recording `mmaVersion`, suite summary, and per-scenario results. Certifications are machine-scoped (model+provider), not project-scoped: marks are visible from any working directory. A bundled copy ships with the package (`certification/certifications.json` in the repo → copied to `dist/certification/` by `scripts/copy-assets.ts`) and is synced into the global manifest at every startup (`syncGlobalManifest()` in `manifest.ts`, called from `bootstrap.ts`): on a package update the bundled entries overwrite their keys; user-local certifications for other keys are preserved. A snapshot file (`~/.mma/certifications.synced.json`) prevents rewrites between updates. Legacy per-project manifests (`<project>/certification/certifications.json`, git-tracked) are still read and merged into every display lookup (`readMergedManifest`); `uncertify` cleans both stores.
- **Checkmarks:** `mma model list` and REPL `/model` show `✔` (certified on this provider, MMA version matches), `○` (certified on an older MMA version — re-run `--force`), `·` (not certified).
- **Harness mechanics:** spawns `bun src/cli/main.ts` per scenario rep with `--no-agents-md --exit-on-complete -d <sandbox>`, injecting `(model, provider)` via the existing env overrides (`MMA_MODEL`, `MMA_PROVIDER_BASEURL`, `MMA_PROVIDER_APIKEY`, `MMA_CONTEXT_WINDOW`). Fact-checks: files, exit code, output substring (`outputContains` for security scenarios). M/N tally per scenario (default 2/3).
- **Source:** `src/modules/certification/` (`types`, `scenarios`, `loader`, `fact-checker`, `runner`, `manifest`, `cli`). It is an offline tool independent of the agent loop — never part of the system prompt or context.
- **Scenarios:** builtin in `scenarios.ts` (ported from `docs/testing/scenarios.md`); user-defined YAML in `<project>/.mma/certification/scenarios/*.yaml`. Image fixtures in `docs/testing/fixtures/`.

### Agent-Level MoE

> **Spec:** `docs/specs/2025-07-30-agent-level-moe.md` — Router + Expert-Agent + Expert-Tools, hierarchical recursive decomposition.
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

### Правило 5: Обработка HTTP 429 (rate limit)

`fetchWithRetry` в `openai-compat.ts` ретраит 429/5xx с экспоненциальным бэкоффом. Для 429:

- **Уважение `Retry-After`** — если провайдер отдал заголовок `retry-after`, задержка берётся из него (с капом `maxDelay`), иначе экспоненциальный бэкофф. Free-модели (например `*-free` на OpenCode Zen) требуют реальной паузы — короткий бэкофф не помогает.
- **Понятное сообщение об ошибке** — если 429 сохраняется после всех ретраев, бросается `error.llm_429` (i18n, en+ru) с model/baseUrl и подсказкой: получить API-ключ или сменить модель. Агент показывает его как `Ошибка LLM: …` вместо голого `HTTP 429`.

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
6. **Path safety** — all filesystem tools validate resolved paths through `isInsideDir` / `isPathWritable` / `isPathInScope` (separator- and case-safe on win32; sibling prefixes like `docs` vs `docs-other` cannot pass). After a subagent call the parent's scope is restored EXACTLY (`undefined` stays `undefined` — an empty `{[],[]}` scope would deny everything).

### Known path-handling nuance (do not forget)

`safeResolvePath` (`src/tools/path-utils.ts`) "fixes" model typos like `E:\agent_test` → `E:\agent\_test` by walking ancestors and substring-matching directory names, and honors existing absolute paths as-is. This heuristic is intentionally risky: it can resolve a path outside baseDir (e.g. a bare `/foo` that exists on disk, or a substring match against an ancestor name). It is SAFE today only because every caller re-validates the returned path via `isPathInScope`/`isPathWritable` before touching the filesystem. **Rule: any new tool that uses `safeResolvePath` MUST re-validate the result with one of those two functions** — do not trust its return value alone. If this invariant breaks, prefer removing the heuristic over adding containment inside it.
7. **TDD** — write test first, then implement, then commit
8. **No hardcoded user-facing strings** — ALL text shown to users MUST go through `t()` from `i18n/index.ts`. Both `en.json` and `ru.json` must have matching keys. No exceptions — CLI labels, error messages, tool outputs, REPL prompts, setup wizard text, everything.
9. **No full-screen TUI** — no alternate screen buffer, no raw-mode, no full-frame redraw. Rich ANSI output is allowed: spinner (single-line `\r` overwrite on stderr), boxed tool cards, aligned tables. Auto-degrades to plain text when `!isTTY` or `CI`.
10. **No keyword matching for task classification** — determining whether a task is multi-step, needs planning, or requires specific tools via keyword/word matching is an anti-pattern. It fails for non-English languages, ambiguous inputs, and novel task patterns. Instead, use the system prompt to instruct the model to use the `plan` tool when appropriate. The model decides whether to create a plan based on task complexity, not hardcoded heuristics.
11. **Interactive tools bypass the execution timeout** — tools that block on user input (`question`, `approve`) must set `interactive: true` on their `ToolDefinition`. The executor skips the 60s timeout for them. Any new user-facing interactive tool must do the same, and must reuse `user-input.ts` instead of creating its own readline interface.
12. **No static imports for build-time values** — never use a static import to load a value that a bundler resolves at build time (package version, build metadata). Bundlers inline it with a stale value. Always read it from disk at runtime. (Concrete repo case: read `package.json` via `readFileSync` + `fileURLToPath(import.meta.url)` with path candidates for both source `src/cli/` and bundled `dist/` layouts — see `readVersion()` in `src/cli/commands.ts`.)
13. **Separate app creation from server start** — when creating a web server (Express, FastAPI, Go http, etc.), always export the app/handler object separately from the `listen()` call. This allows tests to import and test the app without binding to a port. Pattern: create app → export app → if main module, call listen().

## Project Structure

```
src/
├── core/               # Agent loop + prompt builder + types
│   ├── agent.ts        # State machine (INIT→THINK→ACT→OBSERVE→OUTPUT→ERROR)
│   ├── prompt-builder.ts # Collect PromptBlock[], sort by priority, fit 8K budget
│   ├── environment.ts  # Startup env report (OS/runtime/engines/tools/playwright) + requirement warnings
│   ├── crash-handler.ts # Global uncaughtException/unhandledRejection → ~/.mma/logs/crash.jsonl
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
│   ├── download-file.ts # Download a binary file (image/archive/…) from a URL to disk; metadata-only result, size cap, path+network validation
│   ├── browser.ts      # Playwright browser tool (open, click, type, scroll, screenshot)
│   ├── attach-image.ts # Attach image from file/URL/clipboard → multimodal message
│   ├── user-input.ts   # Interactive user input primitive (menu, selection parsing, askUser)
│   ├── plan.ts, todo.ts, question.ts, approve.ts
│   ├── load-skill.ts, pipeline-run.ts, mcp-call.ts, search-history.ts
│   └── ...             # list-dir, create-dir, delete-file, move-file, file-info
│                       # Module-provided: plan/todo/verify (execution), project_map (indexer), lsp_check (lsp)
├── modules/            # All modules implement AgentModule interface
│   ├── registry.ts     # ModuleRegistry: collect blocks/tools/plugins from modules
│   ├── types.ts        # AgentModule, AgentPlugin interfaces
│   ├── pricing/        # Cost tracking + display (budget/tariff)
│   │   ├── prices.ts   # Builtin Zen/Go price table (USD/1M tokens) + calculateCost/formatCost
│   │   └── index.ts    # CostTracker — accumulate per-LLM-call cost for a session
│   ├── skills/         # Skills loader (builtin/global/project) + progressive disclosure L1/L2/L3
│   ├── plugins/        # PluginManager with lifecycle hooks + error isolation
│   ├── mcp/            # MCP client (stdio/SSE) + server registry
│   ├── pipelines/      # DAG-based workflow engine (YAML → execute)
│   ├── indexer/        # Automatic project map: file walker + export extraction + disk cache
│   │   ├── walker.ts   # Recursive walker, language detection, export extraction
│   │   ├── cache.ts    # JSON cache of index results
│   │   └── module.ts   # AgentModule — PromptBlock + project_map tool + watch plugin
│   ├── lsp/            # LSP diagnostics (typescript/css), on-demand + write/edit plugin
│   │   ├── module.ts   # AgentModule — lsp_check tool + onAfterTool plugin (per-server disable, cap 40)
│   │   ├── check-tool.ts # lsp_check helpers: collectCheckFiles (dir walk, cap 15) + formatCheckDiagnostics
│   │   ├── probe.ts    # probeLspServers — REPL banner: which servers apply to the project + do they start
│   │   ├── client.ts   # LSP over stdio (spawn, initialize, didOpen, shutdown) + probe()
│   │   ├── command.ts  # resolveSpawnCommand + buildWinCommandLine (win32 shell)
│   │   ├── config.ts   # Per-language server config (command/args/workspaceMarkers)
│   │   └── project-root.ts # findProjectRoot via workspace markers
│   ├── memory/         # Persistent markdown (conventions.md, decisions.md, errors.md)
│   ├── context/        # ContextManager (budget calc, sliding window compaction)
│   │   └── fact-extractor.ts # FactExtractor — regex fact extraction from tool messages (split from manager.ts)
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
│   │   ├── auditor.ts  # Final audit after all steps
│   │   ├── audit-runners.ts # Test/typecheck runners + parseTypecheckErrors (split from auditor.ts)
│   │   ├── plan-tool.ts  # plan/todo/verify tool definitions (createPlanToolDefinitions factory)
│   │   └── execution-plugin.ts # plugin hooks: onBeforeThink/onBeforeTool/onToolCall/onAfterTool (createExecutionPlugin factory)
│   ├── processes/      # Background & foreground process management
│   │   ├── runner.ts   # Kill-by-call-id registry (executor timeout/abort)
│   │   ├── registry.ts # Process registry: pid tracking, output buffer, waitForExit, kill/killAll/remove
│   ├── updater/        # Self-update: async npm check + auto-install
│   │   ├── checker.ts  # Updater.check() (registry fetch) + install() (npm install -g)
│   │   └── module.ts   # UpdaterModule — fire-and-forget background loop, autoInstall
│   ├── user-profile/   # OS/shell/preferences → ~500 token compressed block
│   └── browser/        # Playwright browser module (session, snapshot, actions, cookies)
│       ├── types.ts    # BrowserConfig, BrowserState, ElementEntry, ActionResult
│       ├── driver.ts   # BrowserDriver interface + PlaywrightDriver + createBrowserDriver() (direct/Bun-bridge selection)
│       ├── bridge-client.ts # BridgeDriver — RPC over stdio to node bridge-server.mjs
│       ├── bridge-server.mjs # Node-side Playwright wrapper (plain .mjs, no bundling)
│       ├── session.ts  # BrowserSession — driver lifecycle + action dispatch
│       ├── snapshot.ts # Page → numbered accessibility tree (interactive elements)
│       ├── actions.ts  # Script builders for click, type, scroll
│       ├── cookie-store.ts # Cookie/session persistence to disk
│       └── module.ts   # AgentModule — PromptBlock + Plugin hooks
├── cli/                # CLI + REPL
│   ├── main.ts         # Entry point (commander subcommands)
│   ├── commands.ts     # init, config, model, provider, session subcommands
│   ├── repl.ts         # Readline loop with slash commands
│   ├── repl-commands.ts # REPL slash command definitions (separate from loop)
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
│   ├── line-math.ts    # Pure line-layout math (wrapLine, buildLayout, charLen, stripAnsi)
│   ├── line-editor.ts  # Custom TTY line editor (LineInput): kitty CSI u / Shift+Enter newline, Ctrl+J, bracketed paste, visual nav, history
│   └── output.ts       # writeOutput/writeError/writeSuccess/writeWarning
├── logger/             # Structured logger with levels + child loggers
└── migration/          # MMA v1→v2 detection, backup, safe startup
```

## Question Tool

> **Status: DISABLED** — interactive menus are too disruptive for small models (Qwen3.5-9B). The model should ask questions as plain text in its response instead. Source files (`question.ts`, `approve.ts`) exist but imports are commented out in `src/tools/index.ts:29-32`. Re-enable requires uncommenting imports + adding to `registerAllTools()`.

Interactive Q&A for clarifying ambiguous tasks, gathering preferences, and offering choices to the user.

### API (disabled — kept for reference)

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

| Field      | Required | Description                                                       |
| ---------- | -------- | ----------------------------------------------------------------- |
| `question` | yes      | Complete question text                                            |
| `header`   | no       | Short label (max 30 chars) shown above the question               |
| `options`  | no       | Array of `{label, description}` choices; omit for free-text       |
| `multiple` | no       | Allow selecting more than one option                              |
| `custom`   | no       | Allow typing a custom answer (default: true when options present) |

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

### REPL Input Locking (`withExclusiveInput`)

When a slash command needs exclusive access to stdin (e.g., interactive setup wizard, multi-step prompt), use `Repl.withExclusiveInput(fn)` to prevent the REPL's line handler from processing input during the interactive flow:

```typescript
// In any slash command action:
action: async () => {
  await repl.withExclusiveInput(async () => {
    // Interactive readline — no REPL handler interference
    const answers = await runSetup(repl.rl);
  });
};
```

**How it works:**

- `withExclusiveInput()` sets `inputLocked = true` before running the callback
- REPL line handler checks `this.agentRunning || this.inputLocked` — skips routing to agent/commands when locked
- `finally` block guarantees `inputLocked` is cleared on errors

**When to use:**

- Any REPL command that takes over stdin for a multi-step interactive flow
- Whenever a new `readline.Interface` on `process.stdin` would conflict with the REPL's own readline
- Interactive tools should accept the REPL's existing readline instead of creating their own (see `runSetup(externalRl?)`)

### REPL Command Architecture

REPL commands are defined in `src/cli/repl-commands.ts` (separate from the REPL loop in `repl.ts`). Commands receive a `ReplContext` interface that grants access to configuration, agent, session manager, skills, plugins, readline, and control methods (`registerCommand`, `withExclusiveInput`, `runAgent`, `showHelp`).

```typescript
// src/cli/repl/commands.ts
export interface ReplContext {
  readonly config: AppConfig;
  readonly agent: Agent;
  readonly rl: LineInput; // TTY → LineEditor, non-TTY → readline.createInterface
  readonly sessionManager?: SessionManager;
  readonly skillsModule?: SkillsModule;
  readonly pluginManager?: PluginManager;
  registerCommand(cmd: SlashCommand): void;
  runAgent(input: string): Promise<void>;
  withExclusiveInput(fn: () => Promise<void>): Promise<void>;
  showHelp(): void;
  setupCompleter(): void;
}
```

**To add a new slash command:** define its action in `repl-commands.ts` — no changes to `repl.ts` needed.

### REPL Line Editor

> **Status:** custom `LineEditor` restored (v0.33.0). Node's `readline` hangs under Bun on EOF and provides no wrapping/navigation, so the REPL uses a hand-rolled editor on TTY.

- `src/ui/line-editor.ts` — `LineEditor` implements `LineInput` (setPrompt/prompt/write/question/close/on) + `onKeyInput` host hook. TTY: raw mode + `emitKeypressEvents`; non-TTY: `data`-based line reading.
- `src/ui/line-math.ts` — pure layout math (wrap-by-width, `\n` hard breaks, CJK double-width, visual col↔char mapping), unit-tested separately from the editor.
- **Keys:** Enter/CR = submit; bare LF (`enter`) = insert `\n` (this is Ctrl+J); kitty `Shift+Enter` (`\x1b[13;2u`) and `Esc+Enter` also insert newline; bracketed paste (`\x1b[200~/201~`) inserts multi-line text; `Esc Esc` interrupt; up/down history; left/right/Home/End visual navigation over wrapped lines; Tab completion.
- **Rule:** after a CR submit the following LF (`enter`) from CRLF is swallowed — no double submit.
- **Why:** popular harnesses (opencode → OpenTUI + kitty keyboard protocol; Gemini CLI → ink; Claude Code/Codex/aider → custom keypress editors) never use `readline` for interactive input; full-screen TUIs stay out per rule #9.
- **Exit flow:** `Repl(…, exitOnClose: true)` (from `main.ts`) makes the close handler / stdin `end` exit the process so piped `echo "exit" | mma` terminates; tests construct `Repl` without it so `stop()` doesn't kill the runner.

## Session Management

Sessions persist conversation history to `~/.mma/sessions/<id>/` as `meta.json`, `history.jsonl`, and `session.jsonl`.

### REPL slash commands

| Command              | Aliases           | Description                  |
| -------------------- | ----------------- | ---------------------------- |
| `/sessions`          | `/ls`             | List all sessions (* active) |
| `/new <name>`        | `/create`         | Create a new session         |
| `/resume <id\|name>` | `/switch`, `/use` | Switch to a session          |
| `/rename <name>`     |                   | Rename current session       |
| `/delete <id>`       | `/rm`             | Delete a session             |

### REPL Keybindings

| Key         | Context            | Action                                                    |
| ----------- | ------------------ | --------------------------------------------------------- |
| `Esc` `Esc` | Agent/tool running | Interrupt current operation, return to prompt             |
| `Ctrl+C`    | Any                | Graceful shutdown (forces exit after 2s if agent running) |
| `Ctrl+V`    | Idle (in prompt)   | Paste image from clipboard                                |

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

**Context observability events** (in `session.jsonl`, added for post-mortem context analysis):

- `context` (kind `start`, iteration 1): initial context structure — `window`, `systemBudget`/`reserveBudget`/`historyBudget`, `systemTokens`, `toolTokens`, `contextTokens`, `quality`, `messageCount`, plus `blocks[]` — per-block system-prompt breakdown (`label`, `priority`, `tokens`, `included`) and what the budget excluded.
- `context` (kind `iteration`, every iteration): live context state before the LLM call — `contextTokens`, `quality`, `messageCount`, `compactionCount`, `iterationsSinceCompaction`. Lets you reconstruct exactly when/how the context filled up.
- `compaction` (enriched): `reason` (`interval`/`quality-triggered (N% < 40%)`/`overflow (N > M)`/`after_tool`), `tokensBefore`/`tokensAfter`, `qualityBefore`/`qualityAfter`, `messagesBefore`/`messagesAfter`, `removedTurns`/`keptTurns`, and `summary` — the actual `[Compressed: …]` block (task/files/errors/tried-and-failed). Tokens before/after come from `ContextManager.compact()` (which now returns a `CompactResult | null`, null when there is nothing to compact).
- `llm_usage` (per LLM call): `promptTokens`/`completionTokens`/`totalTokens`, `source` (`api` when the backend returned `usage`, else `estimate` — llama.cpp streaming often omits `usage`, so estimates are marked explicitly), `durationMs`.

Source: `ContextManager.getSnapshot()`/`compact()` in `src/modules/context/manager.ts`, `PromptBuilder.build()` block breakdown in `src/core/prompt-builder.ts`, logging in `src/core/session-logger.ts` (`logContext`/`logLlmUsage`/`logCompaction`).

## Browser Tool

Playwright-based headless browser for web navigation, form filling, and page interaction.

### Actions

| Action       | Parameters                       | Description                                  |
| ------------ | -------------------------------- | -------------------------------------------- |
| `open`       | `url`                            | Navigate to URL, returns element snapshot    |
| `click`      | `target` (number)                | Click element by snapshot index              |
| `type`       | `target`, `text`                 | Type text into element                       |
| `scroll`     | `direction` (up/down/top/bottom) | Scroll page                                  |
| `back`       | —                                | Go back in history                           |
| `forward`    | —                                | Go forward in history                        |
| `screenshot` | —                                | Capture page screenshot (vision models only) |
| `snapshot`   | —                                | Re-read current page elements                |
| `wait`       | `ms`                             | Wait for page changes                        |
| `close`      | —                                | Close browser session                        |

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
    "maxContentChars": 2500,
    "maxConsoleEntries": 40,
    "maxConsoleLineChars": 400,
    "viewportWidth": 1280,
    "viewportHeight": 720,
    "navigationTimeout": 15000
  }
}
```

### Browser Driver + Node Bridge

> **Status:** implemented (v0.32.0). `BrowserSession` talks to a `BrowserDriver` (`src/modules/browser/driver.ts`) instead of Playwright directly. There are two drivers:

- **`PlaywrightDriver`** — direct in-process Playwright (`chromium.launch()`). Used under Node.
- **`BridgeDriver`** (`bridge-client.ts` + `bridge-server.mjs`) — Playwright runs in a child `node` process; RPC is JSON-lines over stdio (`spawn('node', [bridge-server.mjs])`).

`createBrowserDriver()` picks the driver at runtime:

- **Under Bun → BridgeDriver always.** Playwright's pipe/websocket transport hangs under Bun on some platforms (launch never returns). The bridge runs under Node, where Playwright works reliably (~85ms launch).
- **Under Node → try `PlaywrightDriver` (8s direct-launch timeout), on failure dispose and fall back to `BridgeDriver`.**

Bridge protocol: commands `ping | launch | goto | evaluate | content | title | url | waitLoad | screenshot | cookies | setCookies | back | forward | close`. Responses are `{id, ok, data|error, console, network}` — each reply carries any console/network events drained since the previous command (`goto` clears the buffers before navigating). The bridge caps console at 500 entries and network at 100; long console lines are truncated to `maxConsoleLineChars` (default 400) with `…`. Event capture is identical to the direct driver: `page.on('console')`, `page.on('pageerror')` → `ConsoleEntry`, `page.on('requestfailed')` → `NetworkErrorEntry`.

**Build/deploy note:** `bridge-server.mjs` is plain JS and must be shipped next to the bundled `dist/` — `scripts/copy-assets.ts` copies `src/modules/browser/bridge-server.mjs` → `dist/modules/browser/`. `bridge-client.ts` resolves its path via `import.meta.url`, so it works in both `src/` and `dist/` layouts. `playwright` stays `external` in the bundle (loaded via `createRequire` inside the bridge).

- The snapshot includes a **Network errors** section (last 15 failed requests: `METHOD url → errorText`) and the console buffer (capped at `maxConsoleEntries`, default 40).

## Image Handling

MMA supports attaching images to the conversation via file path, URL, or clipboard.

### Image Processing Pipeline

Uses **Bun.Image** (built-in, zero dependencies) for image processing:

1. **Clipboard paste** (`Ctrl+V` or `/image clipboard`):
   - `Bun.Image.fromClipboard()` reads PNG/JPEG/WebP/GIF/BMP from system clipboard
   - Auto-resizes to 800px max width (preserving aspect ratio)
   - Converts to JPEG quality 60 (~5-15KB, ~2-4K tokens)
   - Falls back to platform-specific commands on Linux (xclip/wl-paste)

2. **File path** (`/image ./photo.png`):
   - Reads file, resizes via Bun.Image, converts to JPEG
   - Default: 800px max width, JPEG quality 60

3. **URL** (`/image https://example.com/img.png`):
   - Fetches image, resizes, converts to JPEG

### Token Budget

- **Before**: 200KB PNG → 260KB base64 → ~65K tokens (fills 32K context instantly)
- **After**: 200KB PNG → ~10KB JPEG → ~2.5K tokens (fits comfortably)

### Sources

- `src/llm/image-utils.ts` — `readClipboardImage()`, `loadFileAsDataUrl()`, `bufferToDataUrl()`
- `src/tools/attach-image.ts` — `attach_image` tool
- `src/cli/repl.ts` — `/image` command + `Ctrl+V` handler

### Config

No configuration needed — Bun.Image is built into Bun 1.3.14+.

## Project Map

MMA automatically builds and maintains a map of the current workspace.

- Triggered at agent startup; cached to `<project>/.mma/index-cache.json`.
- Re-scans on file changes via a file watcher and exposes the result as a system prompt block.
- `project_map` tool lets the model query the current map:

| Action    | Parameters | Description                                          |
| --------- | ---------- | ---------------------------------------------------- |
| `summary` | —          | Languages, file counts, top directories, key exports |
| `refresh` | —          | Force a full re-index                                |
| `find`    | `query`    | Search files by path or exported symbol name         |

- Source: `src/modules/indexer/` (`walker.ts`, `cache.ts`, `module.ts`).

## UI Rendering

Agent output flows through `src/ui/renderer.ts` (`Renderer`), chosen automatically: **rich** when `process.stdout.isTTY && !process.env.CI`, otherwise **plain**. Colors come from `src/ui/colors.ts` (`createColors`), enabled only on a TTY and disabled in CI / on `NO_COLOR` (overrides picocolors' win32 default-on).

**Event flow:** `Agent.run()` takes `(onChunk, onMeta, onTool, onPhase)`. The renderer maps:

- `text` → markdown-formatted streaming (via `FormattingStream`)
- `meta` → raw status/output lines (reasoning, tool results, MoE status)
- `onTool` `start`/`end` events → inline tool headers (rich, default) or `⚙ name` prefixes (plain)
- `onPhase` `thinking`/`done` → thinking spinner (e.g. `⠋ Thinking…`) while the model loads and generates; auto-cleared on first chunk, tool card, or `done`

**Rich mode extras:**

- Spinner (`src/ui/spinner.ts`) on stderr during LLM wait and tool execution — single-line `\r` overwrite, cleared before any text write.
- **Inline tool headers** (default, opencode-style): each tool call opens with a marker line — `← Editing path` (write/edit/create/move/delete), `→ Reading path` (read/list/file_info), `✱ Searching ...` (glob/grep), `$ Running command ...` (bash), `⚙ ...` (others). Tool output streams under a 2-space gutter (no box); `toolEnd` prints `✓ Nms` + a dim `divider()` + blank line to separate tool calls.
- **Boxed tool cards** (`ui.toolStyle: "box"`): legacy `┌─ ✓ write_file ─┐` cards with args summary, wrapped body, duration.
- Model commentary accompanying a tool call is shown by default (`ui.toolComments: true`), with a sanitizer that drops raw JSON payloads (`isToolCallJson` in `src/core/agent.ts`).
- Markdown v2: aligned tables (`│` borders), blockquotes, checkboxes, hr, italic, links.
- Diffs (`src/ui/diff.ts`) render the plain content with colored `+`/`-` markers only — no background color.

**Config:** `ui.spinner`, `ui.toolStyle` (`"inline"` default, `"box"` legacy), and `ui.toolComments` in `config/defaults.ts`. Tool `friendly` labels come from i18n `tool.friendly.*`. All user-facing strings still go through `t()` (rule #8) — this includes REPL header, `/help` groups, setup wizard, and tool cards.

## Plugins

> **Guide:** [docs/plugins.md](./docs/plugins.md) — hooks, загрузка, примеры.

Плагины перехватывают события агента. Интерфейс — `AgentPlugin` (`src/modules/types.ts`), диспетчер — `src/modules/plugins/manager.ts`. Изоляция ошибок: падение плагина не останавливает агента и других плагинов.

**Загрузка:** встроенные (`src/modules/plugins/builtin/`), глобальные `~/.mma/plugins/`, проектные `<project>/.mma/plugins/` (`.ts` — только под Bun). Два варианта размещения: **отдельный файл** `*.{ts,js}` в корне каталога плагинов, либо **папка-плагин** с entry-файлом (`plugin.ts/js` → `index.ts/js`; остальные файлы папки подключаются entry-файлом через относительные импорты — см. `src/modules/plugins/loader.ts`). Экспорт `default` или `plugin`. Папки без entry пропускаются.

**Хуки:**

| Хук                               | Момент                            | Особенность                                                   |
| --------------------------------- | --------------------------------- | ------------------------------------------------------------- |
| `onBuildPrompt`                   | сборка системного промпта (1 раз) | строка добавляется блоком `low`-приоритета                    |
| `onBeforeThink`                   | перед каждым LLM-вызовом          |                                                               |
| `onAfterThink(ctx, response)`     | после ответа LLM                  | `response` = `LLMResponse` или `null`                         |
| `onBeforeTool`                    | перед тулом                       | `false` = заблокировать (короткозамыкает)                     |
| `onAfterTool`                     | после тула                        | может мутировать `result.output`                              |
| `onToolCall`                      | LLM вернул тул-вызов              | `ctx.toolName`, `ctx.args`                                    |
| `onToolStart` / `onToolEnd`       | тул-карточка открыта/закрыта      | `onToolEnd` даёт `result` + `durationMs`                      |
| `onPhase`                         | спиннер: `thinking` / `done`      |                                                               |
| `onText` / `onMeta`               | чанк стриминга                    | вернуть строку — заменить на экране, `undefined` — пропустить |
| `onError`                         | ошибка LLM                        |                                                               |
| `onSessionStart` / `onSessionEnd` | жизненный цикл сессии             |                                                               |
| `onTurnEnd`                       | завершение `Agent.run()`          | один вызов на ход (ответ/ошибка/interrupt) + `TurnSummary`; сигнал «весь ход завершён» |
| `ctx.hostBridge`                  | любой хук                         | `HostBridge {isBusy, submit(text,{images}), interrupt}` — управление агентом из плагина через тот же путь, что терминальный ввод (регистрирует REPL); отсутствует в single-run |

**UI-хуки** (`onPhase`, `onToolStart`/`onToolEnd`, `onText`/`onMeta`) дают плагинам видимость и контроль над тем, что видит пользователь: спиннер, тул-карточки, стриминг. `onText`/`onMeta` влияют только на отображение, `result.text` не меняется.

### Versioning & dedup

- `AgentPlugin` supports optional `version` (semver) and `minMmaVersion` (minimum MMA version, semver).
- **Dedup by name** in `PluginManager.register(plugin, source?)`: the higher `version` wins (unversioned = "0.0.0"); the loser is dropped and the caller is notified via the `RegisterResult` (`registered` / `skipped_older` / `duplicate`). Applies across global + project dirs.
- **Compatibility gate** in `PluginLoader`: when `minMmaVersion` > current MMA version the plugin is skipped with a `plugin.incompatible` warning (reuses the existing `plugin.skipped` machinery). Bootstrap passes `mmaVersion` (from `readMmaVersion()` in `src/core/version.ts`) and `source` (`global` / `project`).
- **Source tracking**: `PluginInfo { plugin, source }` via `PluginManager.getPluginInfos()`. `getAllPlugins()` stays backward-compatible.
- **CLI:** `mma plugins list` (external plugins only; `--all` includes builtins) and `mma plugins list --all`; REPL `/status` shows version + `[source]` per non-builtin plugin.
- `lint-on-write` and `notify` are marked `isBuiltin = true`.

### Example plugin: `trace-server` (live browser trace)

> **Source:** `examples/plugins/trace-server/` — zero-dependency example of every UI hook, split into a **folder plugin**: `plugin.ts` (entry) + `state.ts` (process-global shared state + SSE primitives) + `util.ts` (clip/scrub/summarize) + `context.ts` (snapshots + history text) + `plans.ts` (on-disk plan reading + poll) + `server.ts` (HTTP/SSE, serves the three frontend assets verbatim) + `page.html` + `styles.css` + `app.js` (frontend). All assets are read from disk at load time and served as-is — never template-processed (inlining the page into a template literal broke `'\n'` in the JS and killed the page).

Starts a local HTTP server on `onSessionStart` and streams the whole agent loop to the browser over **SSE** (`node:http`, works under Bun and the Node dist — no `Bun.serve`/WebSocket dependency): phases, LLM calls, `tool_start`/`tool_end` with **full** args and results (paired client-side by `toolCallId`), errors, streamed text/meta (coalesced server-side, 350ms debounce), and **context tracking** — a live context bar (tokens/budget, quality %, compaction count, iterations since compaction, message count) fed by `context` events, plus `compaction` events rendered as CTX log entries (tokens before/after, quality before/after), a **side panel** with the full conversation history as text (`context_text` events, throttled + deduped) and the agent's **plans** (current, all, activity feed) read from `<project>/.mma/plans/` on disk. Live only — no session files are read. The frontend is split into three self-contained files (dark terminal, per-type color filters, search, pause/clear/auto-scroll, thinking indicator, elapsed timer, auto-reconnect): `page.html` (markup), `styles.css` (theme), `app.js` (SSE + rendering) — served from `/`, `/styles.css`, `/app.js` respectively.

The context events need the `contextManager` in the plugin hook contexts — `agent.ts` passes it to `runOnPhase`, `runOnSessionStart`, `runOnBeforeThink`, `runOnAfterThink`, `runOnToolStart`, `runOnToolEnd`, `runOnError`, `runOnText`, `runOnMeta`, `runOnSessionEnd`. Dedup: both the global and project copies of the plugin load in one process, so a shared server lives on `Symbol.for("mma.trace-server")` (`globalThis`), `startServer()` dedupes concurrent starts with an in-flight promise (`state.starting`), and identical context snapshots are broadcast once.

- Install: copy the whole `trace-server` folder to `~/.mma/plugins/` or `<project>/.mma/plugins/`; the URL is printed at session start ("live trace → …") and auto-opened.
- Config via env: `MMA_TRACE_PORT` (default random), `MMA_TRACE_HOST` (default `127.0.0.1`), `MMA_TRACE_MAX_CLIENTS` (5), `MMA_TRACE_OPEN=0` (no browser auto-open).
- Security: binds localhost only; payloads pass through a light scrub that masks credential-shaped values (`sk-…`, `Bearer …`, `api_key`/`token`/`password`/`secret` fields). Local-only, no auth.
- Smoke test: `_testing/trace-server-smoke.ts`; e2e harness in `_testing/trace-live/` (real agent run with the plugin in the sandbox's `.mma/plugins/`, watcher over SSE).

### Example plugin: `web-ui` (bidirectional chat in the browser)

> **Source:** `examples/plugins/web-ui/` — folder plugin, sibling of trace-server: `plugin.ts` (entry) + `state.ts` (global state + SSE broadcast) + `util.ts` (clip/scrub/validation) + `history.ts` (history.jsonl tail backfill) + `plans-snap.ts` (on-disk plan snapshot + 2s change poll) + `server.ts` (HTTP/SSE/REST) + assets `page.html` / `styles.css` / `app.js`.

Unlike trace-server (read-only), web-ui is **bidirectional**: the browser sends messages through `POST /api/message {text, images?}` → `ctx.hostBridge.submit()` → the same `Repl.runAgent` path as terminal input; `POST /api/interrupt` aborts the current turn. The page streams the whole loop over SSE (`/events`: session/state/phase/llm_start/llm_end/tool_start/tool_end/text/meta/error/plans/context/turn_end), renders collapsible tool cards and the plan checklist, backfills the last ~30 messages from `history.jsonl` on load (`GET /api/state`), supports image attach (drag-n-drop → client-side canvas downscale to 800px/JPEG60 → data URL → bridge → `addPendingImage`), and shows a busy-gated input with a Stop button.

- Agent reworks this plugin rides on: **`HostBridge`** (`{isBusy, submit(text,{images}), interrupt}` — registered by the REPL via `pluginManager.setHostBridge()`, merged into every hook ctx as `ctx.hostBridge`) and the **`onTurnEnd(ctx, TurnSummary)`** plugin hook (dispatched once per completed `Agent.run()`, single + MoE paths — the only reliable "turn finished" signal).
- Install/config: copy the folder to `~/.mma/plugins/`; env `MMA_WEBUI_PORT/HOST/TOKEN/MAX_CLIENTS/MIN_INTERVAL_MS/OPEN/CONFIG_DIR`. Token auth on `/api/*` is mandatory for non-loopback binds; POST bodies are size-capped (32KB text, ≤3 images × ~6MB data URLs), rate-limited, Origin-checked; payloads scrubbed like trace-server.
- Smoke test: `_testing/web-ui-smoke.ts` (stub bridge + fixtures for plan/history, asserts the full POST→submit→turn_end loop). Unit tests: `tests/web-ui-server.test.ts` (9 — routing, caps, busy, auth, rate limit), `tests/modules/plugin-host-bridge.test.ts` (7), `tests/core/agent-turn-end.test.ts` (3), `tests/cli/repl-bridge.test.ts` (4).

## Tool Set Narrowing (on-demand enable)

> **Status:** implemented (v0.40.0). The main agent loop exposes only a small default tool set instead of all ~28 — fewer schema tokens in every LLM call (~2100 vs ~3500).

- **Config `tools`** (`src/config/types.ts` `ToolsConfig`): `defaultTags` (default `["file","code"]`) + `enableOnDemand` (default `true`).
- **`alwaysOn` flag** on `ToolDefinition` (`src/tools/types.ts`) — tools that survive any tag filter; `getAllForLLM()`/`getByTags()`/`filterToolsByTags()` all keep them. Structural tools `plan`/`todo`/`verify`/`project_map`/`lsp_check` are `alwaysOn`, so plan enforcement and LSP checks survive narrowing.
- **`enable_tools` tool** (`src/tools/enable-tools.ts`, `alwaysOn`) — the model pushes tags (e.g. `["research"]`) into the shared mutable `activeToolTags` array; the agent loop recomputes the LLM tool set **every iteration** (`agent.ts`), so enabled tools appear next turn.
- **Hidden-tools prompt block** (`src/tools/hidden-tools-block.ts`, wired via `getDynamicPromptBlocks` in `bootstrap.ts`) — lists tag-grouped hidden tools so the model knows they exist and can call `enable_tools` or route via `subagent tool_tags`.
- **Default set (17):** file tools, bash (code), subagent, chunk_query, download_file, mcp_call, pipeline_run + alwaysOn (plan/todo/verify/project_map/lsp_check/enable_tools). **Hidden (11):** web_search/web_fetch/web_browse (research), browser, attach_image, process_list/process_log/process_kill, remember/recall, search_history.
- `enableOnDemand: false` restores legacy all-tools behavior (no `enable_tools` registered, empty tags → `getAllForLLM` returns everything).
- Subagent guard (`src/tools/subagent.ts`) uses `getByTags` for unknown-tag detection (alwaysOn tools otherwise masked it).

## Context Budget (dynamic, from model.contextWindow)

| contextWindow | System (10%) | Reserve (15%) | History (75%) |
| ------------- | ------------ | ------------- | ------------- |
| 32K           | 3K           | 5K            | 24K           |
| 64K           | 6K           | 10K           | 48K           |
| 128K          | 13K          | 19K           | 96K           |

Compaction triggers at 75% history budget or every 15 iterations. Keeps last 6 turns full; older turns → structured summary preserving created/updated files, plan state, key decisions, and errors. The summary is saved once to the session log — no duplication of old messages. Token counting uses `js-tiktoken` via injected `TokenCounter` when available, falling back to `content.length / 2` heuristic for backwards compatibility.

## Cost Tracking (pricing / budget display)

> **Source:** `src/modules/pricing/` (`prices.ts` — builtin price table + cost math; `index.ts` — `CostTracker`).

When a model has a known price, MMA shows the session's running cost **together with token usage**:

- **Inline tool footer** — each `toolEnd` appends `cost $X` next to `ctx ±N` (rich + plain modes).
- **After calls** — REPL context bar (`repl.cost`) and the single-run result (`run-result.ts` / `--json` `totalCost`).
- `AgentResult.totalCost` is set when pricing is enabled and the model's price is known; `ToolEvent.costUsd` carries the running total at each tool end.

**How prices resolve** (`resolvePrice`): user `pricing.overrides` win → builtin table (`ZEN_PRICES`) → unknown = no cost shown. Model ids are normalized by stripping provider prefixes (`opencode/`, `opencode-go/`, `openai/`, `anthropic/`) and vendor paths, so one table serves Zen and Go.

**Config** (`~/.mma/config.json`):
```json
{ "pricing": { "enabled": true, "overrides": { "opencode/gpt-5.5": { "input": 1, "output": 2 } } } }
```

**Hosted providers** with fixed base URLs are selectable via `mma provider use opencode-zen|opencode-go` and the setup wizard (`HOSTED_BASE_URLS` in `src/cli/setup.ts`): Zen → `https://opencode.ai/zen/v1`, Go → `https://opencode.ai/zen/go/v1`. Both are OpenAI-compatible (`/chat/completions`); model ids use the `opencode/…` / `opencode-go/…` prefix. Builtin pricing is maintained from https://opencode.ai/docs/zen/ and /docs/go/ — update `ZEN_PRICES` when those tables change.

## Process Management

Long-running commands (dev servers, watchers) no longer block the agent.

### Bash behavior

- The `bash` tool uses **async spawn** (non-blocking event loop); the old `execSync` blocking behavior is gone.
- Any command still running after the grace window (5s, `BASH_GRACE_MS` in `src/tools/bash.ts`) is **auto-promoted to the background** — it returns a process id and partial output instead of hanging. Detection is behavioral (process still alive), never text matching, so a command mentioning "vite"/"dev" runs normally while a genuinely long-running command is always caught.
- Force background immediately with `background: true` (short settle window to surface spawn failures), force foreground with `background: false`.
- A command that fails to spawn (bad `workdir`, missing shell) returns `[process error] ...` with `success: false` instead of a fake "Started" line.
- Foreground commands are killed on the executor timeout (60s) via kill-by-call-id (`registerKillable` in `src/modules/processes/runner.ts`).

### Management tools

| Tool           | Purpose                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `process_list` | List background processes: id, PID, command, status, last output line                                               |
| `process_log`  | Show buffered output of a background process (`id`, optional `tail`)                                                |
| `process_kill` | Kill a background process tree (`id`) — works even though `kill`/`pkill` are blocked by the bash security blacklist |

- PIDs are tracked in `src/modules/processes/registry.ts` (per-session, capped at 20 entries, 2000 log lines each). Windows output is decoded from the OEM code page (CP866) so Cyrillic is not garbled. Output buffers are capped.
- Windows: processes are killed with `taskkill /pid <pid> /T /F`; POSIX: process-group kill (`detached` spawn).
- `Agent.shutdown()` kills all remaining background processes (no orphans).

## Auto-Update

Self-update is a fire-and-forget background check — it never blocks startup.

- **Check:** `Updater.check()` fetches `https://registry.npmjs.org/micro-models-agent` (5s timeout); the current version comes from `package.json` (`readVersion()` in `main.ts`).
- **Install:** when a newer version exists and `autoInstall: true`, runs `npm install -g micro-models-agent@<latest>` in the background (`Updater.install()`, injectable runner for tests). The running process keeps working on the old version; the update applies on next launch.
- **Config** (`updater` in `~/.mma/config.json`):
  - `enabled` (default `true`) — master switch
  - `checkOnStart` (default `true`) — check at startup
  - `autoInstall` (default `true`) — auto-run `npm install -g`; `false` → only notify
  - `intervalMs` (default `0`) — `0` = single check per launch; `>0` = permanent background re-check loop
- **Source:** `src/modules/updater/` (`checker.ts`, `module.ts`). Fired from `main.ts` via `startAutoUpdate()`; all errors are swallowed (best-effort). Notifications go through i18n keys `updater.*`.

## Execution Guarantees

### Plan Enforcement

- `autoPlan: true` adds a strong system prompt directive to create a plan for any multi-step task
- The plan is always visible in the system prompt as a checklist `[x]` / `[ ]`
- The execution module warns the model when a tool call targets files outside the current step
- After `write_file` / `edit_file`, the execution module auto-advances the plan if all files mentioned in the current step exist

### Plan Management (Multi-Plan)

Plans are stored in `<project>/.mma/plans/` with automatic history management:

```
.mma/plans/
├── active.json          # current active plan
├── drafts/              # preserved incomplete plans
│   └── <plan-id>.json
└── archive/             # completed or aborted plans
    └── <plan-id>.json
```

**Source:** `src/modules/execution/plan-store.ts` (`PlanStore`)

**Plan tool actions:**

| Action    | Description                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------- |
| `create`  | Start a new plan. Previous active plan is auto-preserved: incomplete → draft, complete → archive. |
| `update`  | Mark step status (done/failed/skipped).                                                           |
| `show`    | Print current plan checklist.                                                                     |
| `abort`   | Archive current plan and clear active slot.                                                       |
| `list`    | Show all plans (active, drafts, archived) with progress.                                          |
| `switch`  | Make a different plan active by plan id.                                                          |
| `re-plan` | Iterative replanning: keep completed steps, replace remaining with new steps.                     |

**Key behaviors:**

- Creating a new plan never destroys an existing active plan — it's automatically preserved as draft or archive
- `re-plan` keeps all done/skipped steps and appends new pending steps with sequential ids
- Legacy `.mma/plan.json` is automatically migrated to `.mma/plans/active.json` on first load
- The `Plan` interface supports optional `name` field for named plans

### Stuck Detection

- `stuckThreshold` (default 6) — too many iterations on the same step injects a recovery message
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

## RLM-Inspired Features (pass-by-reference + chunked queries)

> **Spec:** `docs/specs/2026-08-12-rlm-inspired-design.md` — ports Recursive Language Models (arXiv:2512.24601) mechanics: sub-agent results by reference, and programmatic chunked processing of oversized inputs.

**Status:** implemented (all 9 tasks).

### Pass-by-reference sub-agent results

- `ArtifactStore` (`src/modules/artifacts/store.ts`): persists sub-agent results to `.mma/artifacts/<session>/`. `sanitizeName()` neutralizes traversal (`../../etc/passwd` → `etc_passwd`), `read()` returns `null` outside the root, `summary()` truncates with a marker.
- `subagent` tool accepts `result_mode: "file"` (+ `artifact_name`): the child's full answer is saved to an artifact and the parent receives a bounded path + summary instead of raw text — kills context-rot/transmission errors for a 9B model.
- Config: `subagent.resultMode` (`"text"` default, backward compatible), `maxSummaryChars`, `artifactsDir`, `stableSystemPrompt`, `maxParallelChunkQueries` (`src/config/types.ts` `SubagentConfig`).
- MoE executor (`moe-executor.ts`): when `resultMode: "file"`, subtask args get `result_mode`/`artifact_name = subtask.id`, and the Router's `SubtaskResult.result` carries the full artifact content (bounded summary only in the parent's context).
- Stable system prompt: `SUBAGENT_SYSTEM_PROMPT_TEMPLATE` (`src/tools/subagent.ts`) is byte-identical across calls (KV-cache friendly); variable context goes into the user message, not the system prompt. Few-shot workflow block (write large outputs to files, verify, delegate) is included.

### Chunked parallel queries (`chunk_query`)

- `runChunkQuery()` + `splitTextIntoChunks()` (`src/modules/context/chunk-query.ts`): RLM-style `llm_query` semantics — plain LLM calls (no tool loop) per newline-aware chunk with a bounded-concurrency pool and an optional synthesis pass.
- `chunk_query` tool (`src/tools/chunk-query.ts`): scope-checked `input_path` or inline `text`, params `chunk_chars`, `max_parallel`, `synthesize`, `max_chunk_tokens` (default 1024 — must fit reasoning + answer), `max_synthesis_tokens` (2048).
- `timeoutMs` on `ToolDefinition` overrides the 60s executor timeout per tool (chunk_query uses 300s — multiple LLM calls on slow providers).
- `LLMProvider.chat(messages, tools?, signal?, options?)` gained `ChatOptions.maxTokens` to cap generation per call.

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

### When to bump which part

| Version Part      | When to Bump                                                                                                                    | Examples                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **MAJOR** (X.0.0) | Breaking changes: API changes, config schema changes, removed commands/tools, architecture rewrites                             | v1.0.0 → v2.0.0 (MMA v1→v2 rewrite), config version field change                       |
| **MINOR** (0.Y.0) | New features, new commands, new tools, new modules, new REPL commands, new CLI subcommands                                      | Add `/reload`, `mma model list`, new security policy, new skill, new plugin hook       |
| **PATCH** (0.0.Z) | Bug fixes, typo fixes, i18n additions, doc updates, performance improvements, test additions, dependency updates (non-breaking) | Fix crash in `bash` tool, add ru translation, update README, fix typo in error message |

### Release Process

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

3. **Build**: `bun run build:prod`
4. **Publish**: `npm publish --access public`
5. **Git tag**: `npm version` creates tag automatically, push with `git push --follow-tags`
6. **Update CHANGELOG** (if exists) or AGENTS.md with notable changes

### Commands that require MINOR bump

- New CLI subcommand (`mma <new-cmd>`)
- New REPL slash command (`/new-cmd`)
- New tool in `tools/`
- New module in `modules/`
- New provider capability (e.g., `listModels()` in LLMProvider)
- New config option that changes behavior
- New security policy/feature

### Commands that require PATCH bump

- Bug fixes in existing commands/tools
- i18n string additions/fixes
- Documentation updates
- Test additions
- Performance optimizations
- Dependency updates (non-breaking)

### Commands that require MAJOR bump

- Removing/renaming CLI commands
- Changing config schema (breaking)
- Removing tools/modules
- Changing Agent loop state machine
- Changing LLMProvider interface (breaking)
- Architecture rewrites

### Current Version: 0.53.0

- **70** = global certification manifest shipped with package updates (user report: «что-то я не вижу чтобы сертифицированные модели как-то отображались в списках» — marks only showed when running from the repo root because the manifest lived in `<cwd>/certification/`): (1) **Global manifest** — certifications are now stored in `~/.mma/certifications.json`, keyed by `(model, providerUrl)`; `certify` writes there, `getCertMark`/`certStatus`/`certList` read a MERGED view (`readMergedManifest`) of global + legacy per-project manifests (project wins on the same key), `uncertify` cleans both stores. Marks are visible from any working directory. (2) **Bundled manifest + startup sync** — `certification/certifications.json` is copied to `dist/certification/` by `copy-assets.ts` and ships with the npm package; `syncGlobalManifest()` runs at every bootstrap: bundled entries overwrite their keys on package update, user-local certifications for other keys are preserved, and a snapshot file (`~/.mma/certifications.synced.json`) prevents rewrites between updates. Tests: rewritten `tests/cert-manifest.test.ts` (12 — global upsert/remove, merged getCertMark, sync idempotence + update-overwrite). Version: **0.53.0** (MINOR — new storage semantics + bundled-manifest sync).
- **69** = qwen3.5-9b certified 20/20 + certification reliability fixes: (1) **`PROVIDER_BASE`** (`src/modules/certification/scenarios.ts`) — every cert scenario now overrides `provider.maxCompletionTokens` (16384): reasoning-heavy local models truncate tool_call arguments at the default 4096 cap and die in recoverable-error retries; scenario 3.5 prompt disambiguated («output.json AT THE PROJECT ROOT» — the model wrote it next to data/input.json in half of reps). (2) **Certification label text** — `mma model list` and REPL `/model` print `supported — certified on this provider` (green) / stale-version warning (yellow) next to ✔/○ glyphs (i18n `cli.cert_label`/`cli.cert_stale_label`, en+ru). (3) **Observations journal** — new `docs/small-model-observations.md` (mandated by a new AGENTS.md section): symptom/where/harness-response/status records for small-model quirks (bash-instead-of-write_file, empty-response loops, completion truncation, all-tokens gate). Root causes found during certification: LM Studio loaded the model with 8K context while MMA assumed 32K — silent server-side clamping of max_tokens was killing multi-step scenarios regardless of harness fixes. Version: **0.52.0** (MINOR — new config option `provider.maxCompletionTokens` + new CLI output).
- **68** = plan auto-advance after fs-mutating non-file tools (certification 3.5 stuck at 1/4, 3.8 at 4/5 with all deliverables on disk): small models create files via bash (`echo > f`, heredocs) instead of write_file, so auto-advance never fired and plans stalled until retry exhaustion. **`FS_MUTATING_TOOLS`** (`src/modules/execution/execution-plugin.ts`) — advancePlanIfStepComplete now fires after every successful call to write/edit/delete/move/create_dir/bash/download/subagent/mcp/pipeline/browser tools. Read-only tools deliberately excluded: a successful read/glob must never complete an «Update X» step whose target already exists from an earlier step. Bonus: delete_file success now auto-completes delete-kind steps (kind auto-switch → deliverable gone → done → archive). **`maxCompletionTokens` plumbing** — the key existed in error messages but was never read from config: now `provider.entries[].maxCompletionTokens` / legacy flat `provider.maxCompletionTokens` flow through ProviderManager → presets → OpenAICompatProvider + agent.reconfigure(). Tests: bash-success advances, failed-bash does not, read-only-never-advances (3 in execution-plan-deliverables), updated delete-kind test. Version: **0.52.0** (MINOR).

- **67** = web-ui plugin + agent input bridge (user request: «нужен план по созданию плагина для веб интерфейса агента»; plan `docs/superpowers/plans/2026-08-23-web-ui-plugin.md`): (1) **`HostBridge`** (`src/modules/types.ts`) — narrow `{isBusy, submit(text,{images}), interrupt}` interface; REPL registers it via new `PluginManager.setHostBridge()` and the manager merges it into every hook ctx as `ctx.hostBridge` (caller-provided value wins; absent in single-run). (2) **`onTurnEnd(ctx, TurnSummary)`** plugin hook (`src/core/agent.ts`) — dispatched exactly once per completed `Agent.run()` (single + MoE paths), success/error/interrupt; tool calls counted via an `onTool` wrapper without touching the loop internals. (3) **REPL bridge wiring** (`src/cli/repl.ts` `createHostBridge()` factory): submit → `addPendingImage` per image data URL (same path as Ctrl+V) then the SAME `runAgent(text)` as terminal typing — rendering/session/logging/single-flight shared, never duplicated; interrupt → `agent.shutdown()`. (4) **`examples/plugins/web-ui/`** folder plugin: SSE stream of the whole loop (`session/state/phase/llm_start/llm_end/tool_start/tool_end/text/meta/error/plans/context/turn_end`), `GET /api/state` snapshot (session meta + active plan from `.mma/plans/active.json` + last 30 messages from `history.jsonl`, system lines skipped), `POST /api/message {text, images?}` → hostBridge (202 | 409 busy | 413 caps | 429 rate limit | 401 token | 403 cross-origin | 503 no bridge), `POST /api/interrupt`; frontend (vanilla JS) renders collapsible tool cards, plan checklist, busy-gated composer with Stop button and drag-n-drop images downscaled client-side to 800px/JPEG60 via canvas before upload. Security: loopback bind by default, non-loopback refused without `MMA_WEBUI_TOKEN`; body caps (32KB text, ≤3×6MB images); 500ms POST rate limit; Origin check on writes; secret scrubbing ported from trace-server. Tests: `tests/web-ui-server.test.ts` (9 — routing/caps/busy/auth/rate-limit/history-tail/SSE cap), `tests/modules/plugin-host-bridge.test.ts` (7), `tests/core/agent-turn-end.test.ts` (3), `tests/cli/repl-bridge.test.ts` (4); smoke `_testing/web-ui-smoke.ts` (16 checks — full POST→submit→turn_end loop over real HTTP). Docs: `docs/plugins.md` gained Host Bridge + onTurnEnd sections and the web-ui example. Version: **0.51.0** (MINOR — новый plugin hook + HostBridge API + новый плагин).

- **66** = REPL line editor scroll-proof rendering (user report: pasting/typing long multi-line input produced the `You: <text>` frame duplicated many times on screen). Root cause: `render()` (`src/ui/line-editor.ts`) returned the cursor to the frame's top with a RELATIVE move (`\x1b[{prevCursorRow}A`). When a tall frame (long paste wrapping across rows) scrolled the terminal mid-render, the frame shifted up on screen but the relative count did not — the next redraw started BELOW the true frame top, leaving every previous line stale; each subsequent paste added another copy. New approach — **absolute anchoring via a single DSR query + deterministic scroll math**: one `ESC[6n` (cursor position report) is sent the first time the editor renders after a prompt; the reply sets `frameTopAbs` (absolute screen row of the frame's first visual row). All subsequent renders update the anchor locally via scroll math (`output.rows`, `visibleLayout()`) — no further queries, no ConPTY desync. When the frame extends past the screen bottom the terminal scrolls, and the new anchor is computed as `H - L + 1`. Frames taller than the screen are capped to `rows - 2` visual rows (`visibleLayout()`). Fallback to relative moves until the initial reply arrives. Anchor is invalidated on `reset()`/`question()`/`clearScreen()`/submit (triggers a fresh query on next prompt). **Note:** DSR query is currently disabled (`line-editor.ts`) — ConPTY on Windows may buffer stdout while processing the DSR reply, hiding agent responses. Deterministic scroll math infrastructure is preserved for future use. Tests: single DSR query per prompt, deterministic scroll tracking, visible-row cap, anchor reset (5 new in `tests/ui/line-editor.test.ts`); byte-exact interactive expectations updated. Verified: `tsc --noEmit` clean, ui+cli+core suites green. Version: **0.50.3** (PATCH — bugfix).

- **65** = LLM stream reliability + recovery fixes (post-mortem from `ses_mt4sxnuv`/`ses_mt4x3zbo` — a qwen3.5-9b session via LM Studio where the model wrote a large file and MMA aborted the stream at exactly 60s, then burned 3× hallucination retries on silently truncated responses, then flailed ~12 iterations of failing bash commands): (1) **idle stream timeout 60s → 180s** (`retry.noDataTimeoutMs`, `src/config/defaults.ts` + fallback in `openai-compat.ts`) — LM Studio buffers SSE for tool-call arguments and flushes them in one final packet after the whole generation (~60s+ of zero-byte silence at 54 t/s); the old default aborted mid-generation (`Client disconnected. Stopping generation`). No migration needed — optional config field merged from defaults. (2) **stall diagnosis** — new `sawToolCallStart` flag in `streamOnce`: a stall AFTER tool_call accumulation picks a dedicated message (`error.llm_stream_idle_toolcall`, en+ru) naming the likely cause (provider buffers SSE instead of streaming argument deltas) and the exact remedy (`retry.noDataTimeoutMs` in `~/.mma/config.json`, restart required); both idle messages now carry the fix. (3) **truncation no longer masquerades as an empty response** — `streamOnce` tracks `lastFinishReason`; on `finish_reason: "length"` with an unfinished tool_call (or zero delivered content) it throws a terminal error (`error.llm_truncated` / `error.llm_truncated_toolcall`, en+ru) instead of yielding nothing → chat()'s non-streaming fallback → hallucination retry loop ("Response too short or empty" ×3 = 9 minutes wasted). The completion limit was hit because a >12000-char story in ONE `write_file` exceeds 4096 completion tokens. (4) **recoverable LLM errors** — truncation errors carry `recoverableLlm`; the agent loop feeds them back into context as `<system-summary>` (up to `MAX_LLM_ERROR_RETRIES=2`, `src/core/agent.ts`) instead of going ERROR→session death; the model adapts by splitting writes into chunks. (5) **bash flailing detector** — the per-word hard-stop (bash.ts) counts CONSECUTIVE failures per first word, so command rotation evaded it; new windowed check in `StuckDetector`: ≥4 failed bash attempts within the last 6 (interleaved successes don't reset it — `recordBashAttempt()` fed from `execution-plugin.ts`) → primary reason `bash-flailing` with recovery message (`exec.bash_flailing_recovery`, en+ru): stop shell file ops, use read_file/write_file/file_info. Tests: 2 truncation cases in `tests/openai-compat.test.ts` (terminal throw, no blind retries), recoverable-feedback + retries-exhausted in `tests/core/agent.test.ts`, 5-case flailing block in `tests/execution-stuck-detector.test.ts`. Verified live on qwen3.5-9b/LM Studio: previously fatal scenarios now complete end-to-end (story.md written, valid UTF-8, clean tool chain incl. voluntary lsp_check); full suite 1568 pass / 0 fail. Version: **0.50.2** (PATCH).

- **64** = session post-mortem fixes from `ses_mt4fn58c_ag458g` (a "bike landing on Vite+React+Tailwind" task where the model burned ~97 iterations / 7 compactions in 13 minutes; branch `fix/session-postmortem-0.50`): (1) **security no longer silently overrides an explicit user opt-out** — removed `normalizeStaleSecurityConfig()` (`src/config/config.ts`), which force-replaced a stored `security.enabled: false` section matching the pre-0.48 default signature with the new enabled-by-default defaults; the user's explicit choice is now honored verbatim, fresh installs still get the enabled defaults through merging. Also dropped `bun` from the bash blacklist (the system prompt tells the model to run TypeScript with `bun <file.ts>` — banning it contradicted that and burned ~6 iterations on blocked `bun run build`; interpreter escape hatch `-e/-c` stays closed via INTERPRETER_FLAGS) and dropped `-y`/`--yes` from `dangerousFlags` (routine harmless npm/apt flags; blocking them broke project scaffolding). Tests: rewritten stale-security block in `tests/config.test.ts`, new default-config case in `tests/security/command-validator.test.ts`. (2) **lint-on-write skips a missing lint binary** — a declared-but-uninstalled linter (`"eslint" не является внутренней...`) was appended to EVERY write result ~25×/session, polluting context and making the model think writes failed; detected once per `(baseDir, script)` via shell-output signatures + exit 127/ENOENT, then skipped silently. (3) **stuck-warning anti-spam** — `recordToolSuccess()` now decays per-tool error counters (a bash failing 3× early kept re-logging "Tool bash failed N times" after ~30 successful writes forever) and stuck-warnings dedup via new `StuckDetector.getWarningKey()`: the SAME key re-logs only every `STUCK_WARN_REPEAT_EVERY=5` iterations, a new key logs immediately. (4) **plan progress unified** — new `getPlanProgress()` in `planner.ts` counts done+skipped as settled everywhere: `plan show` said "6/7 done, complete" while `plan list` said "7/7" for the same plan (6 done + 1 skipped). (5) **bulk `steps[]` rewrite guarded** — `action=update` with `steps[]` on a PROGRESSED plan is rejected with guidance (`plan.bulk_update_rejected`, en+ru; it silently discarded all statuses when the model sent its step list with ✅-emoji expecting progress marks); not-yet-started plans stay rebuildable (preserves the kinds-rebuild use case). (6) **archived plans answer read-only** — `update` with an id pointing at a draft/archived plan returns `plan.readonly` instead of a bare "No active plan" loop anchor (10+ wasted iterations). (7) **process tools usage hints** — `process_kill`/`process_log` without an id return `proc.missing_id` + current registry ids instead of "Process not found: undefined"; bare `process_list|process_log|process_kill` through bash return `exec.hidden_tool_hint` (call `enable_tools ["shell"]`) instead of cmd.exe's "is not recognized". Released as **0.50.1**.

- **63** = provider health probe + code-only capability routing (provider module Phase 4, item 4): (1) **`probeProviders()`** (`src/modules/providers/health.ts`) — concurrent ✓/✗ probes per entry using the FREE `listModels()` call (never a billed chat completion), timeout-bounded, input order preserved; `targetsFromProviders()` builds targets from name→provider pairs. (2) **CLI `mma provider check [--timeout <ms>]`** — table of `✓/✗ name ms models|error`. (3) **REPL banner background probe** — with >1 entries, failed non-active providers surface as `[WARN] Provider "X" is unreachable` warnings after startup (failover would otherwise silently mask a dead primary); i18n `repl.provider_down`, `cli.provider_check` (en+ru). (4) **`ProviderManager.pickFor({vision, tools, minContext})`** — CODE-ONLY capability routing: first priority-ordered entry whose preset capabilities + context window satisfy the need; no constraints → active provider; explicitly never exposed to the LLM (the budget-risky LLM-driven `provider` tool was dropped from the spec). New `Agent.getProviderFor(name)`. Tests: new `tests/providers-health.test.ts` (5), `tests/providers.test.ts` +2 pickFor cases.

- **62** = per-entry provider isolation + priority fallback order (provider module Phase 4, item 3): (1) **Priority ordering** — `ProviderManager.list()` now sorts entries by `priority` ascending (undefined last, stable by config order), so fallback (`FallbackProvider` wraps `listNames()`) tries cheaper/preferred providers first. (2) **CLI flags on `mma provider add`** — `--priority <n>`, `--context-window <n>`, `--rpm <n>` / `--parallel <n>` (→ per-entry `rateLimits`); `mma provider list` shows `prio=N` for prioritized entries. Per-entry `apiKey`/`retry`/`rateLimits`/`contextWindow` were already honored in `ProviderManager.build()` (entry value ?? global option) — now covered by tests. Tests: `tests/providers.test.ts` +3 (capturing registry asserts per-entry opts reach the factory; priority ordering; toConfig preserves entry fields).

- **61** = provider failover + per-provider cost attribution (provider module Phase 4, items 1-2): (1) **CostTracker per-provider attribution** (`src/modules/pricing/index.ts`) — `record(promptTokens, completionTokens, provider?)` keys totals by provider (no provider -> `"unknown"`); new `totalFor(provider)` and `breakdown()` (priced providers only, cost desc). Agent passes `callerProvenance().provider`; `AgentResult.costBreakdown` surfaces it in single-run output (i18n `repl.cost_breakdown` en+ru when >1 provider used) and in `--json`. (2) **Transparent provider failover** (`src/modules/providers/fallback.ts`) — `FallbackProvider` wraps the `ProviderManager` source; on 429/5xx/network errors (`isFailoverError`: `llmStatus` attached by openai-compat's `fetchWithRetry`, or network-shaped messages) BEFORE any chunk was emitted it switches to the next configured entry (wrapping) and retries there; sticky — the successful provider becomes active; mid-stream failures rethrow (no duplicated chunks); AbortError never fails over. Enabled in bootstrap when `provider.fallback: true` AND entries > 1; failovers logged via `logger.warn`. Tests: `tests/pricing.test.ts` (+5), new `tests/providers-fallback.test.ts` (9).

- **60** = plan-state ownership refactor (user request: «при исправлении не используй костыли — пересмотри систему с учетом всех последних изменений»; supersedes the three accumulated hacks **57/58 + planTouched**): the REPL was a SECOND reader of plan state — it polled `.mma/plans/active.json` from disk (`readActivePlan`) and guessed changes via JSON signature diffing, while `PlanStore` (inside `ExecutionModule`) is the actual owner; plus plan state had no session binding, so a leftover plan from a previous session leaked into new chats (unprompted checklist print) and anchored every tool header with «← шаг N» step context. Redesign: (1) `ExecutionModule.getActivePlan()` is the single source of truth for UI consumers; (2) `BootstrapResult.execModule` threads the module to `Repl` (new optional ctor arg) via `main.ts`; (3) REPL no longer reads disk at all — `renderPlan()` prints the checklist ONLY on `plan`/`todo` tool-end events (change events, not polling); (4) stale-plan leaks die structurally: bootstrap restores a plan only when resuming a session with history (`messageCount > 0`), so in a fresh session `getActivePlan()` is null → nothing printed, no step-context anchoring; removed `lastPlanSig`, silent-first-refresh and `planTouched`. Verified on real model runs (`_testing/plan-refactor/case1` — stale plan on disk stays invisible; `case2` — live checklist 0/2→2/2, auto-advance, archive). Tests: fresh-session regression in `tests/core/bootstrap.test.ts`, new `tests/cli/repl-plan.test.ts` (3). Version: **0.49.0** (MINOR — BootstrapResult contract change).

- **59** = hallucination dotfile false-positive fix (user report: «пишет что нет файла а он есть» — `[WARN] Упомянутые файлы не найдены: prettierrc.json` while `.prettierrc.json` exists): the file-token regex `\b[\w./\\-]+\.[a-z]+\b` cannot anchor a leading dot (no word boundary before `.`), so `.prettierrc.json` is extracted as `prettierrc.json` and the factual check found no such file. Fix: `FactualCheck.pathExists`/`bareNameExists` (`src/modules/hallucination/factual.ts`) now try the dot-prefixed basename variant (`prettierrc.json` → `.prettierrc.json`, `src/config.json` → `src/.config.json`) across disk, name index, and compaction known-files before declaring a path missing. Test: dotfile case in `tests/hallucination-factual.test.ts`. Version: **0.48.3** (PATCH — bugfix).

- **58** = REPL stale-plan print fix (user report: «при открытии чата если есть план, он сразу загружается и попадает в чат сам по себе»): `Repl.refreshActivePlan` (`src/cli/repl.ts`) printed the on-disk plan checklist on the FIRST agent run of a session because `lastPlanSig` started as `""` and any existing plan's signature differed — a plan left over from a previous session was dumped into the chat unprompted. Fix: `lastPlanSig` is now nullable; the first refresh only records the signature (no print), so the checklist appears only after the plan actually changes during the session. Version: **0.48.2** (PATCH — bugfix).

- **57** = session startup diagnostics logging — environment, LSP probe, baseline typecheck now written to `session.jsonl` for full post-mortem visibility (user request: "при старте пустой сессии нужно писать лог для LSP и подобных механизмов"): (1) **`logSessionStart()`** in `SessionLogger` — writes `{type: "session_start"}` as the FIRST entry in `session.jsonl` with environment report (OS/runtime/provider/tools), LSP probe results (ok/failed/noneApplicable), plugins, skills; dedup check prevents double-logging when both REPL and agent call it. (2) **`logBaselineTypecheck()`** — logs async typecheck result `{type: "baseline_typecheck"}` with passed/message. (3) **`envReport` threaded** from `bootstrap()` → `BootstrapResult` → `AgentDeps` → `agent.run()` → `slog.logSessionStart({environment})`. (4) **REPL logs LSP probe** — `probeLspBanner()` calls `slog.logSessionStart({environment, lspProbe})` after `probeLspServers()` returns. (5) **`SessionLogEntry`** extended with `session_start` + `baseline_typecheck` types + new optional fields (`environment`, `lspProbe`, `plugins`, `skills`, `passed`, `message`). Flow: one-shot → agent.ts logs session_start; interactive → REPL logs session_start (with LSP probe), agent.ts skips (dedup via file check). New session.jsonl entries enable diagnosing dead LSP servers, wrong provider config, missing tools, and typecheck issues from session files alone without cross-referencing global logs. Version: **0.47.0** (MINOR — new session log types + observability).

- **56** = environment requirements check + global crash reporting (from the reliability/logging audit — "check OS/system/node/bun requirements so problems are diagnosable from logs on another device"): (1) **`src/core/environment.ts`** — `collectEnvironment()` builds a full `EnvironmentReport` at every startup: OS (platform/arch/release/hostname/shell/home/cwd), runtime (`bun` vs `node` + versions), `engines.node` from package.json (resolved from disk, rule #12) checked against the **Node** version — Bun satisfies it via its embedded `process.version`, never the Bun version itself (fixed a false "below engines" warning), PATH tool probe (`bun`/`node`/`git`/`python` via `spawnSync --version`, 3s timeout, `windowsHide`, `scanTools: false` skips spawns under `NODE_ENV=test`), provider (model, sanitized baseUrl via `sanitizeUrl`, contextWindow, full retry config), **Playwright** (package resolvable via `createRequire` + browser binaries in `PLAYWRIGHT_BROWSERS_PATH` or default per-OS dir; warning only when `browser.enabled`). (2) **Startup logging** — `logEnvironment()` writes a compact `[INFO] Environment: win32 x64 | bun 1.3.14 (node v24.3.0) | mma 0.46.1 | <model>` line + a full structured record via new `Logger.logStructured(type, data)` (app.jsonl only, no console), and any `warnings` (node runtime, engines below requirement, missing tools, missing playwright/browsers) surface as `[WARN]` at startup. (3) **`src/core/crash-handler.ts`** — `installCrashHandlers()` (idempotent, called first thing in `main()`): `uncaughtException` → sanitized `CrashEntry` (type/message/stack + captured environment) appended to `~/.mma/logs/crash.jsonl` + `env.crash_stderr` line, then `process.exit(1)`; `unhandledRejection` → logged only. (4) i18n (en+ru): `env.runtime_node`, `env.runtime_old`, `env.tool_missing`, `env.playwright_missing`, `env.playwright_browsers_missing`, `env.crash_stderr`. Tests: `tests/environment.test.ts` (8 — satisfiesMinimum, runtime detect, report collect, baseUrl sanitize, node/low-version warnings, playwright browser-enabled gating, browsers-dir env override), `tests/crash-handler.test.ts` (5 — Error/non-Error formatting, secret redaction, crash.jsonl append, nested-dir writes). Verified: `tsc --noEmit` clean; environment+crash-handler 13, bootstrap+agent 40, i18n+logger 10 green. Note: running `tests/core` together with `tests/config.test.ts`/`tests/bootstrap.test.ts` in one worker flakes 7 `agent*` tests on the ru locale (pre-existing shared-worker cross-talk, reproduces on a clean tree — `agent.test.ts` alone is 38/0). Version: **0.46.1** (feature logged, pending version bump on release).

- **55** = LLM connection-break hardening (`src/llm/openai-compat.ts`): (1) **stream-level retry** — `doStream` now wraps a single fetch+read in a retry loop (`streamOnce`, extracted): if the response stream breaks (network error during body read, no-data idle timeout, or closes before `[DONE]`) BEFORE any chunk was emitted, the whole request is retried with exponential backoff (cap `maxDelay`, jitter), up to `retry.maxStreamRetries` (default 2). Content already delivered → no retry (a re-stream would duplicate chunks). `AbortError` (interrupt) → never retried. (2) **no-data timeout** — `readIdle()` arms a per-`read()` timer (`retry.noDataTimeoutMs`, default 60000) so a silent server no longer burns the full 120s; the timer is only armed while awaiting the socket, so consumer-side processing between chunks can't false-positive. (3) **`[DONE]` tracking** — a stream that ends before `[DONE]` with zero content is now a retryable truncation instead of a silent empty success (the `!hasToolCall && !hasText` non-streaming fallback in `chat()` remains as the last resort). (4) **non-streaming timeout** — `doNonStreaming` previously had NO timeout and could hang forever on a stalled fallback; it now shares `REQUEST_TIMEOUT_MS` (120s) and surfaces `error.llm_timeout`. (5) **no double-retry** — fetch-level failures and non-OK responses are tagged `llmTerminal` (already HTTP-retried inside `fetchWithRetry`), so the stream loop doesn't multiply them. New config fields: `retry.{maxStreamRetries,noDataTimeoutMs}` (`src/config/types.ts` + `defaults.ts`). New i18n (en+ru): `error.llm_stream_idle`, `error.llm_timeout`. Tests: 5 new cases in `tests/openai-compat.test.ts` (break-before-content retried, break-after-content NOT retried, idle timeout retried, close-before-[DONE] retried, caller-abort not retried). Verified: `bun test` green (openai-compat 19, config 16, i18n 5, agent-hallucination/orchestrator/bootstrap-model-loader 10), `bunx tsc --noEmit` clean, `build:prod` ok. Version: **0.46.1** (PATCH — bugfix + 2 new config options, no new commands/tools).

### Provider module branch (merged)

- **P2+3** = provider module Phases 2+3 (spec `docs/specs/2026-08-20-provider-module-design.md`): **multi-provider + hot-swap + per-message provenance**. (1) **Config** — `ProviderConfig` extended with `active`/`entries: ProviderEntry[]`/`fallback` (`src/config/types.ts`); legacy flat fields (`type`/`baseUrl`/`apiKey`) kept required and mirrored from the active entry. (2) **`ProviderManager`** (`src/modules/providers/manager.ts`) — normalizes legacy configs into a single entry, resolves the active entry, caches built providers per `name|model`, `switch(name, model?)` hot-swap, `setModel()`, `list()`/`listNames()`, `toConfig()` (serializes active + entries + legacy mirrors), `resetCache()`, exported `presetOf()`. (3) **Agent** (`src/core/agent.ts`) — `AgentDeps.providerManager`, `reconfigure()` routes through the manager (`setModel` or `buildLegacyProvider` fallback), new `setProvider(name, model?)` (hot-swap + config save via `saveConfig`), `listProviders()`, and `callerProvenance()` (live `{provider, model}` source used by all logging). (4) **Bootstrap** (`bootstrap.ts`) — the initial LLM provider now comes from `providerManager.active` (honors the active entry on startup), removed the raw `createProvider` call. (5) **CLI** — `mma provider add <name> [--url --key]` (seeds entries from legacy config, picks baseUrl from `HOSTED_BASE_URLS` or `--url`), `mma provider list` shows entries with `*` active marker, `mma provider use <name>` hot-swaps via `agent.setProvider` in multi-provider mode. (6) **REPL** — `/provider list` shows entry list with active marker, `/provider use <name>` hot-swaps via `agent.setProvider`; `/status`/`/config` show the active provider from the manager; `/model use` keeps routing through `reconfigure`. (7) **Provenance (Phase 3)** — `SessionLogger` gains a `getCaller` callback and writes `provider`/`model` into `llm_usage`, `context`, `assistant`/`reasoning`/`tool_result` session-log events and `history.jsonl` messages (`SessionMessage.provider`/`model`); `ToolEvent` carries provider/model and the tool footer shows `via provider·model` (`renderer.ts`); `logLLMRequest`/`logLLMResponse` receive the real provider instead of the hardcoded `"agent"`. New i18n: `cli.add_provider`, `cli.provider_no_url`, `cli.provider_added`, `cli.provider_switch_hint` (en+ru). New tests: `tests/providers.test.ts` +6 ProviderManager cases, `tests/session-logger.test.ts` (4 provenance cases). Verified: `tsc --noEmit` clean, providers/bootstrap/cli/config/orchestrator/session-logger suites green, `build:prod` ok. Also fixed a pre-existing POSIX bug in `safeResolvePath` (`src/tools/path-utils.ts`): absolute paths like `/var/folders/...` were re-resolved against baseDir (leading-slash strip heuristic), breaking every file tool on macOS/Linux — now absolute paths are used verbatim (11 tests fixed, 0 new failures). Version: **0.46.0** (MINOR — new config section + new CLI subcommand + hot-swap + provenance logging).

- **P1** = provider module Phase 1 (spec `docs/specs/2026-08-20-provider-module-design.md`): (1) **`src/modules/providers/`** — `types.ts` (`ProviderCapabilities`/`ProviderSpec`/`ProviderOptions`), `registry.ts` (`ProviderRegistry`), `presets.ts` (`BUILTIN_PROVIDERS` — openai-compat, openrouter, openai, anthropic (flagged non-OpenAI-compatible via capabilities), opencode-zen, opencode-go; `HOSTED_BASE_URLS` derived from presets), `create.ts` (`createProvider(type, opts, registry?)` — the single construction entry point, unknown types fall back to openai-compat). (2) **4 hand-built construction sites replaced** with `createProvider()`: `bootstrap.ts` (main LLM provider), `agent.ts` `reconfigure()` (hot /model reload), `commands.ts` `model list`, `orchestrator.ts` (planning provider). (3) **setup wizard menu** (`setup.ts`) built from `BUILTIN_PROVIDERS`; `HOSTED_BASE_URLS` now imported from the provider module (single source of truth) instead of a hardcoded map. (4) New presets: `openrouter` (`https://openrouter.ai/api/v1`, requiresKey, works via OpenAI-compat code). New tests: `tests/providers.test.ts` (8 — registry, createProvider fallback, apiKey/rateLimits forwarding, hosted URLs, anthropic flag). Verified: `tsc --noEmit` clean, `build:prod` ok, cli/bootstrap suites green. Version: **0.45.0** (MINOR — new module + new openrouter preset + setup/CLI sourcing from registry).

- **54** = post-mortem fixes from `ses_msyghz8w_2cq8yt` (a VeloLanding UI task where the agent marked plan steps done while the project typecheck failed on every write, then left dead CSS/UI behind): (1) **stale `sessionId`/`sessionContext` in the tool context** (`src/core/bootstrap.ts`) — both were captured ONCE at bootstrap, so after a REPL `/new` or `/resume` the new session's `audit.jsonl` entries were tagged with the PREVIOUS session's id (observed: `ses_msyghz8w_2cq8yt/audit.jsonl` carrying `ses_msyg892p_78kqhc`) while `sessionHistory` kept reading the live meta. They are now LIVE getters over the session manager (`Object.defineProperty`), so every consumer (audit log, process registry, file-ops counters) always sees the actually-active session. `BootstrapResult` now exposes `toolCtx` for inspection. (2) **plan done-gate on known compile failures** — `ExecutionPluginState` gained `typecheckFailures: Map<file, firstError>`; `onAfterTool` parses the `[Project typecheck failed]: <tsc line>` / `[Syntax check failed]: <bun/node line>` markers out of write/edit results (`parseBrokenFile`/`extractBrokenFiles` — tsc `path(line,col): error TS…`, bun `path:line:col: error`, Windows drive-letter paths, unparseable → project-wide `""`), and a CLEAN write result clears the map (the debounced project tsc re-ran and passed). `plan update status=done` now refuses while the step's files (or a project-wide error) are still broken (`stepTypecheckGate`, path-suffix + case-insensitive match, `plan.typecheck_failed` en+ru) — the model must fix the error (a clean re-edit clears the gate) or mark the step `skipped`. This kills the observed "fix it later" cascade where steps were self-certified done while every write still failed tsc. (3) **`edit_file` "String not found" hint** — the error now tells the model to `read_file` the path first (stale target strings / line endings caused blind retries; `file.string_not_found` en+ru gained `{path}`). New tests: `tests/execution-typecheck-gate.test.ts` (30 — parseBrokenFile, extractBrokenFiles, stepTypecheckGate, plan-gate integration, plugin tracking incl. clear-on-clean), `tests/core/bootstrap.test.ts` (+live getter follow a session switch), `tests/edit-file.test.ts` (+read_file hint). Verified: `tsc --noEmit` clean; 133 execution/plan/bootstrap + 30 gate/edit-file/bootstrap + tools/plugins/core green (only pre-existing flaky `web_fetch` real-URL network timeouts fail). Version: **0.43.2** (PATCH — bugfixes + i18n; no new tools/config/commands).

- **53** = session-interrupt fix (from a REPL session where Esc mid-`edit_file` still rendered the tool result — "Replaced in …" — AFTER "Session ended"): `agent.shutdown()` only aborted the AbortController, but the loop never checked `shutdownRequested` between tool calls, and `ToolExecutor` ran the slow `onAfterTool` plugins (lint-on-write → LSP/`npx tsc`, 7-9s per write) unconditionally after the `Promise.race` settled. So an interrupt mid-write left the agent executing + writing to the closed session. (1) **`agent.ts`** — `executeSingleAgentLoop` now breaks right after `toolExecutor.execute()` and after the tool batch when `shutdownRequested`: no tool-result rendering, no `slog.logToolResult`/`logToolCall` after close, no context update for a discarded result. (2) **`executor.ts`** — `onAfterTool` plugins are skipped when the signal is aborted, and the signal is passed into the plugin hook context (`ctx.signal`, backward-compatible). (3) **`lint-on-write.ts`** — `runAsync` accepts an `AbortSignal` and kills the child (`bun build`/`node --check`/`npx tsc`) on abort so Esc returns to the prompt immediately instead of waiting out a long check; `onAfterTool` bails between stages on `signal.aborted`; an aborted syntax check is not cached. New tests: `agent.test.ts` (shutdown mid-tool → no tool-result in session log/context, no `onTool end`), `executor.test.ts` (skip onAfterTool on abort, signal in ctx, abort rejects + skips plugins on late handler completion), `lint-on-write.test.ts` (bails on pre-aborted signal). Verified: `tsc --noEmit` clean; affected suites green (executor 10, agent 48, lint-on-write 5, cli 70, modules/plugins+tools+core 166, execution/bootstrap 76). Version: **0.43.1** (PATCH — bugfix).

- **52** = plan subsystem fixes (post-mortem `ses_msydn546_943db9` — the "очисти все планы" task took 21 iterations because the `plan` tool had NO way to delete a plan). (1) **`plan delete <id>` + `plan purge`** (`src/modules/execution/plan-tool.ts` + `plan-store.ts` `deletePlan(id)`/`purgeAll()`) — the exact actions that were missing; `delete` of the active plan clears the tracker, `purge` wipes active/drafts/archived + tracker + completed-plan state. (2) **`abort` honors `id`** — it always archived the ACTIVE plan regardless of `args.id`; now it archives the named plan (active or draft), with explicit failures for `not found` / `already archived` / no active plan + no id (previously `success:true` on an empty list — the model believed it aborted something). (3) **`switch` to the already-active plan is a no-op** (`plan.already_active`) — it duplicated the active plan (two `active` entries, same id) and preserved it as a draft on every call. (4) **final audit runs for a completed plan** — auto-archiving the last step cleared the tracker, so `runFinalAudit()` returned `null` and the agent declared success without checks; `ExecutionModule` now keeps `completedPlan` (`recordCompleted`/`clearCompleted`, set in both `plan update` completion and plugin auto-advance), and `runFinalAudit` audits that plan when the tracker is null. (5) **evidence-based plan nudge** (`src/modules/execution/execution-plugin.ts`) — the old `iter===3`/`iter>=6` injections (rule #10 violation: bare iteration counters) are gone; a nudge (`exec.plan_nudge`) fires only after ≥2 file-mutating calls (`write_file`/`edit_file`/`bash`/`download_file`) with no active plan, once per session. (6) **`checkPlanAlignment` scans path arguments only** — it JSON-stringified the whole args blob, so file tokens inside `content` (e.g. an import string in a write) produced phantom off-path warnings; new `pathArgStrings()` reads only path-typed keys. (7) **`isDepsStep` requires a package-manager verb** (`npm/bun/yarn/pnpm/pip install|add|i`, `pnpm dlx`, …) — a bare "Install dependencies" step no longer triggers the lockfile hint. (8) **auto-advance resolves nested files** (`findExistingFile` subtree walk instead of exact `resolve`) — a step naming `src/App.tsx` with the file at `baseDir/bicycle-shop/src/App.tsx` stayed pending forever. (9) **`replan` renumbers ids** (`planner.ts`) — kept steps kept their original ids, so a done step id 3 collided with a new step id 3; now `[...kept, ...added].map((s,i)=>({...s,id:i+1}))`; also `toPromptBlock` shows "N/N done, complete" once every step is terminal (no dangling "current: step N"). (10) **`resolveTestCommand`** (`audit-runners.ts`) — the final audit always ran `bun test`; it now resolves the project's real runner (package.json scripts.test → vitest/jest/bunfig config files (config detection is independent of package.json) → pyproject/pytest.ini/conftest.py → go.mod → Cargo.toml → bun fallback); `findTestFile` also matches pytest files (`test_*.py`/`*_test.py`). (11) **`plan update` note for file-less steps** — completing a step that names no files succeeds but notes `plan.no_deliverables` ("names no files"), so the model can't read a plain pass as file verification. New i18n (en+ru): `plan.already_active`, `plan.already_archived`, `plan.aborted_id`, `plan.delete_no_id`, `plan.deleted`, `plan.purged`, `plan.no_deliverables`, `plan.list_legend`, `exec.plan_nudge`. Tests: new `tests/execution-plan-fixes.test.ts` (28), isMultiStep tests removed from `execution-planner.test.ts`. Verified: affected suites green (one pre-existing flaky `execution-verifier-nofiles` subtree-walk timeout under parallel load — passes alone), `tsc --noEmit --skipLibCheck` clean, `build:prod` ok. Version: **0.43.0** (MINOR — new plan tool actions + new audit/nudge behavior).

- **51** = automatic error web search (spec `docs/specs/2026-08-18-error-web-search-design.md`, plan `docs/superpowers/plans/2026-08-18-error-web-search.md`; from a session where the 9B model burned 20+ iterations re-reading the same TS error). When the SAME error signature (`tool::normalized_error_text`) repeats ≥5 times (`errorWebSearch.threshold`, default 5 — independent of the stuck threshold), the agent auto-searches the web for the error and injects the results as a `<system-summary>` — instead of blind retries. Design: (1) **master switches** — nothing fires (and the `web_search` tool is disabled) when `webSearch.enabled === false`; the auto-search additionally requires `errorWebSearch.enabled !== false`. (2) **fire-and-forget** — `ExecutionModule.maybeSearchError(ctx, call)` runs at the END of `onAfterTool`, never blocks the tool result, and queues results into `pendingMessages` (flushed in `onBeforeThink`), so it never disturbs the loop. (3) **anti-spam** — one search per signature (`markErrorSearched`/`unmarkErrorSearched`/`hasErrorSearched` in `StuckDetector`), a single retry when results are empty (`retryWebSearchSignatures`), cap `errorWebSearch.maxSearchesPerSession: 3`, time-based cooldown `ERROR_SEARCH_MIN_INTERVAL_MS = 30000` (injectable, 0 in tests). (4) **meaningful queries** — `isSearchableError()` (must contain code-adjacent patterns: error prefixes, line/col positions, imports, module-not-found, assert, expected/actual), `buildSearchQuery()` (step description + last bash command + error text + tool name; the runtime "bun" is prepended when not already in the error text, `how to fix` appended; cap `errorWebSearch.maxQueryChars: 200`). (5) **signature counting** — `normalizeErrorSignature()` strips ANSI, relative file:line:col positions, stack-frame noise, and generic text ("failed", "error"); counted per-call in `recordToolError`, cleared in all reset methods. (6) **security** — search goes through `getSessionSecurityConfig(ctx.config, ctx.sessionContext).network`; blocked requests log `logSecurityBlock`. (7) **timeout wiring** — `performWebSearch(query, numResults, networkConfig, requestTimeoutMs?)` (4th param), `WebSearchRunner` type, `errorWebSearch.requestTimeoutMs: 10000`. (8) **i18n** — `tool.web_search_disabled`, `exec.error_search_results/failed/no_query` (en+ru). (9) **bugfix** — `onAfterTool` double-counted the same error when a failing bash call printed `error TS…`: `recordToolError` ran in BOTH the typecheck branch and the `!result.success` branch, inflating the signature count and firing the search at half the threshold; now the failure branch skips counting when the typecheck branch already recorded. Config (`~/.mma/config.json`): `webSearch.{enabled,maxResults,maxQueryChars}` (shared with the `web_search` tool), `errorWebSearch.{enabled,threshold,maxResults,maxQueryChars,maxSearchesPerSession,requestTimeoutMs}`. Tests: `tests/execution-web-search.test.ts` (9 — threshold, injection, master switches, dedup, session cap, empty-result retry, write_file typecheck path), `tests/execution-stuck-detector.test.ts` (+3 blocks), `tests/tools/web-search.test.ts` (rewritten, 5), `tests/config.test.ts` (+web search defaults). 162 pass in affected files; `bunx tsc --noEmit` clean; `build:prod` ok. Version: **0.42.0** (MINOR — new config section + new auto-search behavior).

- **50** = LSP fix: typescript@5 pin + sequential probing (from `E:\projects\mma_tests` REPL — all LSP servers dead): (1) **`--package typescript@5` in npx args** (`src/modules/lsp/config.ts`, typescript/javascript/html/css) — `typescript-language-server` (and the vscode html/css servers) exit with `Could not find a valid TypeScript installation` because `npx --package X` does NOT make `typescript` resolvable to the server process (npx sets no `NODE_PATH`; resolution falls back to the workspace). A bare `--package typescript` resolves to the native TS 7 preview whose `lib/` has no `tsserver.js`, so the server rejects it — must be pinned to `typescript@5`. Also added `--yes` to typescript/javascript (old bare `npx typescript-language-server` prompts "Ok to proceed?" on a cold cache). typescript/javascript server timeout 20/15s → 30s (cold npx download). Verified: real `checkFile` reports `Type 'string' is not assignable to type 'number'` in 3.7s on a Vite/TS project. (2) **sequential probing in `probeLspServers`** (`src/modules/lsp/probe.ts`) — the REPL banner probed all applicable servers in PARALLEL, so simultaneous npx auto-installs fought over the shared npx cache lock → `LSP request timeout: initialize` for half the servers on a cold cache. Now bounded waves: per-server timeout = `min(server.timeout, cap)` (cap 30s), overall 60s deadline, `maxParallel` (default 3) servers probed concurrently with a fresh `LspClient` per server (the client is stateful — concurrent probes on a shared instance cross-talk). Sequential probing doubled the banner wait (~10s on a warm cache); waves cut it to ~5s. Result on the failing project: all 5 servers probe OK in ~10.8s (cold) / ~5s (warm). (3) **stale `lsp.servers` config normalization** (`src/config/config.ts` `normalizeLspServerArgs`) — a `~/.mma/config.json` written before 0.41.1 overrides the fixed npx args with the broken legacy ones, re-killing every server (observed: probe 25s, html/css `LSP request timeout: initialize`). On load, server args matching the known legacy forms are replaced with the current defaults (custom arrays untouched; in-memory only, mirrors `restoreDangerousPatterns`). Stale config now probes ~5s, all ✓. (4) **Windows process leak** — `LspClient.shutdown()` killed only the cmd.exe wrapper, orphaning the `npx → node → tsserver` chain after every check; it now uses the shared `killTree()` (double `taskkill /T /F`, exported from `src/modules/processes/registry.ts`). Tests: `lsp-module.test.ts` server keys updated to the new args, `probe.test.ts` wave/deadline cases, `config.test.ts` normalization cases. (5) **non-blocking banner** (`src/cli/repl.ts`) — `Repl.start()` previously `await`ed `probeLspBanner()` before printing the box, so the banner was blocked for the whole probe; now it prints immediately with an `LSP: …` placeholder as the last data row and fires the probe in the background, rewriting the row in place when done (`\x1b[2A\r\x1b[2K<row>\x1b[2B\r` — the LSP row is always 2 terminal rows above the prompt, stable under earlier-row wrapping). The rewrite is skipped when it would corrupt the screen (agent running, non-TTY, narrow terminal, summary too wide); whitespace is normalized like `box()`'s `wrapText` so the row is byte-identical to `box()` output; non-TTY skips the probe entirely (no orphaned npx on piped exit). (6) **lazy startup health check** (`src/core/bootstrap.ts` + `agent.ts`) — bootstrap `await`ed `runStartupHealthCheck` (a full `npx tsc --noEmit` over the project, ~4s on MMA even when clean), blocking every session start; the check now starts as a background promise and is consumed via new `AgentDeps.lazyPromptBlocks` which `run()` awaits before the first system prompt (resolved by the time the user types in the REPL; skipped for `--exit-on-complete`/tests as before). Tests: `agent.test.ts` lazy-block cases (awaited once, present in first system prompt, empty tolerated). MMA banner: ~5.7s → ~2s. Version: **0.41.1** (PATCH — bugfix).

- **49** = live plan checklist + tool-to-step binding + background output preview (user request: «не видно, что агент делает по плану / не видно выполнения команд»): (1) **REPL live plan checklist** — `src/ui/plan-view.ts` (new): `readActivePlan(baseDir)` reads `<baseDir>/.mma/plans/active.json` (legacy `plan.json`), `formatPlanChecklist()` renders a progress bar + per-step markers (`[x]` done / `[*]` current / `[ ]` pending / `[-]` skipped / `[!]` failed) with the current step highlighted, `currentStepIndex()` finds the first pending/skipped step, `stepContextForTool()` maps a tool call to its plan step. `repl.ts` caches the active plan (`activePlan`/`lastPlanSig`) and prints the checklist whenever it changes after `plan`/`todo` tool end (`refreshActivePlan(renderer)`); `renderer.ts` gained `planBlock(lines)` (closes an open tool card, prints the block as-is) and `toolStart(tool, args, stepContext?)` — appends a `← step {id}: {desc}` suffix (i18n `ui.step_context`, en+ru) to the tool header so every command is visibly anchored to the plan step it serves. Structural tools (`plan`/`todo`/`verify`/`project_map`/`lsp_check`/`enable_tools`) get no suffix; matching is by file tokens in the args (`extractFileLikeTokens` + `stripUrls`) with fallback to the current step. (2) **background command output preview** — `bash.ts` `BG_OUTPUT_PREVIEW_LINES = 15`: a backgrounded long-running command's result now carries the first non-empty output lines (i18n `proc.output_preview`, en+ru) so the user sees what the agent's background process actually printed instead of just a "Started" header. (3) **test fixes** — `tests/core/bootstrap.test.ts` was writing config into a fixed `/nonexistent/mma-config` (a stale artifact there broke the run); now isolated temp dir + `projectDir` = temp dir + 30s per-test timeout (bootstrap indexes the project ~4s, over vitest's default 5s under parallel load); `tests/bash.test.ts` npm-exec-hint test timeout raised 5s→30s (real `npm install` + `npx` under load). New tests: `tests/ui/plan-view.test.ts` (checklist formatting, step matching, tool-step mapping); `tests/ui/renderer.test.ts` extended (step-context suffix in inline + plain modes, `planBlock`, card close). Verified: `tsc --noEmit` clean; `bun test tests\ui` 94 pass, `tests\cli` 13 pass, `tests\core\bootstrap*` 98 pass, `tests\bash.test.ts` 46 pass. Note: full `bun test tests` on this machine doesn't reach a summary — a parallel test really spawns the agent (`Agent: [plan_…]`, `Loading model test`), it hits `localhost:1234` and the run hangs/loses the summary (pre-existing, unrelated). Version: **0.41.0** (MINOR — new REPL feature + new i18n keys).

- **48** = LSP server banner + broken package fix (from `ses_msx58xuw_hym7vv` — "проверь, есть ли ошибки в проекте" on a Vite/React TS project): (1) **REPL banner shows LSP status** — `Repl.start()` is now async and probes the LSP servers applicable to the project (`probeLspServers()` in `src/modules/lsp/probe.ts`, reusing `collectCheckFiles` + `findProjectRoot`), rendering `LSP: ✓ typescript (2.9s)  ✗ css — не стартовал` so a dead server is visible before the first write. `LspClient` gained `probe()` (spawn + initialize + shutdown) with `initialize()` extracted from `checkFile` (kept the `initialized` notification). New i18n: `repl.lsp_label` / `repl.lsp_timeout` / `repl.lsp_failed` / `repl.lsp_unknown` (en+ru). `main.ts` awaits `repl.start()`. (2) **fixed broken LSP package names** — `vscode-html-languageserver` (404 Not Found) and `vscode-css-languageserver` (unpublished 2021) never existed; both `html`, `css`, and `json` now use `npx --yes --package vscode-langservers-extracted vscode-{html,css,json}-language-server --stdio` with longer timeouts (html/css 60s, json 30s) — this was the root cause of the session's `LSP request timeout: initialize` (21.7s on an `index.html` edit) and the 90s `lsp_check` tool timeout on a directory (html/css server hung on npx). Test server key updated in `lsp-module.test.ts`. New tests: `tests/modules/lsp/probe.test.ts` (5 cases — disabled, none-applicable, language-filtered probing, failure reporting, custom collector). Verified: `bun test` green (lsp-module 5, probe 5, startup-check 5, repl 6), `tsc --noEmit` clean. Version: **0.40.1** (PATCH — bugfix + banner status line, no new command/tool).

- **47** = tool-set narrowing + on-demand enable (from the pi-vs-MMA executiveness analysis): the main agent loop now exposes only a small default tool set instead of all ~28. **Config `tools`** (`src/config/types.ts` `ToolsConfig`): `defaultTags` (default `["file","code"]`) + `enableOnDemand` (default `true`). **`alwaysOn` flag** on `ToolDefinition` (`src/tools/types.ts`) — tools that survive any tag filter; `getAllForLLM()`/`getByTags()`/`filterToolsByTags()` all keep them (structural tools `plan`/`todo`/`verify`/`project_map`/`lsp_check` are `alwaysOn`, so plan enforcement survives narrowing). **`enable_tools` tool** (`src/tools/enable-tools.ts`, `alwaysOn`) — pushes tags into the shared mutable `activeToolTags` array; the agent loop recomputes the LLM tool set **every iteration** (`agent.ts`) so enabled tools appear next turn. **Hidden-tools prompt block** (`src/tools/hidden-tools-block.ts`, wired via `getDynamicPromptBlocks` in `bootstrap.ts`) — lists tag-grouped hidden tools so the model knows they exist; instructs to call `enable_tools` or route via `subagent tool_tags`. Default set: 28→17 tools, ~3500→~2100 schema tokens (−40%); hidden: web_* (research), browser, attach_image, process_*, remember/recall, search_history. `enableOnDemand: false` restores legacy all-tools behavior. Subagent guard now uses `getByTags` (alwaysOn tools otherwise masked unknown-tag detection). New i18n: `tools.*` (en+ru). Tests: `tests/tools-tags.test.ts` (hidden block, enable_tools, filterToolsByTags), registry alwaysOn cases, config defaultTags validation. Verified: `bun test` green (only pre-existing `bootstrap` env fail), `tsc --noEmit` clean, `build:prod` ok. Version: **0.40.0** (MINOR — new config section + new tool + alwaysOn flag).

- **46** = plugin versioning + registration (user request: «может стоит обновить регистрацию плагинов и добавить версионность?»; scope = minimal + `mma plugins list` + compatibility check): (1) **`AgentPlugin` gains optional `version` (semver) and `minMmaVersion`** (`src/modules/types.ts`); (2) **dedup by name** in `PluginManager.register(plugin, source?)` (`src/modules/plugins/manager.ts`) — the higher `version` wins (unversioned = "0.0.0"), loser dropped, caller notified via `RegisterResult` (`registered` / `skipped_older` / `duplicate`); `getPluginInfos(): PluginInfo[]` (plugin + source) while `getAllPlugins()` stays backward-compatible; (3) **compatibility gate** in `PluginLoader` (`src/modules/plugins/loader.ts`) — plugin is skipped with a `plugin.incompatible` warning when `minMmaVersion` > current MMA version; bootstrap passes `mmaVersion` (new `readMmaVersion()` in `src/core/version.ts`, rule #12) + `source` (`global`/`project`) per dir; (4) **CLI `mma plugins list`** (`src/cli/plugin-commands.ts`) — external plugins only by default (matches REPL `/status`), `--all` includes builtins; REPL `/status` shows version + `[source]` per non-builtin plugin (`repl.ts`); (5) `lint-on-write` + `notify` now `isBuiltin = true` so they don't clutter the external list; (6) trace-server declares `version: "0.1.0"` + `minMmaVersion: "0.36.0"` (needs `contextManager` in hook contexts, added in 0.36.0); frontend split into `page.html` + `styles.css` + `app.js` (AGENTS.md Plugins section updated, both plugin copies re-synced). New i18n: `plugin.incompatible`, `plugin.dedup_older`, `cli.plugins.*`, `repl.plugins` (en+ru). Tests: dedup-by-version / unversioned / duplicate / source / getPlugin in `plugin-manager.test.ts` + minMmaVersion skip / source passthrough / cross-dir dedup in `plugin-loader.test.ts`. Verified: `bun test` green, `tsc --noEmit` clean, `mma plugins list` shows `trace-server v0.1.0 [global]` and skips a synthetic `minMmaVersion: 99.0.0` plugin with `plugin.incompatible`. REPL `/plugins` shows external plugins by default, `--all` shows builtins. Version: **0.39.1** (PATCH).

- **45** = session post-mortem fixes (from `ses_msvuao0h_tknhsx` — a "проверь проект на ошибки" task that ran NO build and NO LSP, then declared success): (1) **`lsp_check` tool** (`src/modules/lsp/module.ts` `getToolDefinitions` + `check-tool.ts`) — LSP only ran after write/edit, so a read-only "check for errors" task got ZERO compiler feedback; the new tool returns `[LSP errors]`/`[LSP warnings]` with relative paths (cap 40), single file or directory (walk depth 4, cap 15 files, skips `node_modules/.git/.mma/dist`, only files with a configured server), `boundedOutput: true` + `timeoutMs: 90000`; per-server disable after 3 failures; constructor takes an injectable `LspClient` for tests. Rule #1: module.ts split at 265 lines (helpers moved to `check-tool.ts`). (2) **`plan create` guard** (`plan-tool.ts`) — an active plan WITH progress (done/failed/skipped) now blocks creation (`plan.active_in_progress` with id/done/total/current, the model must `plan abort` first) instead of silently dumping the 1/6 plan into drafts; a fresh plan is still replaceable (`plan.existing_fresh` note) and a passed `id` is acknowledged as ignored (`plan.id_ignored`). (3) **compaction summary carries plan + read state** — `ContextManager` gains `planSummaryProvider` (wired in `bootstrap.ts` to `ExecutionModule.getPlanSummary()`, emitted as `[Plan: ...]` so post-compaction the model continues the plan instead of re-creating it) and `FactExtractor` tracks read_file headers as `[Read: ...]` (cap 12, both locales via the `── path (...` prefix) so already-inspected files survive compaction. (4) **FactExtractor never reads the system prompt** — `errors.md`'s stale historical entries ("edit_file failed 3x" from 2026-08-15) are no longer extracted as live `[Errors:]` (role-gated to tool/assistant); (5) **bridge path in bundled dist** — v0.37.0's `bridgeScriptPath()` looked for `dist/bridge-server.mjs` but `copy-assets.ts` ships `dist/modules/browser/`; new `bridge-path.ts` `pickExistingPath()` tries sibling + dist layout (verified `build:prod`). (6) **PLAN QUALITY prompt line** — verification steps for "check/fix errors" tasks must name the exact proving command (`bun run build` / `bun test` / `lsp_check`). New i18n: `plan.active_in_progress`, `plan.id_ignored`, `plan.existing_fresh`, `lsp.check_disabled`, `lsp.check_no_path`, `lsp.check_notfound`, `lsp.check_unsupported`, `lsp.check_clean`, `tool.friendly.lsp_check` (en+ru). New tests: `tests/lsp-check-tool.test.ts`, `tests/browser-bridge-path.test.ts`, + cases in `tests/execution-plan-deliverables.test.ts` (create-guard) and `tests/context-manager.test.ts` (plan/read in summary, system-prompt error gate). Verified: `bun test` green, `tsc --noEmit` clean, `build:prod` ok. Version: **0.38.0** (MINOR — new tool + new `plan create` semantics).

- **44** = folder plugins + trace-server split (user request: «почему бы не разбить плагин на папку»): (1) **`PluginLoader` supports folder plugins** (`src/modules/plugins/loader.ts`) — a subdirectory of the plugin dir is loaded as a plugin when it contains an entry file (`plugin.ts` → `plugin.js` → `index.ts` → `index.js`); the entry imports the folder's other modules via relative imports; folders without an entry are skipped. Flat `*.ts`/`*.js` files keep working. Tests: `tests/plugin-loader.test.ts` (9 cases — flat, plugin.ts/index.ts, priority over index, no-entry skip, mixed flat+folder, broken file isolation, default export). (2) **`trace-server` example split into a folder plugin** (`examples/plugins/trace-server/`): `plugin.ts` (entry) + `state.ts` (process-global shared state + SSE primitives) + `util.ts` (clip/scrub/summarize) + `context.ts` (snapshots + conversation-text) + `plans.ts` (on-disk plan reading + poll) + `server.ts` (HTTP/SSE) + `page.html` (frontend). (3) **root cause of «не конектится / ничего не показывает»** — the page was inlined in a template literal, so `\n` inside the page's JS strings (`e.text.split('\n')`) was interpreted as a real newline, breaking the string literal and killing the whole `<script>` parse (page loaded, SSE never handled, nothing rendered). The page is now read verbatim from disk and never template-processed; `page.html` resolves relative to the plugin folder via `import.meta.url`. Docs: `docs/plugins.md` folder-plugin section, `AGENTS.md` Plugins section. Smoke test `_testing/trace-server-smoke.ts` now imports `examples/plugins/trace-server/plugin`; e2e sandbox `_testing/trace-live/.mma/plugins/` installed as a folder. Verified: `bun test` green, `tsc --noEmit` clean, `build:prod` ok, browser check (Playwright under Node) shows `status: live` + no page errors + context panel renders. Version: **0.37.0** (MINOR — new loader feature + plugin restructure).

- **43** = REPL paste fix (user report: clipboard text was "typed", not pasted): the line editor handled bracketed paste per-character — Bun's readline delivers each pasted char as a separate keypress, and the old code called `insertText()` + a full `render()` per char, so a paste appeared as fast typing with flicker, and Windows CRLF clipboard text became double newlines. Now `LineEditor` (`src/ui/line-editor.ts`) accumulates paste chars in a `pasteBuffer` between `\x1b[200~`/`\x1b[201~` and inserts them as a single batch on `paste-end` (one render per paste, not per char); `\r\n` collapses to one `\n` (`pasteLastWasCR`) and a lone trailing `\r` yields a single trailing newline; new `insertPaste()` splits the batch into real buffer lines instead of embedding literal `\n` in one string. Tests: 4 new cases in `tests/ui/line-editor.test.ts` (batch single-render, CRLF collapse, trailing CR, multi-line). Version: **0.36.3** (PATCH).

- **42** = auto-update fixes (user report: «автообновление не работает»): (1) **silent updater logger** — `startAutoUpdate()` in `main.ts` created `UpdaterModule` without a logger, so the module's fallback (`info: () => {}`) swallowed ALL updater messages (`installing`/`installed`/`available`/`check_error`); it now passes a real stderr logger (`pc.dim`/`pc.yellow`/`pc.red`) so the user actually sees the check/install progress. (2) **one-shot `process.exit()` killed the background `npm install -g`** — the updater fired as fire-and-forget, but one-shot mode (`bun run mma "<prompt>"` / `--json`) called `process.exit()` right after the agent run, terminating the in-flight install mid-write (proven with a child-process test); `main.ts` now keeps the `UpdaterModule` reference and `await updater.waitForIdle()` before `process.exit()` in one-shot mode (skipped under `--exit-on-complete` so the certification/agent-test harness stays fast and network-free). New `UpdaterModule.waitForIdle(timeoutMs = 130000)` — races the current run-loop pass promise against the timeout, no-op when never started. (3) **semver-aware update check** — `check()` used string inequality (`latest !== current`), so a local version newer than npm's `latest` was offered as a _downgrade_; new `semverGt()` (numeric x.y.z, `v`-prefix and partial parts tolerated) gates `updateAvailable`. Tests: `waitForIdle` settles after single-shot check, returns immediately when not started; `semverGt` numeric/v-prefix/partial cases + no-downgrade check. Version: **0.36.2** (PATCH).

- **41** = post-mortem fixes from two bike-shop sessions (`ses_msudj2kx_ke4wml` qwen3.5-9b + `ses_msuexz1b_lffcxt` gemma-4-12b-qat, both Vite+React+TS; per `docs/superpowers/plans/2026-08-15-agent-fix-plan.md`): (1) **final audit typecheck finds nested project root** — `Auditor.audit()` only ran `tsc` when `baseDir/tsconfig.json` existed, so an agent working in a subfolder (`bicycle-shop/`) got NO typecheck and the audit passed with 38 tsc errors; new `findTypecheckRoot(baseDir, existingFiles)` (audit-runners.ts) walks baseDir + resolved step files upward to the nearest tsconfig, and the audit now passes resolved absolute paths in `existingFiles`; (2) **unrecognized non-zero test run blocks the audit** — `runTests()` returned `failed: -1` on unrecognized runner output, and `testsFailing = failed > 0` treated it as passing; now `failed: 1` and the gate keys on `!testRun.passed` (timeouts stay non-blocking); (3) **browser bridge diagnostics + one-shot restart** — `spawnBridge()` had no `proc.on("error")` (unhandled spawn failures crashed), discarded stderr, and `send()` threw "Bridge is not running" after an unexpected exit; now error/exit handlers reject pending with the spawn message + stderr tail (300 chars), a stale-child guard (`if (this.proc !== proc) return`) prevents a respawned bridge from being nulled by a dead child's delayed exit, and `send()` respawns once with a `retried` flag; (4) **LSP per-server disable + initialize retry + CSS timeout** — a CSS `LSP request timeout: initialize` (10s npx first-run) disabled LSP GLOBALLY for the session (killing TS checks too); disable is now per-server (`failuresByServer`/`disabledServers` keyed by `command:args`), `initialize` retries once on timeout with a full `shutdown()`+`startServer()` reset, `shutdown()` clears the stale parse buffer, and CSS timeout is 20s; (5) **npm exec hint** — `npm error could not determine executable to run` (bunx/npx on a no-bin package, missing `npm run` script) now gets a concrete `exec.npm_exec_hint` hint in bash output. New i18n: `exec.npm_exec_hint` (en+ru). New tests: nested-project + no-tsconfig audit cases, `failed:-1` blocking case, bridge spawn-error/exit-restart/stale-child tests (8), LSP per-server isolation + buffer reset, `npmExecHint` unit + real-npm e2e. Version: **0.36.1** (PATCH — bugfixes + i18n keys).
- **40** = trace-server example plugin context tracking + plugin-hook `contextManager` exposure (`examples/plugins/trace-server.ts`): live context bar (tokens/budget, quality %, compaction count, iterations since compaction, message count) fed by new `context` SSE events, plus `compaction` events rendered as CTX log entries (tokens before/after, quality before/after) — detected by compaction-count growth between hook calls. The plugin hook contexts in `agent.ts` now carry `contextManager` (was only in `onBeforeThink`); passed to `runOnPhase`, `runOnSessionStart`, `runOnError`, `runOnAfterThink`, `runOnToolStart`, `runOnToolEnd`, `runOnText`, `runOnMeta`, `runOnSessionEnd`. Dedup: both the global and project copies of the plugin load in one process, so the shared server lives on `Symbol.for("mma.trace-server")` (`globalThis`), `startServer()` dedupes concurrent starts with an in-flight promise (`state.starting`), and identical context snapshots are broadcast once. Smoke test `_testing/trace-server-smoke.ts` extended with context/compaction checks (mock `contextManager` with a rising compaction count). Version: **0.36.0** (MINOR — new plugin example + new hook-context field).
- **39** = control-loop fixes from the `system-summary` injection map (`docs/2026-08-15-system-summary-injection-map.md`): (1) **plan-alignment phantom paths** — `checkPlanAlignment` extracted step/call file tokens with a raw regex `\b[\w./\\-]+\.[a-z]+` that treated domains/URLs (`weather.com`) and extension-only segments (`tsx/.ts`) as step files, so a step like "fetch weather.com data" flagged ANY unrelated write as off-path and a step "keep only .tsx/.ts files" blocked legitimate edits; it now reuses the shared `extractFileLikeTokens(stripUrls(...))` (already used by `advancePlanIfStepComplete`/`missingStepDeliverables`/`stillExistingDeliverables`), so steps without real file tokens are inert and phantom warnings vanish; (2) **hint/recovery dedup in `StuckDetector`** — new private `getPrimaryReason()` is the single source of truth for recovery priority (stuck > tool-errors > consecutive > repetitive > read-only), `getRecoveryMessage()` was refactored onto it, and `getHints()` no longer repeats the state bullet the recovery message already covers (recovery+hints emit together in the plugin cooldown block), cutting one redundant `<system-summary>` per stuck iteration; step-keyword hints and the read-only bullet under a `stuck` primary are kept. New tests: `StuckDetector hint/recovery dedup (P3)` block in `tests/execution-stuck-detector.test.ts` (4) + plan-alignment domain/extension regressions in `tests/execution-scenario-tests.test.ts` (2). Behavior of the plan-alignment mechanism itself (off-path warning, block-after-3, completed-step rewrites) unchanged. Version: **0.35.5** (PATCH).
- **38.1** = complexity refactor (per docs/superpowers/plans/2026-08-15-complexity-refactor.md + CODE-REVIEW-COMPLEXITY.md): split the ExecutionModule god object (1190→437 lines) into focused factories `plan-tool.ts` (plan/todo/verify tools) and `execution-plugin.ts` (hook surface); extracted test/typecheck runners from auditor.ts into `audit-runners.ts` (349→235 lines); extracted fact extraction from ContextManager into `FactExtractor` (`context/fact-extractor.ts`, manager.ts 597→428); shared `buildRequestBody` in openai-compat (streaming/non-streaming DRY). `agent.ts executeSingleAgentLoop` (735 lines) NOT split — deferred: it has no loop-level test harness. Rule #1 exception documented: module.ts 437, plan-tool.ts 504, execution-plugin.ts 367, manager.ts 428 remain >300 as single-responsibility units (rule #2); further splitting deemed net-negative by review. No behavior change — 166 execution + 40 context + full suite green.
- **38** = agent-loop post-mortem fixes (from `ses_mstda6uo` — a "delete js duplicates" task that spiraled into a 150-message typecheck whack-a-mole): (1) plan steps gained model-declared `kind: "create"|"delete"` — the deliverable gate now inverts for delete steps (files must be GONE), and the final audit treats a done delete-step's missing files as satisfied (leftover files fail it); (2) compaction keeps a session `mission` — a pasted error/log block (`[User feedback:]`) no longer overwrites `[Task:]`; (3) deleted files leave the compaction `[Files:]` list and are reported as `[Deleted:]`; (4) plan-coverage reads the real user task, not the injected `<system-summary>`; (5) `isFilePathLike` rejects extension-only path tokens (`tsx/.ts`) so the gate can't demand "create tsx/.ts"; (6) final audit runs a real `tsc --noEmit --skipLibCheck` (tsconfig present, 90s cap, inconclusive non-blocking) and surfaces the first error via `exec.audit_fail_typecheck`; (7) repeated forbidden Windows commands (`grep/sed/ls/find/rm/...`) in bash are hard-stopped after 2 failures (`exec.forbidden_cmd`, win32-gated). New i18n: `plan.kinds_mismatch`, `plan.kinds_invalid`, `plan.deliverables_remain`, `exec.audit_leftovers`, `exec.forbidden_cmd` (en+ru). New files: `src/modules/execution/windows-commands.ts`. New tests: `windows-commands.test.ts`, `execution-forbidden-cmd.test.ts` (+ cases in `js-identifiers`, `context-manager`, `execution-plan-deliverables`, `execution-auditor`, `execution-plan-coverage`). Version: **0.36.0** (MINOR — new plan-schema field + new audit behavior).
- **37** = session control fixes (post-mortem `ses_mssx0k11`): (1) LSP workspace root resolved from the edited file's project via per-language `workspaceMarkers` in the LSP config (`findProjectRoot` in `src/modules/lsp/project-root.ts`) — nested projects got `[LSP check failed]: Could not find a valid TypeScript installation` on every write/edit; (2) the final audit requires files only from `done` steps and treats `skipped` as terminal — a skipped step's prose no longer produces a phantom "1 files missing" loop; (3) bash Windows hint/hard-block keys on the original command word (the `cat→type` translation defeated `UNIX_TO_WIN_HINTS`); (4) tools that declare `boundedOutput` on their `ToolDefinition` (`read_file`/`list_dir`/`file_info`/`process_log`) are never budget-truncated (near-full context was cutting read_file to ~2K chars, causing re-read loops). Version: 0.35.3.
- **36** = control-loop fixes from `ses_msstxxff_th8art` post-mortem: (1) **LSP `spawn EINVAL` on Windows under Node** — the v0.33.3 `resolveSpawnCommand()` fix (ENOENT → `npx.cmd`) was insufficient: Node still throws `spawn EINVAL` spawning a `.cmd` shim without a shell, so LSP was dead for the whole session (`[LSP check failed]: spawn EINVAL` on every write/edit → the model wrote broken TS blind). `client.ts` now, on win32, builds a quoted command line via `buildWinCommandLine()` (`src/modules/lsp/command.ts`) and passes `shell: true` so the server runs through `cmd.exe /d /s /c`. (2) **plan self-certification** — `plan update step=N status=done` now verifies the step's named files actually exist (`missingStepDeliverables()` via the shared `extractFileLikeTokens` + auditor's `findExistingFile` subtree resolver) and refuses `done` with `plan.deliverables_missing` when they don't. Fixes the session's `del bicycles.ts` → `plan update step=2 done` flow that let a 1/3-done task pass the final audit. (3) **auditor summary contradicted the verdict** — when files existed but steps were pending, `audit()` emitted `exec.audit_pass` ("[✓] Task complete: 1/3 steps done"), a green light the model read as "stop working"; it now emits `exec.audit_pending` unless every step is done. New i18n: `plan.deliverables_missing`, `exec.audit_pending` (en+ru). Tests: `tests/execution-plan-deliverables.test.ts` (new), `execution-auditor.test.ts` + `lsp-command.test.ts` extended (incl. a real `.cmd`-shim spawn on win32).
- **35** = `download_file` tool (`src/tools/download-file.ts`): download a binary file (image/archive/font/…) from a URL straight to disk — `web_fetch`/`web_browse` return text only, and the 9B model's curl workaround (`curl -sL … > file`) failed 6+ times on Windows with wrong relative paths (`curl: (23) client returned ERROR on write`). The tool: resolves the path via `safeResolvePath` + `isPathWritable` (baseDir containment + subagent scope), validates the URL via network-validator, enforces a 100 MB cap (`content-length` header and post-read `arrayBuffer` size), creates intermediate directories, and returns **metadata only** (url, absolute path, size, content-type) so binary bytes never hit the 32K context. Tags `["file","research"]`, i18n `tool.friendly.download_file` / `tool.downloaded` / `tool.download_too_large`. Note: Unsplash/Pexels/Pixabay pages are behind anti-bot (Anubis/Cloudflare 403) — the tool downloads bytes from reachable direct CDN URLs, it does not bypass CAPTCHAs. New tool → **MINOR bump (0.35.0)** on release.
- **34** = indexer project profile (`src/modules/indexer/project-profile.ts`): the project map now includes a one-line stack-neutral `[Stack: …]` summary read from the workspace manifest (package.json / pyproject.toml / Cargo.toml / go.mod / requirements.txt) — name, top deps, dev deps, scripts (capped 5/3/3, best-effort parsing, no per-language behavior). Fixes the 9B model guessing "Next.js" for a Vite/React shop before reading `package.json`. Also: the indexer map block is no longer frozen at bootstrap — it moved to `getDynamicPromptBlocks` (`registry.collectPromptBlocks(exclude)`, `bootstrap.ts`), so the map refreshes inside a session instead of a snapshot string from startup.
- **33.3** = session post-mortem fixes (from `ses_mssl5izw_fqu78w` — a "simple" React fix that took 20 min and failed): (1) **auditor nested-file resolution** — plan steps naming files by bare basename ("App.tsx") or partial path ("src/App.tsx") were flagged as missing when the real file lives in a subdirectory (`bicycle-shop/src/App.tsx`) → the final audit gate rejected a completed task forever ("1 files missing") and sent the model into a read/retry loop; `auditor.ts` now resolves via bounded subtree walk (basename + path-suffix match, depth 8, skips node_modules/.git/.mma/dist). (2) **`plan show` honors `id`** — was ignoring `args.id` and always printing the active plan, so the model asking for an archived plan got the wrong one three times in a row. (3) **compaction interval reset per user turn** — `iterationsSinceCompaction` leaked across user messages, forcing a compaction on iteration 8 of the next turn that deleted the freshly-sent task; new `ContextManager.resetUserTurn()` called at the top of `Agent.run()`. (4) **`extractFacts` now captures `edit_file` "Replaced in <path>"** (the most common write signal) plus Windows drive-letter paths — previously every edit_file fact was dropped at compaction, so the model re-read the same files after every compaction. (5) **stuck detector read-only loop** — a run of 10+ consecutive read-only tool calls (read_file/glob/grep/browser/plan) with no write is now flagged with a recovery hint; `resetStepProgress()` (instead of full `reset()`) keeps the tool-call history when a plan is complete, so the "plan complete + audit rejected → 50 read-only iterations" loop is finally caught. (6) **read_file default limit 15 → 300 lines** — the 15-line default forced 10-17 calls per file (96 read_file calls / 11 compactions in ~20 min in the session); 300 covers typical component files in one call. (7) **LSP `spawn` on Windows** — `spawn("npx", …)` fails with ENOENT because Windows ships `npx.cmd`; new `resolveSpawnCommand()` in `modules/lsp/command.ts` resolves the `.cmd`/`.exe` shim on PATH so LSP diagnostics actually run on win32 (they were dead for the whole session, silently killing type feedback). (8) **`todo` tool real subtask tracking** — `todo add` now appends to a structured `step.subtasks[]` (rendered as checkboxes in the plan prompt block) instead of a `note` string, and `todo done` marks the _individual sub-task_ done rather than auto-completing the whole plan step (observed: 3 × "todo done" returned "Step 3: done" and finished the plan early); new i18n `todo.no_items` / `todo.subtask_not_found`. (9) **memory learns repeated per-tool failures** — a memory rule is now written when a _single tool_ fails ≥3× (per-tool counter), not only when 5 _consecutive_ failures occur — so a systemic failure like LSP `spawn npx ENOENT` (8× in one session, never consecutively) finally reaches `errors.md`. (10) **compaction preserves the user's task** — `ContextManager` now tracks the turn's first real user instruction (skipping `<system-summary>`/retry envelopes) and emits it as `[Task: …]` in the compacted summary, so after compaction the model no longer forgets what it was asked to do (observed: post-compaction the model re-read files for 40+ iterations because the task "удали /bicycles, почини стили" was compacted away); `resetUserTurn()` clears the stored task so each new user message becomes the preserved one.
- **33.2** = REPL conversation layout: user/agent messages separated by divider lines (`divider()`), user prompt labeled `You:`/`Вы:` via i18n `repl.you` (agent replies already had `Agent:`). File-token heuristic inverted: `js-identifiers.ts` `isFilePathLike()` now gates bare `word.ext` tokens on an **allow-list of real file extensions** (`FILE_EXTENSIONS`) instead of a TLD deny-list — any domain (`Gismeteo.by`, `weather.com`, future TLDs) is never a file without maintaining a list; paths with a separator still accepted. Tool guidance: `browser` must not open search engines (blocked with CAPTCHA/429) — use `web_search`; `web_search` description points that out.
- **33.1** = REPL line editor redraw fix (no more duplicated multi-line input — `render()` moves back to the frame's first row via `prevCursorRow` before redrawing; `submit()`/`reset()`/`question()` commit the frame instead of erasing it); tool descriptions clarify `web_fetch`/`web_browse` are plain JS-less HTTP fetch (JS-rendered SPAs return empty content — use the `browser` tool).

- **0** = pre-1.0 (initial development)
- **22** = security `enabled` flag, security disabled by default, init/first-run apply wizard security answers, system prompt & recovery messages cleanup
- **23** = model certification module (`mma model certify`), cert checkmarks in model lists, `--model/--provider-url` env-var overrides used by the harness
- **24** = context quality formula upgrade (token load + compaction loss + error density + freshness), quality tests
- **24** = read_file display mode (show only header in REPL, full content to LLM)
- **25** = LSP module, audit gate language-agnostic, Windows command hints
- **25** = behavior-based background detection for `bash` (grace window instead of command-text heuristic), spawn error surfacing, CP866 process output decoding
- **26** = opencode-style inline tool headers (`ui.toolStyle`, default "inline"), model commentary next to tool calls (`ui.toolComments`), diffs without background color
- **27** = Windows hardening, hallucination fixes
- **28** = double-Esc interrupt fix (Bun readline collapses fast Esc Esc into one keypress — ESC bytes counted instead of events), abortable in-flight LLM requests on interrupt (`LLMProvider.chat` accepts an `AbortSignal`), clipboard paste hint when the buffer has no image
- **29** = R1–R3: smart UTF-8/OEM line decoding for process output (fixes Cyrillic mojibake on Windows), auto-detection of test-runner results (`detectTestResults`) with `[test-runner]` injections (fail → “do NOT mark done”, pass → “may mark done”), tail output (up to 400 lines) instead of head preview when tests fail, concrete stuck hints (empty CLI output → missing entry point, PowerShell cmdlets in cmd.exe, invented Bun APIs, heredoc in cmd), behavior-based background detection hardening, Windows command hints
- **30** = R4: final audit gate runs real `bun test` (90s timeout, non-blocking on timeout/unrecognized run) via process registry, `extractFailingNames()` in summary, `findTestFile()` (depth 5, skips node_modules/.git/.mma/dist), audit failure injects `<system-summary>` warning and the agent keeps working; i18n key `exec.audit_fail_tests`
- **31** = R5/R6: empty-CLI entry-point hint (`emptyCliRunHint` — file run exits 0 with no output → tell the model to check main(process.argv)/console.log; guards: test runners, redirects, non-file commands), bash tool description lists Windows anti-patterns (Write-Host, Get-Content, Select-String, Out-File, heredoc `<<`), typecheck/syntax errors in a _successful_ write/edit output now feed the stuck detector (rewrite-loop hint fires on blind rewrites instead of 20+ silent iterations)
- **29** = R1–R3 regression fixes from the CSV/CLI test runs: smart output decoding on Windows (per-line UTF-8 detection with OEM/ibm866 fallback in `registry.ts` — bun/node children write UTF-8, cmd.exe writes OEM), `detectTestResults()` auto-verification in `bash` (bun test/vitest/jest/mocha/pytest markers, `[test-runner]` warning blocks marking verification steps done on failing runs, failing runs keep the output tail instead of a 15-line head preview), stuck-detector bash awareness (`recordBashOutput`: empty-output → check entry point, PowerShell cmdlets in cmd.exe, invented Bun APIs, bash heredoc hints)
- **30** = R4: Final Audit Gate actually runs `bun test` when the plan contains a verification step and test files exist (`auditor.ts` `runTests` via processRegistry, 90s cap; inconclusive runs don't block; failing test names land in the injected warning via `exec.audit_fail_tests`). Catches final answers claiming "all tests pass" while the suite fails (task-12 regression: 8/3 → 7/3 → 14/0)
- **29.0.0** = RLM-inspired features (spec `docs/specs/2026-08-12-rlm-inspired-design.md`): `ArtifactStore` (`src/modules/artifacts/store.ts`), subagent `result_mode: "file"` pass-by-reference results, `chunk_query` tool + `runChunkQuery()` chunked parallel queries, `SubagentConfig` (resultMode/maxSummaryChars/artifactsDir/stableSystemPrompt/maxParallelChunkQueries), `ChatOptions.maxTokens` + `ChatOptions.reasoningEffort` (`reasoning_effort` in OpenAI-compat body), per-tool `timeoutMs` override, stable subagent system prompt. Fix: bun test hang from leaked `mma-idle-*.js` processes — double `taskkill /T` with 150ms settle gap in `killTree` (wmic/PowerShell process enumeration was too slow under parallel load)
- **31** = session reliability fixes (from `ses_msrv83di_0hx6id` post-mortem): (1) context quality — compaction penalty capped at 0.5 floor so cumulative compactions can never pin quality below the 40% trigger (was: 56 forced compactions in 28 min); (2) forced-compaction cooldown `FORCED_COMPACTION_COOLDOWN=3` in the agent loop; (3) `extractFacts` skips `<system-summary>` messages so summaries can't nest inside themselves; (4) final audit gate returns `success:false` + `error.audit_failed` instead of "finishing anyway"; (5) LSP failures surfaced via `[LSP check failed]` + logger instead of silent `catch {}`/`return []`; (6) `plan update` refuses out-of-order `done` (`plan.order_blocked`) and re-marking a done step (`plan.step_already_done`); (7) bash hard-stops a forbidden Windows command after 3 consecutive failures (`resetBashFailureTracking` test hook)
- **32** = auto-update (`updater` module): async non-blocking npm version check on startup (`Updater.check()`, 5s timeout, registry fetch), auto-install `npm install -g micro-models-agent` when newer (`Updater.install()`), config `updater.{enabled,checkOnStart,autoInstall,intervalMs}` (defaults: enabled, autoInstall). Fired from `main.ts` via `startAutoUpdate()` (fire-and-forget, never blocks startup; best-effort, errors swallowed). i18n keys `updater.*`. Default `intervalMs: 0` = single check per launch; set >0 for a permanent background re-check loop.
- **32** = browser driver abstraction (`src/modules/browser/driver.ts`): `BrowserDriver` interface + `PlaywrightDriver` (direct, Node) + `BridgeDriver` (`bridge-client.ts` spawns `node bridge-server.mjs`, JSON-lines RPC over stdio). `createBrowserDriver()` → bridge **always under Bun** (Playwright pipe/ws transport hangs — `chromium.launch()` never returns; fixed by running Playwright in a child Node process, ~85ms launch), direct-with-8s-timeout→bridge-fallback under Node. New config `browser.maxConsoleLineChars` (default 400), `maxConsoleEntries` default 20→40; snapshot network errors now last 15 (was 5). `scripts/copy-assets.ts` ships `bridge-server.mjs` → `dist/modules/browser/`.
- **33** = REPL line editor restored (custom `LineEditor` — see REPL Line Editor section; `line-math.ts` + `line-editor.ts`, kitty CSI u / Shift+Enter / Ctrl+J / bracketed paste / visual navigation / history; non-TTY falls back to `readline.createInterface`; `Repl` `exitOnClose` flag so piped `echo "exit" | mma` terminates, while tests construct `Repl` without it). Session post-mortem fixes (from `ses_mssi3x5f`): auditor URL false-positive — plan steps containing `https://host/repo.git` were flagged as missing files (observed `whom-pointing-jewel-maine.trycloudflare.com`); fixed with shared `stripUrls()` / `isFilePathLike()` (rejects TLD ends) / `extractFileLikeTokens()` in `js-identifiers.ts`, used by BOTH `auditor.ts` and the hallucination factual check so they can't drift; `suppressRepetitionRetry` in `agent.ts` — when the final audit gate rejects an answer and re-prompts, the model's naturally repetitive re-answer is downgraded to a warning and flows back to the audit gate (bounded by `MAX_AUDIT_RETRIES`) instead of burning the hallucination budget (was: audit loop → "too repetitive" retries → `response_blocked` on a completed task).
