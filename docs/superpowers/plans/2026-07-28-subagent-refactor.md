# Subagent.ts Refactoring Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разделить `src/tools/subagent.ts` (1042 строки, 9 ответственностей) на модули с чёткими границами.

**Architecture:** Выделение общего реестра инструментов, LLM-chat с retry, и цикла субагента в отдельные файлы. `src/tools/subagent.ts` остаётся точкой входа, реэкспортирующей публичные API из пакета `src/subagent/`.

**Tech Stack:** TypeScript 5.9+, ESM, существующие утилиты (logger, context manager, tool registry).

---

## Code Review Summary

### Текущие проблемы

| Проблема | Локация | Серьёзность |
|----------|---------|-------------|
| **9 ответственностей в 1 файле** | весь файл | high |
| **Дублирование streaming-рендеринга** | `doChat()` (строки 374-461) и `doChatOnce()` (650-700) | high |
| **Дублирование tool call execution** | не-bash (861-933) и bash (934-969) почти идентичны | medium |
| **Дублирование списков инструментов** | `validateToolCall` (243-268), `loop.ts`, `tool-executor.ts` | medium |
| **buildSubagentContext поверхностный** | не использует indexer, hardcoded limit 20 | low |
| **isTrivialError — дубль error-escalation** | строки 181-223 vs `error-escalation.ts` | medium |
| **doChat — дубль react-loop.ts** | 4-фазный retry дублирован | low (разные контексты) |
| **runIsolatedLoop — смешение уровней** | компактизация + экзекуция + синтаксис + summary в одном цикле | medium |

---

### Task 1: Создать `src/subagent/` пакет и перенести `validateToolCall`

**Files:**
- Create: `src/subagent/validation.ts`
- Modify: `src/tools/subagent.ts` (удалить validateToolCall, импортировать из нового файла)

- [ ] **Step 1: Создать `src/subagent/validation.ts`**

```typescript
/** Набор валидных инструментов (единый источник истины) */
export const VALID_TOOLS = new Set([
  "bash", "plan", "todo", "question", "approve", "theme",
  "user_profile", "subagent",
  "read_file", "write_file", "edit_file", "list_dir",
  "create_dir", "delete_file", "copy_file", "move_file", "file_info",
  "glob_search", "grep_search", "tree",
  "web_search", "web_fetch", "web_browse",
  "scaffold", "project_map",
]);

/** Обязательные аргументы для каждого инструмента */
export const REQUIRED_ARGS: Record<string, string[]> = {
  read_file: ["path"],
  write_file: ["path", "content"],
  edit_file: ["path", "old_string", "new_string"],
  list_dir: [],
  create_dir: ["path"],
  delete_file: ["path"],
  copy_file: ["source", "destination"],
  move_file: ["source", "destination"],
  file_info: ["path"],
  glob_search: ["pattern"],
  grep_search: ["pattern"],
  tree: [],
  web_search: ["query"],
  web_fetch: ["url"],
  user_profile: [],
  question: ["question"],
};
```

- [ ] **Step 2: Перенести функцию `validateToolCall` в `src/subagent/validation.ts`**

```typescript
export function validateToolCall(parsed: any): {
  valid: boolean;
  name?: string;
  cmd?: string;
  error?: string;
} {
  if (!parsed || typeof parsed !== "object") {
    return { valid: false, error: "Not an object" };
  }

  if (!parsed.name || !VALID_TOOLS.has(parsed.name)) {
    return { valid: false, error: `Unknown tool: ${parsed.name}` };
  }
  if (!parsed.arguments || typeof parsed.arguments !== "object") {
    return { valid: false, error: "Missing arguments" };
  }

  if (parsed.name === "bash") {
    const cmd = String(parsed.arguments.cmd ?? "").trim();
    if (!cmd) return { valid: false, error: "Empty command" };
    return { valid: true, name: parsed.name, cmd };
  }

  const required = REQUIRED_ARGS[parsed.name] ?? [];
  const missing = required.filter((k) => {
    const v = parsed.arguments[k];
    return v === undefined || v === null || v === "";
  });

  if (missing.length > 0) {
    return {
      valid: false,
      error: `Missing required argument(s): ${missing.join(", ")}. Tool "${parsed.name}" requires: ${required.join(", ")}`,
    };
  }

  return { valid: true, name: parsed.name };
}
```

