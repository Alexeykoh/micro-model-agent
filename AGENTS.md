# Micro Models Agent (MMA)

LLM agent harness for small models (Qwen3.5-9B, 32K-64K context). TypeScript/Node.js ESM project.

## Quick commands

```bash
npm run mma              # dev run (bun run src/index.ts)
npm run build            # tsc + copy built-in skills to dist/
npm test                 # unit tests (bun test, specific files only)
npm run test:all         # all tests including integration
npm run test:watch       # vitest watch mode
npm run dev              # bun --watch
```

## Key commands that trip up agents

- `npm test` runs a **specific subset** of test files (see `package.json` `scripts.test`) — not `bun test` with no args. Use `npm run test:all` for everything.
- `npm run build` does **two things**: `tsc -p tsconfig.build.json` + copies `src/skills/builtin/` → `dist/skills/builtin/`. Both are required for a working build.
- The build uses `tsconfig.build.json` (extends `tsconfig.json`, adds `"jsx": "react-jsx"` for Ink UI components). Don't use plain `tsc` for builds.
- `npm run mma` is the dev shortcut — it uses `bun run src/index.ts`, not the compiled `dist/`.

## Architecture

- **ESM throughout**: `"type": "module"` in package.json. All imports use `.js` extensions (e.g. `'./foo.js'`).
- **Tool calling format**: Hermes `<tool_call>{"name":"tool_name","arguments":{...}}</tool_call>` — NOT OpenAI JSON tool_calls. The agent loop in `src/agent/loop.ts` parses this format.
- **fs-tools-first**: 12 dedicated file tools (`read_file`, `write_file`, `edit_file`, etc.) in `src/tools/fs/`. Bash is reserved for non-file operations (npm, git, docker).
- **LLM providers**: OpenAI-compatible REST only (LM Studio, Ollama, vLLM, Together). No SDK dependencies.
- **Ink UI**: React-based terminal UI (`src/ui/ink/`). Requires `jsx: "react-jsx"` in tsconfig. Components are `.tsx` files.
- **Config**: `~/.mma/config.json` globally, `.mmrc` project-local override. Config loads via `src/config/config.ts`.
- **ToolHandler interface**: All 21 tools (12 FS + bash + 3 web + 6 native) implement `ToolHandler` from `src/tools/types.ts`. ToolExecutor dispatches: pre-hooks → execute → post-hooks → truncate.
- **ModeRegistry**: Data-driven mode configs (fast/base/pro) in `src/agent/modes/`. Custom modes via `AppConfig.modes`.
- **Plugin system**: Lifecycle events in `src/plugins/`. Plugins subscribe via `AgentPlugin` interface with events like `tool:before/after`.
- **React-loop**: Shared ReAct cycle in `src/agent/react-loop.ts` with callbacks. Used by subagent.ts; loop.ts has its own inline cycle (domain logic too tightly coupled).

## Source layout (what to touch)

| Area | Path | Notes |
|------|------|-------|
| Entry point | `src/index.ts` → `src/cli.ts` | Commander CLI, registers subcommands |
| Agent loop | `src/agent/loop.ts` | ReAct cycle, ~884 lines, core logic |
| Tool executor | `src/agent/tool-executor.ts` | ToolExecutor: pure dispatcher pipeline |
| React-loop | `src/agent/react-loop.ts` | Shared ReAct cycle (193 lines) |
| Tool types | `src/tools/types.ts` | ToolHandler interface, ToolContext, ToolResult |
| Tool registry | `src/tools/registry.ts` | Wires all tools, handles file-change notifications |
| Native tools | `src/tools/native/*.ts` | plan, todo, question, approve, theme, user-profile |
| FS tools | `src/tools/fs/*.ts` | 14 files (12 tools + path-utils + types) |
| Modes | `src/agent/modes/` | ModeRegistry, ModeConfig, applier |
| Plugins | `src/plugins/` | PluginManager with event bus |
| LLM provider | `src/llm/openai-compat.ts` | Direct REST to OpenAI-compatible endpoints |
| System prompt | `src/agent/system-prompt.ts` | All prompt constants and buildSystemPrompt() |
| REPL | `src/repl/index.ts` | Interactive readline loop |
| REPL commands | `src/repl/commands.ts` | Slash command registry + handlers |
| Skills | `src/skills/builtin/` | 10 built-in skills (grill-me, typescript-expert, etc.), copied to dist/ at build |
| Theme/styling | `src/styling/` | ThemeEngine, loader, JSON theme files |
| Indexer | `src/indexer/` | Project map + AST code index (tree-sitter) |
| Web tools | `src/tools/web-*.ts` | web_search, web_fetch, web_browse (Playwright headless) |
| Ink UI | `src/ui/ink/` | React components for terminal UI |

## Testing

