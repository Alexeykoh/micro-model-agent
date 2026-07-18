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

## Source layout (what to touch)

| Area | Path | Notes |
|------|------|-------|
| Entry point | `src/index.ts` → `src/cli.ts` | Commander CLI, registers subcommands |
| Agent loop | `src/agent/loop.ts` | ReAct cycle, ~845 lines, core logic |
| Tool registry | `src/tools/registry.ts` | Wires all tools, handles file-change notifications |
| FS tools | `src/tools/fs/*.ts` | 12 files, one per operation |
| LLM provider | `src/llm/openai-compat.ts` | Direct REST to OpenAI-compatible endpoints |
| REPL | `src/repl/index.ts` | Interactive readline loop |
| Skills | `src/skills/builtin/` | 8 built-in skills, copied to dist/ at build |
| Theme/styling | `src/styling/` | ThemeEngine, loader, JSON theme files |
| Indexer | `src/indexer/` | Project map + AST code index (tree-sitter) |
| Ink UI | `src/ui/ink/` | React components for terminal UI |

## Testing

- Unit tests: `tests/context.test.ts`, `sanitizer.test.ts`, `code-index.test.ts`, `plan-todo-memory.test.ts`, `file-loader-syntax.test.ts`, `commands.test.ts`
- Integration tests: `tests/llm-integration.test.ts`, `tests/agent-integration.test.ts` (require running LLM server)
- All tests use **vitest** (`import { describe, it, expect } from 'vitest'`)
- No vitest config file — uses defaults from package.json

## Conventions

- **Language**: Code comments and commit messages in Russian (by project convention).
- **Plan-driven**: Major changes follow `PLAN.md`. Deviate only with justification.
- **`.mimocode/`**: Agent runtime directory — do not modify.
- **`session-*.md`**: Session logs, not part of the project.
- **`research/`**: Reference research results.
- **`docs/`**: External API documentation.
- **Config location**: `~/.mma/config.json` (global), `.mmrc` (project-local).

## Gotchas

- The `jsonrepair` dependency is used in the agent loop to fix malformed JSON from small models — don't remove it.
- `esprima` is used for syntax checking of code blocks before writing files.
- `execa` is used for shell execution (not raw `child_process`).
- The project publishes `dist/` + `dist/skills/builtin/` to npm (`files` field in package.json).
- Built-in skills are in `src/skills/builtin/<name>/SKILL.md` — they must be copied to dist/ at build time.