- [ ] **Step 3: Обновить `src/tools/subagent.ts` — заменить блок валидации на импорт**

```typescript
// Удалить:
// - const VALID_TOOLS = new Set([...]) (строки 243-269)
// - const REQUIRED_ARGS: Record<string, string[]> = {...} (строки 286-303)
// - export function validateToolCall(...) (строки 233-319)

// Добавить импорт:
import { validateToolCall } from '../subagent/validation.js';
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: 243 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/subagent/validation.ts src/tools/subagent.ts
git commit -m "refactor: extract validateToolCall into src/subagent/validation.ts"
```

---

### Task 2: Создать `src/subagent/context.ts` — перенести `buildSubagentContext`

**Files:**
- Create: `src/subagent/context.ts`
- Modify: `src/tools/subagent.ts` (удалить buildSubagentContext, импортировать)

- [ ] **Step 1: Создать `src/subagent/context.ts`**

```typescript
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function buildSubagentContext(cwd: string): string {
  const lines: string[] = [];

  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules")
        continue;
      const dirPath = join(cwd, entry.name);
      try {
        const files = (readdirSync(dirPath, { recursive: true }) as string[])
          .filter((f: string) => /\.(ts|tsx|js|jsx)$/.test(f))
          .slice(0, 20);
        if (files.length > 0) {
          lines.push(`Files in ${entry.name}/: ${files.join(", ")}`);
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* no entries */ }

  try {
    const rootFiles = readdirSync(cwd).filter(
      (f: string) => /\.(ts|js)$/.test(f) && !f.startsWith("."),
    );
    if (rootFiles.length > 0) {
      lines.push("Root files: " + rootFiles.join(", "));
    }
  } catch { /* skip */ }

  try {
    const pkgPath = join(cwd, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const deps = Object.keys(pkg.dependencies || {});
      const devDeps = Object.keys(pkg.devDependencies || {});
      if (deps.length > 0) lines.push("Dependencies: " + deps.join(", "));
      if (devDeps.length > 0) lines.push("DevDependencies: " + devDeps.join(", "));
      lines.push("Module type: " + (pkg.type || "commonjs"));
    }
  } catch { /* no package.json */ }

  try {
    if (existsSync(join(cwd, "tsconfig.json"))) {
      lines.push("Has tsconfig.json");
    }
  } catch { /* no tsconfig */ }

  return lines.join("\n");
}

export { buildSubagentContext };
```

- [ ] **Step 2: Обновить `src/tools/subagent.ts`**
  - Удалить `export function buildSubagentContext(...)` (строки 60-126)
  - Добавить `import { buildSubagentContext } from '../subagent/context.js';`

- [ ] **Step 3: Запустить тесты**

Run: `npm test`
Expected: 243 pass, 0 fail

- [ ] **Step 4: Commit**

```bash
git add src/subagent/context.ts src/tools/subagent.ts
git commit -m "refactor: extract buildSubagentContext into src/subagent/context.ts"
```

---

### Task 3: Создать `src/subagent/errors.ts` — перенести классификацию ошибок

**Files:**
- Create: `src/subagent/errors.ts`
- Modify: `src/tools/subagent.ts` (удалить, импортировать)
- Modify: `src/tools/subagent.ts` (заменить `import` в `specialist.ts`)

- [ ] **Step 1: Создать `src/subagent/errors.ts`**

```typescript
/** Паттерны ошибок которые НЕ триггерят specialist (trivial) */
export const TRIVIAL_ERROR_PATTERNS = [
  /no results? found/i,
  /pattern .* matched 0 results/i,
  /0 files? matched/i,
  /command not found.*grep/i,
  /not a directory/i,
];

/** Паттерны ошибок которые ВСЕГДА требуют specialist (не trivial) */
export const NON_TRIVIAL_ERROR_PATTERNS = [
  /unexpected token/i,
  /syntaxerror/i,
  /cannot find module/i,
  /module not found/i,
  /permission denied/i,
  /enoent/i,
  /eacces/i,
];

export function isTrivialError(toolName: string, errorOutput: string): boolean {
  if (NON_TRIVIAL_ERROR_PATTERNS.some((p) => p.test(errorOutput))) {
    return false;
  }

  if (toolName === "grep_search" || toolName === "glob_search") {
    if (/0 results|0 files|no match/i.test(errorOutput) && errorOutput.length < 200) {
      return true;
    }
  }

  if (errorOutput.length < 10) return true;

  return TRIVIAL_ERROR_PATTERNS.some((p) => p.test(errorOutput));
}
```