- Unit tests (in `npm test`): `context.test.ts`, `sanitizer.test.ts`, `code-index.test.ts`, `plan-todo-memory.test.ts`, `file-loader-syntax.test.ts`, `commands.test.ts`, `subagent.test.ts`, `web-browse.test.ts`
- Additional unit tests (in `test:all`): `tool-executor.test.ts`, `native-tools.test.ts`, `react-loop.test.ts`, `web-tools.test.ts`, `modes.test.ts`, `fs-tools.test.ts`, `user-profile.test.ts`
- Integration tests: `llm-integration.test.ts`, `agent-integration.test.ts`, `subagent-integration.test.ts` (require running LLM server)
- All tests use **vitest** (`import { describe, it, expect } from 'vitest'`)
- No vitest config file — uses defaults from package.json
- `native-tools.test.ts` has mock isolation issues — keep out of `npm test` script. Run individually or via `test:all`.

## Conventions

- **Language**: Code comments and commit messages in Russian (by project convention).
- **Plan-driven**: Major changes follow `PLAN.md`. Deviate only with justification.
- **`.mimocode/`**: Agent runtime directory — do not modify.
- **`session-*.md`**: Session logs, not part of the project.
- **`research/`**: Reference research results.
- **`docs/`**: External API documentation.
- **Config location**: `~/.mma/config.json` (global), `.mmrc` (project-local).

## LLM tuning (`agent.llm` in config)

Config section for tuning empty-response handling and model behavior:

```json
{
  "agent": {
    "llm": {
      "retries": 1,
      "retryWithoutThinking": true,
      "fallbackToReasoning": true,
      "maxTokensReasoning": 16384,
      "maxTokensDefault": 4096,
      "maxTokensAfterTool": 24576,
      "emptyResponseThreshold": 10
    }
  }
}
```

- `retries` — retry attempts for empty responses (default: 1)
- `retryWithoutThinking` — retry with `enableThinking: false` when reasoning chunks but no content (default: true)
- `fallbackToReasoning` — use reasoning text as content fallback (default: true)
- `maxTokensReasoning` / `maxTokensDefault` — model-dependent token limits
- `maxTokensAfterTool` — increased limit after tool calls in subagent
- `emptyResponseThreshold` — min reasoning chunks to trigger retry

Config loaded via `getLLMConfig()` from `src/config/config.ts`. Used in `doChat()`, `openai-compat.ts`, `subagent.ts`.

## Gotchas

- The `jsonrepair` dependency is used in the agent loop to fix malformed JSON from small models — don't remove it.
- `esprima` is used for syntax checking of code blocks before writing files.
- `execa` is used for shell execution (not raw `child_process`).
- The project publishes `dist/` + `dist/skills/builtin/` to npm (`files` field in package.json).
- Built-in skills are in `src/skills/builtin/<name>/SKILL.md` — they must be copied to dist/ at build time.
- **Tool output truncation is smart**: `truncateToolOutput()` in loop.ts applies per-tool limits (read_file=2000, bash=1500, etc.), not a flat cap. Full output persists in session store.
- **Context compaction at 70%**: Score-based importance pruning keeps top-6 important + last-6 recent. Model has ~4K token buffer for response.
- **Skills limited to 4000 tokens in system prompt**: `enforceSkillBudget()` sorts by size, keeps smaller first. In fast mode, skills are excluded entirely.
- **Temperature 0.3 recommended**: User found 0.3 improves code quality and rule following for Qwen3.5-9B.
- **Model ID format**: LM Studio uses `qwen/qwen3.5-9b` (org/model), not `qwen3.5-9b-instruct`.
- **Question/approve pause mechanism**: `ToolResult.questionPending`/`breakLoop` flags. Handlers set `questionPending=true`; loop.ts returns early with questionPending object.
- **Loop.ts still has inline ReAct cycle**: Despite react-loop.ts existing, loop.ts keeps its own cycle because domain logic (skills, plan enforcement, read_file consolidation, syntax check) is too tightly coupled. react-loop.ts is used by subagent.ts only.
- **Config defaults must be synced across 3 files**: `config/config.ts` DEFAULT_CONFIG, `cli/config.ts` reset handler, and `setup-wizard.ts`. Changing one requires updating all three.
- **Small models hallucinate file contents**: Qwen3.5-9B generates plausible file descriptions without calling tools. Prompt guidance alone insufficient; code-level enforcement needed.
- **web_browse requires Node.js**: Playwright CDP pipe has issues with Bun's child process handling. The tool works correctly with Node.js (production runtime). `npm run mma` (Bun) may not launch the browser — use `node dist/index.js` for browser tasks.
- **Playwright browsers**: Run `npx playwright install chromium` after first install. Browsers are cached in `~/.cache/ms-playwright/`.
