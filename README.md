# MMA — Micro Models Agent

LLM agent harness for small models (Qwen3.5-9B, 32K-64K context).

## Features

- **Bash-first architecture** — one tool for everything (files, git, npm, etc.)
- **Hermes format** — `<tool_call>{"name":"bash","arguments":{"cmd":"..."}}</tool_call>`
- **OpenAI-compatible providers** — LM Studio, Ollama, vLLM, Together
- **@file syntax** — `@src/index.ts -- explain this`
- **Project indexer** — auto-generated project map + code index
- **Skills system** — load AGENTS.md and SKILL.md files
- **Session management** — save/restore conversations
- **Context management** — auto-compact at 85%, importance scoring
- **Security** — command sanitizer, dangerous pattern detection

## Installation

```bash
# From source
git clone <repo>
cd mma
npm install
npm run build

# Link globally
npm link
```

## Quick Start

```bash
# One-shot mode
mma "create a todo app in React"

# Interactive REPL
mma

# With specific provider
mma --provider ollama --model qwen3.5:9b "review this code"
```

## REPL Commands

| Command | Description |
|---------|-------------|
| `/bash <cmd>` | Run shell command |
| `/read <file>` | Display file with line numbers |
| `/edit <file> <n>` | Replace line N in file |
| `/write <file>` | Write file (end with EOF) |
| `/find <pattern>` | Find files by glob |
| `/search <pattern>` | Search file contents |
| `/git <args>` | Git operations |
| `/memory` | Show memory summary |
| `/memory add <type> <text>` | Add memory entry |
| `/memory search <query>` | Search memory |
| `/skill` | List installed skills |
| `/sessions` | List saved sessions |
| `/resume <id>` | Resume a session |
| `/save [name]` | Save current session |
| `/clear` | Clear context |
| `/index [cmd]` | Index status/rebuild/map |
| `/help` | Show help |
| `/exit` | Exit MMA |

## @file Syntax

```bash
# Load a file
@src/index.ts -- explain this function

# Multiple files
@src/auth/login.ts @src/auth/jwt.ts -- compare these

# Line range
@src/index.ts:10-30 -- what's happening here?

# Entire directory
@src/auth/ -- show module structure
```

## Provider Configuration

MMA uses `.mmrc` in project root or `~/.mma/config.json` (global).

```json
{
  "providers": {
    "lmstudio": {
      "type": "openai-compat",
      "url": "http://localhost:1234/v1",
      "models": {
        "qwen3.5-9b": {
          "model": "qwen3.5-9b-instruct",
          "contextWindow": 32768
        }
      }
    }
  },
  "active": { "provider": "lmstudio", "model": "qwen3.5-9b" }
}
```

### CLI Commands

```bash
mma provider list              # List providers
mma provider use ollama        # Switch provider
mma provider add vllm <url>    # Add provider
mma model list                 # List models
mma model use qwen2.5-14b      # Switch model
mma model params               # Show parameters
mma config show                # Show config
```

## Skills

Skills are loaded from:
- `.claude/skills/<name>/SKILL.md`
- `.agents/skills/<name>/SKILL.md`
- `~/.mma/skills/<name>/SKILL.md`

Reference skills in prompts with `@skill-name`:

```bash
@docker -- help me containerize this app
```

## Project Structure

```
src/
├── index.ts            # Entry point
├── cli.ts              # Commander CLI
├── repl.ts             # Interactive REPL
├── file-loader.ts      # @file parsing
├── config/             # Configuration
├── llm/                # LLM provider
├── tools/              # Bash tool, sanitizer, hooks
├── agent/              # Agent loop, context, memory
├── indexer/            # Project map, code index
├── skills/             # Skills loader
└── session/            # Session storage
```

## License

MIT