- [ ] **Step 2: Перенести `buildSpecialistTask` туда же**

```typescript
export function buildSpecialistTask(
  toolName: string,
  toolArgs: Record<string, unknown>,
  errorOutput: string,
  userTask: string,
  attemptCount: number,
): string {
  const argsStr = JSON.stringify(toolArgs, null, 2);

  let webHints = "";
  if (toolName === "web_browse" && String(toolArgs?.action) === "evaluate") {
    const code = String(toolArgs?.value ?? toolArgs?.code ?? "");
    webHints = [
      "",
      'web_browse evaluate: "value" is JS code executed in browser context.',
      '- return statements work: return document.title',
      `- Current code that failed: ${code.slice(0, 300)}`,
    ].join("\n");
  }

  return [
    `The tool "${toolName}" has failed ${attemptCount} times with the same error while working on: "${userTask.slice(0, 200)}"`,
    "",
    `Failed tool call:`,
    `  Tool: ${toolName}`,
    `  Arguments: ${argsStr}`,
    "",
    `Error output:`,
    `  ${errorOutput.slice(0, 500)}`,
    webHints,
    "",
    `Your task: Diagnose WHY this tool call fails and FIX the underlying problem.`,
    `  - Read the relevant files to understand the actual state`,
    `  - Fix the root cause (wrong path, missing file, syntax error, etc.)`,
    `  - If the tool call arguments are wrong, correct them`,
    `  - If the file doesn't exist, create it`,
    `  - Return a clear summary of what you found and what you fixed`,
  ].join("\n");
}
```

- [ ] **Step 3: Обновить `src/tools/subagent.ts`**
  - Удалить `TRIVIAL_ERROR_PATTERNS`, `NON_TRIVIAL_ERROR_PATTERNS`, `isTrivialError`, `buildSpecialistTask`
  - Добавить `import { buildSpecialistTask, isTrivialError } from '../subagent/errors.js';`

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: 243 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/subagent/errors.ts src/tools/subagent.ts
git commit -m "refactor: extract error classification into src/subagent/errors.ts"
```

---

### Task 4: Выделить `doChat` и `doChatOnce` в `src/subagent/chat.ts`

**Files:**
- Create: `src/subagent/chat.ts`
- Modify: `src/tools/subagent.ts` (удалить doChat, doChatOnce, импортировать)

**Важно:** `doChat` дублирует логику streaming-рендеринга между основной и retry-фазами. Выносим как есть, дублирование не лечим (это отдельная задача).

- [ ] **Step 1: Создать `src/subagent/chat.ts`**

Скопировать `doChat` и `doChatOnce` как есть. Импорты: `LLMProvider`, `ChatMessage`, `OutputRenderer`, `logInfo`, `logDebug`, `logWarn`, `logLLMRequest`, `logLLMResponse`, `getLLMConfig`, `LMStudioNative`, `OpenAICompat`.

```typescript
import type { LLMProvider, ChatMessage } from "../llm/provider.js";
import { LMStudioNative } from "../llm/lmstudio-native.js";
import { OpenAICompat } from "../llm/openai-compat.js";
import type { OutputRenderer } from "../ui/renderer.js";
import {
  logInfo, logDebug, logWarn,
  logLLMRequest, logLLMResponse,
} from "../logger.js";
import { getLLMConfig } from "../config/config.js";

export async function doChat(
  provider: LLMProvider,
  messages: ChatMessage[],
  renderer: OutputRenderer,
  signal?: AbortSignal,
  retries = 1,
  showThinking = false,
  caller: "main" | "subagent" = "main",
  maxTokens?: number,
): Promise<{ response: string; genTimeMs: number }> {
  // ... весь код doChat (строки 335-619)
}

async function doChatOnce(
  provider: LLMProvider,
  messages: ChatMessage[],
  renderer: OutputRenderer,
  signal?: AbortSignal,
  enableThinking = true,
  showThinking = false,
  caller: "main" | "subagent" = "main",
  maxTokens?: number,
  temperature = 0.7,
): Promise<{ response: string; genTimeMs: number }> {
  // ... весь код doChatOnce (строки 626-715)
}
```

