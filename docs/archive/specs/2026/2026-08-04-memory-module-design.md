# Memory Module Design

**Date:** 2026-08-04  
**Status:** Approved  
**Author:** opencode  

## Problem

User preferences (e.g., "I like green color") are not persisted across sessions. The `UserProfile` module stores preferences but only at bootstrap — the agent cannot write to it during conversation. The `MemoryStore` module exists but is completely unwired.

## Goal

Allow the agent to remember and recall information across sessions:
- User preferences (key-value)
- Facts about the user/project
- Conventions, decisions, errors (append-only logs)

## Storage

Location: `~/.mma/memory/`

```
~/.mma/memory/
├── preferences.json    # {"color": "green", "lang": "ru", "style": "concise"}
├── conventions.md      # Timestamped bullet entries
├── decisions.md        # Timestamped bullet entries
├── errors.md           # Timestamped bullet entries
└── facts.md            # Timestamped bullet entries
```

### preferences.json

Simple key-value JSON. Keys are lowercase strings. Values are strings.

```json
{
  "color": "green",
  "language": "russian",
  "response_style": "concise"
}
```

### Markdown files (conventions, decisions, errors, facts)

Append-only timestamped entries:

```markdown
# Conventions

- **2026-08-04 12:00:00** — Use 2-space indent in TypeScript files
- **2026-08-04 13:30:00** — Prefer async/await over .then()
```

## Tools

### `remember`

Store information in memory.

**Parameters:**

| Field | Required | Description |
|-------|----------|-------------|
| `category` | yes | `preferences`, `conventions`, `decisions`, `errors`, `facts` |
| `key` | yes for preferences | Key name (preferences only) |
| `value` | yes for preferences | Value to store (required for preferences, optional for others) |
| `entry` | yes for non-preferences | Text entry to append (not used for preferences) |

**Behavior:**

- `category=preferences`: writes to `preferences.json` as `key=value`
- Other categories: appends timestamped entry to `{category}.md`

**Response:**

```
Remembered: preferences.color = green
```
or
```
Remembered: conventions — "Use 2-space indent in TypeScript files"
```

### `recall`

Search and retrieve stored information.

**Parameters:**

| Field | Required | Description |
|-------|----------|-------------|
| `query` | no | Full-text search across all memory |
| `category` | no | Limit to specific category |

**Behavior:**

- No args → returns all preferences + last 5 entries from each .md file
- `query` only → full-text search across all files
- `category` only → returns all entries from that category
- `query` + `category` → search within category

**Response:**

```
Preferences:
  color = green
  language = russian

Facts (last 3):
- 2026-08-04 — User prefers dark theme
- 2026-08-03 — Working on MMA project

Conventions (last 3):
- 2026-08-04 — Use 2-space indent
```

## Module

`MemoryModule` implements `AgentModule`:

```typescript
class MemoryModule implements AgentModule {
  name = 'memory'
  
  getSystemPromptBlock(): PromptBlock | null
  // Returns: "User preferences: color=green, lang=ru"
  // Priority: medium, estimatedTokens: ~100
  
  getToolDefinitions(): ToolDefinition[]
  // Returns: [rememberTool, recallTool]
  
  getPlugin(): AgentPlugin
  // Hook: onBuildPrompt → adds preferences to system prompt
}
```

### System Prompt Block

The module injects a block into the system prompt with the current preferences:

```
User preferences: color=green, language=russian, response_style=concise
```

This ensures the agent always knows user preferences without needing to recall them.

## Integration

### bootstrap.ts changes

```typescript
import { MemoryModule } from '../modules/memory/module'

// After session setup, before moduleRegistry.register():
const memoryModule = new MemoryModule(join(dir, 'memory'))
moduleRegistry.register(memoryModule)
```

### Tool context

Tool handlers use `join(homedir(), '.mma', 'memory')` directly — no changes to `ToolContext` needed. This matches the pattern used by `search_history` tool.

### i18n

New strings in `en.json` and `ru.json`:
- `tool.remember.success` — "Remembered: {category}.{key} = {value}"
- `tool.remember.entry` — "Remembered: {category} — \"{entry}\""
- `tool.recall.preferences` — "Preferences:\n{prefs}"
- `tool.recall.entries` — "{category} ({count}):\n{entries}"
- `tool.recall.empty` — "Nothing found for \"{query}\""
- `tool.recall.no_memory` — "Memory is empty"

## Files

| File | Action |
|------|--------|
| `src/modules/memory/store.ts` | Modify — add preferences.json support |
| `src/modules/memory/search.ts` | Modify — add facts, add preferences search |
| `src/modules/memory/module.ts` | Create — AgentModule |
| `src/tools/remember.ts` | Create — remember tool |
| `src/tools/recall.ts` | Create — recall tool |
| `src/tools/index.ts` | Modify — register tools |
| `src/core/bootstrap.ts` | Modify — create and register MemoryModule |
| `src/i18n/en.json` | Modify — add strings |
| `src/i18n/ru.json` | Modify — add strings |
| `tests/memory-module.test.ts` | Create — tests |

## Testing

1. `bun test tests/memory-module.test.ts` — unit tests for store, search, tools
2. `tsc --noEmit` — type check
3. Manual test: `bun run mma "запомни что我喜欢绿色" --no-agents-md --exit-on-complete -d _testing/memory/`
4. Manual test: `bun run mma "какой цвет я люблю?" --no-agents-md --exit-on-complete -d _testing/memory/`