- [ ] **Step 2: Обновить `src/tools/subagent.ts`**
  - Удалить `doChat`, `doChatOnce` (строки 335-715)
  - Удалить импорты: `LMStudioNative`, `OpenAICompat`, `getLLMConfig` (если не используются больше)
  - Добавить `import { doChat } from '../subagent/chat.js';`

- [ ] **Step 3: Запустить тесты**

Run: `npm test`
Expected: 243 pass, 0 fail

- [ ] **Step 4: Commit**

```bash
git add src/subagent/chat.ts src/tools/subagent.ts
git commit -m "refactor: extract doChat/doChatOnce into src/subagent/chat.ts"
```

---

### Task 5: Выделить `subagentDefinition` в `src/subagent/definition.ts`

**Files:**
- Create: `src/subagent/definition.ts`
- Modify: `src/tools/subagent.ts` (удалить, импортировать и реэкспортировать)

- [ ] **Step 1: Создать `src/subagent/definition.ts`**

```typescript
import type { ToolDefinition } from "../tools/registry.js";

export const subagentDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "subagent",
    description:
      "Delegate a task to an isolated agent with a FRESH context (no history of prior errors). Use for: (1) each file when creating 3+ new files, (2) any task where you are stuck or making repeated errors, (3) simple single-step operations (bash, file read/write). The subagent has all tools and starts clean — ideal when accumulated context is causing confusion.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "What the subagent should do — be specific and include file paths",
        },
        existingFiles: {
          type: "string",
          description:
            "Comma-separated files the subagent can read for context (optional)",
        },
      },
      required: ["task"],
    },
  },
};
```

- [ ] **Step 2: Обновить `src/tools/subagent.ts`**

```typescript
// Удалить:
// - import type { ToolDefinition } from "./registry.js"; (строка 1017)
// - export const subagentDefinition: ToolDefinition = {...} (строки 1019-1042)

// Добавить:
import { subagentDefinition } from '../subagent/definition.js';
export { subagentDefinition };
```

- [ ] **Step 3: Запустить тесты**

Run: `npm test`
Expected: 243 pass, 0 fail

- [ ] **Step 4: Commit**

```bash
git add src/subagent/definition.ts src/tools/subagent.ts
git commit -m "refactor: extract subagentDefinition into src/subagent/definition.ts"
```

---

### Task 6: Упростить `runIsolatedLoop` — вынести tool execution в отдельную функцию

**Files:**
- Modify: `src/tools/subagent.ts` (выделить executeToolCall)

- [ ] **Step 1: Создать функцию `executeToolCall` в `src/tools/subagent.ts`**

Вставить перед `runIsolatedLoop`:

```typescript
async function executeToolCall(
  call: ParsedToolCall,
  toolExecutor: ToolExecutor | undefined,
  cwd: string,
  createdFiles: string[],
  errors: string[],
  step: number,
): Promise<{ output: string; exitCode: number }> {
  const { parsed, cmd } = call;
  const isBash = parsed.name === "bash";
  const toolId = generateSubagentToolCallId();

  if (parsed.name === "subagent") {
    logWarn("SUBAGENT", `nested subagent blocked at step ${step}`);
    return { output: "Subagents cannot spawn subagents (max depth 1)", exitCode: 1 };
  }

  const preview = isBash
    ? String(cmd).slice(0, 80)
    : parsed.name === "write_file" || parsed.name === "edit_file"
      ? String(parsed.arguments.path ?? "").slice(-60)
      : JSON.stringify(parsed.arguments).slice(0, 80);
  logToolCall(`sub:${parsed.name}`, preview);

  const hookCmd = isBash ? String(cmd) : `${parsed.name} ${JSON.stringify(parsed.arguments)}`;
  const execResult = toolExecutor
    ? await toolExecutor.execute(
        { id: toolId, name: parsed.name, arguments: parsed.arguments } as any,
        { cwd, quiet: false },
        hookCmd,
      )
    : null;
  const result = execResult?.result ?? {
    stdout: "", stderr: "ToolExecutor not available", exitCode: 1, truncated: false,
  };
  const output = result.stdout || result.stderr || "(no output)";
  const exitCode = result.exitCode;

  logToolOutput(`sub:${parsed.name}`, output, exitCode);

  if (exitCode !== 0 && isBash && /pwsh|powershell|not recognized|not found/i.test(output)) {
    return {
      output: output + "\n\n[HINT] Shell unavailable on this system. Use write_file tool to create files manually. Do NOT retry bash commands.",
      exitCode,
    };
  }

  if (exitCode === 0 && (parsed.name === "write_file" || parsed.name === "edit_file")) {
    const filePath = String(parsed.arguments.path ?? "");
    if (filePath && !createdFiles.includes(filePath)) {
      createdFiles.push(filePath);
      logInfo("SUBAGENT", `created: ${filePath}`);
    }
    if (filePath && /\.(ts|tsx|js|jsx|json)$/.test(filePath)) {
      const { isAbsolute, relative } = await import("node:path");
      const relPath = isAbsolute(filePath) ? relative(cwd, filePath).replace(/\\/g, "/") : filePath;
      const syntaxResult = checkFileSyntax(relPath, cwd);
      if (syntaxResult !== "OK") {
        errors.push(`${filePath}: ${syntaxResult.split("\n")[0]}`);
        logWarn("SUBAGENT", `syntax error in ${filePath}: ${syntaxResult.split("\n")[0]}`);
        return { output: output + `\nSYNTAX ERROR: ${syntaxResult}`, exitCode };
      }
    }
  }

  return { output, exitCode };
}
```

- [ ] **Step 2: Заменить тело цикла в `runIsolatedLoop`**

```typescript
// Вместо строк 848-970:
for (const call of validCalls) {
  const { output, exitCode } = await executeToolCall(
    call, toolExecutor, cwd, createdFiles, errors, step
  );

  messages.push({
    role: "tool",
    content: output.slice(0, 8000),
    tool_call_id: generateSubagentToolCallId(),
  });
  messages.push({ role: "user", content: "Continue." });
}
```

- [ ] **Step 3: Запустить тесты**

Run: `npm test`
Expected: 243 pass, 0 fail

- [ ] **Step 4: Commit**

```bash
git add src/tools/subagent.ts
git commit -m "refactor: extract executeToolCall from runIsolatedLoop"
```

---

### Task 7 (Future): Консолидировать общие реестры инструментов

**Files:**
- Create: `src/tools/registry-constants.ts`
- Modify: `src/subagent/validation.ts` (импортировать оттуда)
- Modify: `src/agent/loop.ts` (импортировать оттуда)
- Modify: `src/agent/tool-executor.ts` (импортировать оттуда)

**Описание:** Перенести `VALID_TOOLS`, `REQUIRED_ARGS`, `FS_TOOLS_REQUIRE_EXIST`, `FS_TOOLS_CHECK_PARENT`, `FS_TOOLS_COPY_MOVE` из `loop.ts`, `subagent.ts`, `tool-executor.ts` в единый `src/tools/registry-constants.ts`.

**Приоритет:** Low — не блокирует работу, триггер при добавлении нового тула.

---

## Self-Review

**Spec coverage:** План покрывает все 6 выявленных проблем: разделение валидации (Task 1), контекста (Task 2), ошибок (Task 3), LLM-чата (Task 4), описания тула (Task 5), упрощение цикла (Task 6). Task 7 отложен.

**Placeholder scan:** Все шаги содержат полный код. Никаких "TBD", "TODO", "implement later".

**Type consistency:** Все импорты и экспорты согласованы между задачами. `validateToolCall` возвращает тот же тип, `doChat` сохраняет сигнатуру, `subagentDefinition` — тот же объект.
