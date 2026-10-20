# RLM-Inspired Enhancements — Implementation Plan

> **Статус:** исполнено (2026-10-20) — фазы A/B/C реализованы в master:
> `src/modules/artifacts/store.ts` (pass-by-reference для субагента), `result_mode: "file"`
> в `src/tools/subagent.ts` / `subagent-run.ts`, стабильный системный промпт
> (`stableSystemPrompt`), `src/core/context/chunk-query.ts` (`chunk_query`).
> Пункт Task 4 (интеграция с `moe-executor`) неактуален — MoE удалён
> ([remove-moe-design](./2026-10-12-remove-moe-design.md)). Чекбоксы проставлены по факту.

**Goal:** Port the two core ideas of Recursive Language Models (arXiv:2512.24601) into MMA v2 — *pass-by-reference* for sub-agent results and *programmatic chunked processing* of oversized inputs — so a 9B model with a 32K–64K context stops losing work to context-rot and can handle inputs far beyond its window.

**Architecture:** Three independent, sequentially shippable phases. (A) `ArtifactStore` + `result_mode: "file"` on the `subagent` tool: the child's full answer is persisted to `.mma/artifacts/<session>/`, and the parent receives a bounded path + summary instead of raw text. (B) KV-cache-friendly sub-agent system prompt: fixed template + variable content moved into the user message, plus a compact few-shot workflow block. (C) `chunk_query` tool backed by `runChunkQuery()`: RLM-style `llm_query` semantics (plain LLM calls, no tool loop) over newline-aware chunks with a bounded-concurrency pool and optional synthesis call.

**Tech Stack:** Bun + TypeScript, vitest (`bun test`), `tsc --noEmit`. Existing modules reused: `src/tools/scope-check.ts` (`isPathInScope`), `src/llm/provider.ts` (`LLMProvider.chat` async generator), `src/modules/execution/moe-executor.ts` (subtask runner), i18n via `t()` (rule #8).

---

## Background (why)

RLM treats a long prompt as an *external environment* the model explores, and returns sub-agent results **by reference** (as symbols in a REPL), never by copying them into the parent's context. MMA today is at the "CodeAct + Subagents" stage: `subagent.ts` returns the child's full text into the parent context, so the parent must re-read and re-regurgitate it — the exact "transmission error"/context-rot RLM eliminates, and the most expensive failure mode for a 9B model.

This plan does **not** build a Python REPL. It ports the two mechanics that matter for our stack:

1. **Result = artifact reference** (pass-by-reference), instead of result = text blob.
2. **Chunked parallel sub-queries** (`llm_query`-style, plain LLM calls with stable system prompt → KV-cache hits), instead of "stuff it all in and compact".

Backward compatibility is a hard constraint: default config keeps today's behavior (`resultMode: "text"`), security stays disabled-by-default, and every new user-visible string goes through `t()` (rule #8).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/modules/artifacts/store.ts` | `ArtifactStore`: save/read/summary of sub-agent results, path-traversal guard | Create (Task 1) |
| `tests/modules/artifacts/store.test.ts` | Unit tests for ArtifactStore | Create (Task 1) |
| `src/config/types.ts` | `SubagentConfig` interface + field on `AppConfig` | Modify (Task 2) |
| `src/config/defaults.ts` | `subagent` defaults (backward-compatible) | Modify (Task 2) |
| `tests/config.test.ts` | defaults assertion | Modify (Task 2) |
| `src/tools/subagent.ts` | `result_mode` param, artifact persistence, stable system prompt, few-shot block | Modify (Tasks 3, 5, 6) |
| `src/i18n/en.json`, `src/i18n/ru.json` | new keys: `tool.subagent_artifact`, `tool.chunk_query_no_query`, `tool.chunk_query_no_input` | Modify (Tasks 3, 8) |
| `tests/tools/subagent.test.ts` | result_mode + prompt-stability tests | Modify (Tasks 3, 5, 6) |
| `src/modules/execution/moe-executor.ts` | pass `result_mode: "file"` from config; attach artifact content to `SubtaskResult.result` for the Router | Modify (Task 4) |
| `tests/execution-moe-executor.test.ts` | MoE artifact integration test | Create (Task 4) |
| `src/modules/context/chunk-query.ts` | `splitTextIntoChunks` + `runChunkQuery` (concurrency pool + synthesis) | Create (Task 7) |
| `tests/chunk-query.test.ts` | chunking + concurrency + synthesis tests | Create (Task 7) |
| `src/tools/chunk-query.ts` | `chunk_query` tool wrapper (scope-checked `input_path` or inline `text`) | Create (Task 8) |
| `tests/tools/chunk-query.test.ts` | tool tests (scope reject, happy path, no-input error) | Create (Task 8) |
| `src/tools/index.ts` | import + register `chunkQueryTool` | Modify (Task 9) |

---

## Task 1: ArtifactStore

**Files:**

- Create: `src/modules/artifacts/store.ts`
- Create: `tests/modules/artifacts/store.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/modules/artifacts/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../src/modules/artifacts/store";

describe("ArtifactStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-art-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sanitizes unsafe names", () => {
    expect(ArtifactStore.sanitizeName("my result!!!")).toBe("my_result");
    expect(ArtifactStore.sanitizeName("../../etc/passwd")).toBe("etc_passwd");
    expect(ArtifactStore.sanitizeName("")).toBe("artifact");
  });

  it("saves and reads content under the session dir", () => {
    const s = new ArtifactStore({ baseDir: dir, sessionId: "ses_1" });
    const abs = s.save("report", "hello world", "md");
    expect(abs).toContain(join(".mma", "artifacts", "ses_1"));
    expect(readFileSync(abs, "utf8")).toBe("hello world");
    expect(s.read("report.md")).toBe("hello world");
  });

  it("refuses reads outside the root", () => {
    const s = new ArtifactStore({ baseDir: dir, sessionId: "ses_1" });
    expect(s.read("../../other.md")).toBeNull();
  });

  it("summarizes long content with a truncation marker", () => {
    const s = new ArtifactStore({ baseDir: dir, sessionId: "ses_1" });
    const sum = s.summary("a".repeat(3000), 1000);
    expect(sum.length).toBeLessThan(1100);
    expect(sum).toContain("[truncated: 2000 chars]");
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `bun test tests/modules/artifacts/store.test.ts`
Expected: FAIL, module not found (`Cannot find module "../../src/modules/artifacts/store"`).

- [x] **Step 3: Implement the minimal module**

```ts
// src/modules/artifacts/store.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ArtifactStoreOptions {
  baseDir: string;
  sessionId: string;
  /** Directory relative to baseDir. Default: ".mma/artifacts". */
  artifactsDir?: string;
}

export class ArtifactStore {
  private readonly root: string;

  constructor(opts: ArtifactStoreOptions) {
    const artifactsDir = opts.artifactsDir || ".mma/artifacts";
    this.root = resolve(opts.baseDir, artifactsDir, opts.sessionId);
  }

  /** Normalize to [a-zA-Z0-9._-]; never empty, never "." or "..". */
  static sanitizeName(name: string): string {
    const cleaned = name
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_{2,}/g, "_");
    if (cleaned === "" || cleaned === "." || cleaned === "..") {
      return "artifact";
    }
    return cleaned;
  }

  /**
   * Persist content to <root>/<name>.<ext> and return the absolute path.
   * Throws if the resolved path escapes root (defense in depth — sanitizeName already removes separators).
   */
  save(name: string, content: string, ext = "md"): string {
    const safe = ArtifactStore.sanitizeName(name);
    const dir = resolve(this.root);
    mkdirSync(dir, { recursive: true });
    const abs = resolve(dir, `${safe}.${ext}`);
    const prefix = dir.endsWith("/") || dir.endsWith("\\") ? dir : dir + "/";
    if (!abs.startsWith(prefix)) {
      throw new Error(`Artifact path escapes root: ${abs}`);
    }
    writeFileSync(abs, content, "utf8");
    return abs;
  }

  /** Read an artifact by its file name (relative to root); null when outside the root or missing. */
  read(path: string): string | null {
    const abs = resolve(this.root, path);
    const prefix = this.root.endsWith("/") || this.root.endsWith("\\") ? this.root : this.root + "/";
    if (!abs.startsWith(prefix)) return null;
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf8");
  }

  /** First maxChars chars (trimmed) + truncation marker. */
  summary(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    const head = content.slice(0, maxChars).trimEnd();
    return `${head}\n…[truncated: ${content.length - maxChars} chars]`;
  }
}
```

Note: `save()` throws on escape; `read()` returns `null` on escape. This asymmetry is intentional — writes are programmer-controlled, reads are user-controlled.

- [x] **Step 4: Run it to verify it passes**

Run: `bun test tests/modules/artifacts/store.test.ts`
Expected: 4 passing.

- [x] **Step 5: Commit**

```bash
git add src/modules/artifacts/store.ts tests/modules/artifacts/store.test.ts
git commit -m "feat(artifacts): ArtifactStore for sub-agent pass-by-reference results"
```

---

## Task 2: `subagent` config section

**Files:**

- Modify: `src/config/types.ts` (add `SubagentConfig` + field on `AppConfig`)
- Modify: `src/config/defaults.ts` (defaults)
- Modify: `tests/config.test.ts`

- [x] **Step 1: Write the failing test**

Append to `tests/config.test.ts` (add the `DEFAULT_CONFIG` import to the top of the file if it is not already there — check the existing imports first):

```ts
// append inside an existing describe block or a new one
describe("subagent defaults", () => {
  it("keeps backward-compatible defaults", () => {
    expect(DEFAULT_CONFIG.subagent.resultMode).toBe("text");
    expect(DEFAULT_CONFIG.subagent.maxSummaryChars).toBe(2000);
    expect(DEFAULT_CONFIG.subagent.artifactsDir).toBe(".mma/artifacts");
    expect(DEFAULT_CONFIG.subagent.stableSystemPrompt).toBe(true);
    expect(DEFAULT_CONFIG.subagent.maxParallelChunkQueries).toBe(4);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL — `DEFAULT_CONFIG.subagent` is undefined.

- [x] **Step 3: Define the interface and defaults**

In `src/config/types.ts`, add this interface (place near the other feature configs, e.g. after `SessionConfig`/`UiConfig` group):

```ts
export interface SubagentConfig {
  /**
   * "text" (default, backward compatible): sub-agent result text is returned
   * into the parent context. "file": the result is persisted to an artifact
   * file and the parent receives a path + bounded summary.
   */
  resultMode: "text" | "file";
  /** Max chars of the summary returned into context when resultMode is "file". */
  maxSummaryChars: number;
  /** Directory relative to the workspace root for artifact files. */
  artifactsDir: string;
  /** Keep the sub-agent system prompt byte-identical across calls (KV-cache friendly). */
  stableSystemPrompt: boolean;
  /** Default cap on parallel chunk queries in runChunkQuery. */
  maxParallelChunkQueries: number;
}
```

In `src/config/types.ts`, add the field to `AppConfig` (alphabetical, next to `skills`/`session`):

```ts
  skills: SkillsConfig;
  subagent: SubagentConfig;
  lsp?: LspConfig;
```

In `src/config/defaults.ts` (next to the other default sections):

```ts
  subagent: {
    resultMode: "text",
    maxSummaryChars: 2000,
    artifactsDir: ".mma/artifacts",
    stableSystemPrompt: true,
    maxParallelChunkQueries: 4,
  },
```

- [x] **Step 4: Run it to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

Run: `tsc --noEmit`
Expected: no new errors on `src/config/types.ts` / `src/config/defaults.ts`.

```bash
git add src/config/types.ts src/config/defaults.ts tests/config.test.ts
git commit -m "feat(config): subagent section (resultMode, artifacts, chunk concurrency)"
```

---

## Task 3: `result_mode: "file"` on the subagent tool

**Files:**

- Modify: `src/tools/subagent.ts`
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Modify: `tests/tools/subagent.test.ts`

- [x] **Step 1: Write the failing test**

Append to `tests/tools/subagent.test.ts` (reuse the existing `mockAgentRun` mock and add `mkdtempSync`/`rmSync` imports if absent):

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// inside describe("subagentTool")
it("saves result to an artifact and returns a bounded summary when result_mode is file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mma-subagent-"));
  try {
    mockAgentRun.mockResolvedValue({
      success: true,
      text: "big result ".repeat(500), // 5500 chars
      iterationCount: 3,
    });
    const result = await subagentTool.handler(
      {
        config: {
          contextWindow: 32768,
          contextBudget: {
            systemPrompt: 0.25,
            responseReserve: 0.12,
            compactionThreshold: 0.75,
          },
          subagent: {
            resultMode: "text",
            maxSummaryChars: 2000,
            artifactsDir: ".mma/artifacts",
            stableSystemPrompt: true,
            maxParallelChunkQueries: 4,
          },
        },
        baseDir: dir,
        sessionId: "ses_x",
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        llmProvider: {} as any,
        toolExecutor: {
          execute: () => ({}),
          getToolDefinitions: () => [],
          getRegistry: () => ({ getAll: () => [], get: () => undefined, register: () => {}, has: () => false, list: () => [] }),
          setScope: () => {},
        } as any,
      } as any,
      { task: "do something", result_mode: "file" },
    );

    expect(result.success).toBe(true);
    // full 5500-char result must NOT be in context output
    expect(result.output).not.toContain("big result big result big result");
    expect(result.output).toContain("Summary:");
    expect(result.output).toContain(join(".mma", "artifacts", "ses_x"));
    expect(result.output.length).toBeLessThan(2500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `bun test tests/tools/subagent.test.ts`
Expected: FAIL — output still contains the full text (no `result_mode` handling yet). No i18n key exists yet either (`t("tool.subagent_artifact")` throws or falls through).

- [x] **Step 3: Implement**

In `src/tools/subagent.ts`:

1. Add imports:

```ts
import { ArtifactStore } from "../modules/artifacts/store";
```

1. Add the two parameters to the tool's `parameters.properties`:

```ts
      result_mode: {
        type: "string",
        enum: ["text", "file"],
        description:
          '"file": persist the full result to an artifact and return a path + summary (pass-by-reference). "text" (default): return the full text into context.',
      },
      artifact_name: {
        type: "string",
        description: "Artifact file name (sanitized). Default: subagent-<timestamp>.",
      },
```

1. Replace the success branch of the `try` block (the current `return result.success ? {...} : {...}`):

```ts
      const result = await subAgent.run(fullTask);
      if (result.success) {
        const resultMode =
          (args.result_mode as string) ||
          ctx.config.subagent?.resultMode ||
          "text";
        if (resultMode === "file") {
          const store = new ArtifactStore({
            baseDir: ctx.baseDir,
            sessionId: ctx.sessionId || "default",
            artifactsDir: ctx.config.subagent?.artifactsDir,
          });
          const abs = store.save(
            (args.artifact_name as string) || `subagent-${Date.now()}`,
            result.text,
            "md",
          );
          const summary = store.summary(
            result.text,
            ctx.config.subagent?.maxSummaryChars ?? 2000,
          );
          return {
            success: true,
            output: t("tool.subagent_artifact", {
              path: abs,
              iterations: String(result.iterationCount),
              summary,
            }),
          };
        }
        return {
          success: true,
          output: `Sub-agent completed:\n${result.text}\n\nIterations: ${result.iterationCount}`,
        };
      }
      return {
        success: false,
        output: `Sub-agent failed: ${result.error}\nPartial output: ${result.text}`,
      };
```

Check how `t()` interpolates placeholders in this codebase (see existing usages in `src/tools/*.ts`, e.g. `t("exec.hints", { hints: ... })` in `moe-executor.ts`) and use the same syntax: `{path}`, `{iterations}`, `{summary}`.

1. Add i18n keys:

```jsonc
// src/i18n/en.json — under "tool"
"tool.subagent_artifact": "Sub-agent completed. Full result saved to artifact: {path}\nIterations: {iterations}\nSummary:\n{summary}"
```

```jsonc
// src/i18n/ru.json — under "tool"
"tool.subagent_artifact": "Суб-агент завершён. Полный результат сохранён в артефакт: {path}\nИтераций: {iterations}\nСводка:\n{summary}"
```

- [x] **Step 4: Run it to verify it passes**

Run: `bun test tests/tools/subagent.test.ts tests/i18n.test.ts`
Expected: PASS — new test green, i18n parity check green (both locales have the key).

- [x] **Step 5: Commit**

```bash
git add src/tools/subagent.ts src/i18n/en.json src/i18n/ru.json tests/tools/subagent.test.ts
git commit -m "feat(subagent): result_mode=file — pass-by-reference results via ArtifactStore"
```

---

## Task 4: MoE executor artifact integration

**Files:**

- Modify: `src/modules/execution/moe-executor.ts`
- Create: `tests/execution-moe-executor.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/execution-moe-executor.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MoEExecutor } from "../src/modules/execution/moe-executor";
import type { MoEPlan } from "../src/modules/execution/types";
import type { ToolRegistry } from "../src/tools/registry";
import type { ToolDefinition } from "../src/tools/types";

describe("MoEExecutor with result_mode=file", () => {
  it("attaches full artifact content to SubtaskResult.result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-moe-"));
    try {
      const artifactPath = join(dir, "out.md");
      writeFileSync(artifactPath, "FULL_ARTIFACT_CONTENT_42", "utf8");

      const fakeSubagent: ToolDefinition = {
        name: "subagent",
        description: "fake",
        parameters: { type: "object", properties: {} },
        handler: async () => ({
          success: true,
          output: `Sub-agent completed. Full result saved to artifact: ${artifactPath}\nIterations: 1\nSummary:\nsnip`,
        }),
      };
      const registry = {
        get: (name: string) => (name === "subagent" ? fakeSubagent : undefined),
        getAll: () => [fakeSubagent],
      } as unknown as ToolRegistry;

      const executor = new MoEExecutor({
        config: {
          subagent: { resultMode: "file" },
          experts: {
            code: { model: "m", tool_tags: ["file"] },
          },
        } as any,
        toolRegistry: registry,
        toolExecutor: {} as any,
        llmProvider: {} as any,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
        baseDir: dir,
      });

      const plan: MoEPlan = {
        title: "t",
        subtasks: [
          {
            id: "task-1",
            description: "produce output.md",
            expert_tag: "code",
            allowed_files: [dir],
            read_only_files: [],
            depends_on: [],
            input_from: [],
            expected_output: "output.md",
            success_criteria: ["file exists"],
          },
        ],
        shared_context: { rules: [], refs: [] },
      };

      const planResult = await executor.executePlan(plan);
      expect(planResult.success).toBe(true);
      // the fake subagent wrote the file itself; executor must pass result_mode="file"
      // and the SubtaskResult.result must carry full content for the Router
      const sub = planResult.results[0];
      expect(sub.summary).toContain("Artifact:");
      expect(sub.result).toContain("FULL_ARTIFACT_CONTENT_42");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `bun test tests/execution-moe-executor.test.ts`
Expected: FAIL — `config.subagent`/`subagent.resultMode` is not read by `executeSubtask` yet.

- [x] **Step 3: Implement**

In `src/modules/execution/moe-executor.ts`:

1. Import the artifact reader:

```ts
import { ArtifactStore } from "../artifacts/store";
```

1. In `executeSubtask`, when building `subagentArgs`, add the mode + stable artifact name:

```ts
      const subagentArgs: Record<string, unknown> = {
        task: taskPrompt,
        allowed_files: allowedFiles,
        read_only_files: readOnlyFiles,
        tool_tags: expertConfig.tool_tags,
      };
      if (deps.config.subagent?.resultMode === "file") {
        subagentArgs.result_mode = "file";
        subagentArgs.artifact_name = subtask.id;
      }
```

1. In the success branch of `executeSubtask`, when `result_mode` is file, extract the artifact path from the handler output and attach full content:

```ts
      if (result.success) {
        if (deps.config.subagent?.resultMode === "file") {
          const pathMatch = result.output.match(/saved to artifact: (.+)/);
          const abs = pathMatch ? pathMatch[1].trim() : "";
          if (abs) {
            const store = new ArtifactStore({
              baseDir: deps.baseDir,
              sessionId: "moe",
            });
            const full = store.read(abs.split(/[\\/]/).pop() || ""); // file name only, scoped to root
            return {
              subtaskId: subtask.id,
              success: true,
              summary: `Artifact: ${abs}`,
              result: full ?? result.output,
              durationMs: Date.now() - startTime,
            };
          }
        }
        return {
          subtaskId: subtask.id,
          success: true,
          summary: `Completed: ${subtask.id}`,
          result: result.output,
          durationMs: Date.now() - startTime,
        };
      }
```

Explanation: the Router's `verifyAndMerge` receives `VerifyInput.results` (JSON-serialized), so it needs the *content* — the summary alone is not enough to compose the final answer. The bounded summary is what the non-MoE parent agent gets; the orchestrator gets full content. `store.read()` is scoped to the artifacts root, so a malicious path in the handler output cannot escape.

- [x] **Step 4: Run it to verify it passes**

Run: `bun test tests/execution-moe-executor.test.ts`
Expected: PASS. Also run the full suite to confirm no MoE regression: `bun test`

- [x] **Step 5: Commit**

```bash
git add src/modules/execution/moe-executor.ts tests/execution-moe-executor.test.ts
git commit -m "feat(moe): result_mode=file integration — Router receives artifact content"
```

---

## Task 5: KV-cache-friendly stable system prompt

**Files:**

- Modify: `src/tools/subagent.ts`
- Modify: `tests/tools/subagent.test.ts`

- [x] **Step 1: Write the failing test**

Append to `tests/tools/subagent.test.ts`:

```ts
it("keeps the system prompt fixed (KV-cache friendly) and puts context into the user message", async () => {
  mockAgentRun.mockResolvedValue({ success: true, text: "done", iterationCount: 1 });
  await subagentTool.handler(
    {
      config: {
        contextWindow: 32768,
        contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
        subagent: { resultMode: "text", maxSummaryChars: 2000, artifactsDir: ".mma/artifacts", stableSystemPrompt: true, maxParallelChunkQueries: 4 },
      },
      baseDir: "/tmp",
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      llmProvider: {} as any,
      toolExecutor: {
        execute: () => ({}),
        getToolDefinitions: () => [],
        getRegistry: () => ({ getAll: () => [], get: () => undefined, register: () => {}, has: () => false, list: () => [] }),
        setScope: () => {},
      },
    } as any,
    { task: "do task", context: "VARIABLE_CONTEXT_XYZ", tool_tags: ["file"] },
  );

  const deps = mockAgent.mock.calls[0][0];
  // system prompt must NOT contain the variable context (byte-identical across calls)
  expect(deps.promptBlocks[0].content).not.toContain("VARIABLE_CONTEXT_XYZ");
  // the variable context must reach the sub-agent via the user message
  expect(mockAgentRun.mock.calls[0][0]).toContain("VARIABLE_CONTEXT_XYZ");
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `bun test tests/tools/subagent.test.ts`
Expected: FAIL — current system prompt embeds `Context: ${context}`.

- [x] **Step 3: Implement**

In `src/tools/subagent.ts`, replace the inline system prompt construction with a module-level template constant and remove `context` from it:

```ts
const SUBAGENT_SYSTEM_PROMPT_TEMPLATE =
  "You are a sub-agent working on a specific task. You have your own context window and tool set. Work autonomously and return your final result in your response.";
```

Replace the current `systemPrompt` construction:

```ts
      const systemPrompt: PromptBlock = {
        content: SUBAGENT_SYSTEM_PROMPT_TEMPLATE,
        priority: "critical",
        essential: true,
        estimatedTokens: 100,
      };
```

The `fullTask` line already merges task + context into the user message:

```ts
      const fullTask = context ? `${task}\n\nContext: ${context}` : task;
```

(no change needed there). If `stableSystemPrompt` is ever set to `false` in config, keep the current behavior of embedding context into the system prompt — add the conditional:

```ts
      const systemPrompt: PromptBlock = {
        content:
          ctx.config.subagent?.stableSystemPrompt === false
            ? `You are a sub-agent working on a specific task. ${context ? `Context: ${context}` : ""}`
            : SUBAGENT_SYSTEM_PROMPT_TEMPLATE,
        priority: "critical",
        essential: true,
        estimatedTokens: 100,
      };
```

- [x] **Step 4: Run it to verify it passes**

Run: `bun test tests/tools/subagent.test.ts`
Expected: PASS (all existing + new tests).

- [x] **Step 5: Commit**

```bash
git add src/tools/subagent.ts tests/tools/subagent.test.ts
git commit -m "perf(subagent): fixed system prompt template — KV-cache friendly, context via user message"
```

---

## Task 6: Few-shot workflow block in the sub-agent prompt

**Files:**

- Modify: `src/tools/subagent.ts`
- Modify: `tests/tools/subagent.test.ts`

- [x] **Step 1: Write the failing test**

Append to `tests/tools/subagent.test.ts`:

```ts
it("includes the RLM few-shot workflow guidance in the system prompt", async () => {
  mockAgentRun.mockResolvedValue({ success: true, text: "done", iterationCount: 1 });
  await subagentTool.handler(
    {
      config: {
        contextWindow: 32768,
        contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
        subagent: { resultMode: "text", maxSummaryChars: 2000, artifactsDir: ".mma/artifacts", stableSystemPrompt: true, maxParallelChunkQueries: 4 },
      },
      baseDir: "/tmp",
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      llmProvider: {} as any,
      toolExecutor: {
        execute: () => ({}),
        getToolDefinitions: () => [],
        getRegistry: () => ({ getAll: () => [], get: () => undefined, register: () => {}, has: () => false, list: () => [] }),
        setScope: () => {},
      },
    } as any,
    { task: "t", tool_tags: ["file"] },
  );

  const deps = mockAgent.mock.calls[0][0];
  expect(deps.promptBlocks[0].content).toContain("write_file");
  expect(deps.promptBlocks[0].content).toContain("subagent");
  expect(deps.promptBlocks[0].content).toContain("verify");
});
```

- [x] **Step 2: Run it to verify it fails**

Expected: FAIL — template is only one sentence.

- [x] **Step 3: Implement**

Replace the template constant in `src/tools/subagent.ts` (Task 5) with the extended version — the fixed part stays byte-identical for KV cache, only the literal template changes:

```ts
const SUBAGENT_SYSTEM_PROMPT_TEMPLATE = `You are a sub-agent working on a specific task. You have your own context window and tool set.

Workflow rules:
- Prefer small, focused steps. Verify your own work (typecheck/tests) before finishing.
- For large outputs, write the result to a file with write_file instead of reproducing it in your answer.
- If the task is big and decomposable, delegate parts to the subagent tool instead of doing everything in one context.
- When you finish, return a concise final answer; do not repeat file contents verbatim if you already wrote them to disk.`;
```

- [x] **Step 4: Run it to verify it passes**

Run: `bun test tests/tools/subagent.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/tools/subagent.ts tests/tools/subagent.test.ts
git commit -m "feat(subagent): few-shot workflow guidance (RLM-style pass-by-reference habits)"
```

---

## Task 7: `runChunkQuery` + `splitTextIntoChunks`

**Files:**

- Create: `src/modules/context/chunk-query.ts`
- Create: `tests/chunk-query.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/chunk-query.test.ts
import { describe, it, expect } from "vitest";
import {
  splitTextIntoChunks,
  runChunkQuery,
  DEFAULT_CHUNK_SYSTEM_PROMPT,
  DEFAULT_SYNTHESIS_SYSTEM_PROMPT,
} from "../src/modules/context/chunk-query";
import type { Message } from "../src/llm/provider";

function mockProvider(answers: string[], delayMs = 5) {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: Array<{ system: string; user: string }> = [];
  const provider = {
    chat: async function* (messages: Message[]) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      const system = messages.find((m) => m.role === "system")?.content as string;
      const user = messages.find((m) => m.role === "user")?.content as string;
      calls.push({ system, user });
      const isChunkCall = system === DEFAULT_CHUNK_SYSTEM_PROMPT;
      const isSynthCall = system === DEFAULT_SYNTHESIS_SYSTEM_PROMPT;
      let content = "";
      if (isSynthCall) content = "SYNTHESIS";
      else if (isChunkCall) content = answers.shift() || "NO_EVIDENCE";
      inFlight--;
      yield { type: "text", content };
    },
  };
  return { provider, calls, maxInFlight: () => maxInFlight, inFlight: () => inFlight };
}

describe("splitTextIntoChunks", () => {
  it("returns a single chunk for short text", () => {
    expect(splitTextIntoChunks("hello", 12000)).toEqual(["hello"]);
  });

  it("splits on newline boundaries, never mid-line", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-abcdefghij`);
    const chunks = splitTextIntoChunks(lines.join("\n"), 100);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      const first = c.split("\n")[0];
      expect(first.startsWith("line-")).toBe(true);
    }
  });

  it("throws on non-positive chunk size", () => {
    expect(() => splitTextIntoChunks("x", 0)).toThrow();
  });
});

describe("runChunkQuery", () => {
  it("bounds parallelism and returns answers + synthesis", async () => {
    const { provider, maxInFlight } = mockProvider(["A1", "A2", "A3"]);
    const text = Array.from({ length: 90 }, (_, i) => `row${i}${"-".repeat(15)}`).join("\n");
    const res = await runChunkQuery(provider as any, text, "count rows", {
      chunkChars: 200,
      maxParallel: 2,
    });
    expect(res.chunks).toBeGreaterThan(3);
    expect(res.answers).toHaveLength(res.chunks);
    expect(res.synthesis).toBe("SYNTHESIS");
    expect(maxInFlight()).toBeLessThanOrEqual(2);
    expect(res.maxParallelObserved).toBeLessThanOrEqual(2);
  });

  it("skips synthesis when synthesize=false", async () => {
    const { provider, calls } = mockProvider(["A1"]);
    const res = await runChunkQuery(provider as any, "x".repeat(250), "q", {
      chunkChars: 100,
      synthesize: false,
    });
    expect(res.synthesis).toBe("");
    expect(calls.every((c) => c.system === DEFAULT_CHUNK_SYSTEM_PROMPT)).toBe(true);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `bun test tests/chunk-query.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

```ts
// src/modules/context/chunk-query.ts
import type { LLMProvider, Message } from "../../llm/provider";

export interface ChunkQueryOptions {
  /** Approx chunk size in chars. Default: 12000. */
  chunkChars?: number;
  /** Max concurrent chunk queries. Default: 4. */
  maxParallel?: number;
  /** Run a final synthesis call over all answers. Default: true. */
  synthesize?: boolean;
  querySystemPrompt?: string;
  synthesisSystemPrompt?: string;
}

export interface ChunkQueryResult {
  chunks: number;
  answers: string[];
  synthesis: string;
  totalChars: number;
  /** Highest number of chunk queries in flight at once (for tests/tuning). */
  maxParallelObserved: number;
}

export const DEFAULT_CHUNK_SYSTEM_PROMPT =
  'Answer the query using ONLY the provided text. Be concise. If the text does not contain the answer, say "NO_EVIDENCE".';

export const DEFAULT_SYNTHESIS_SYSTEM_PROMPT =
  "You are given a query and per-chunk answers over a large text. Produce the final answer to the query, combining evidence from the chunks. If no chunk had evidence, say so.";

/** Split text into newline-aware chunks, each <= chunkChars chars. */
export function splitTextIntoChunks(text: string, chunkChars: number): string[] {
  if (chunkChars <= 0) throw new Error("chunkChars must be > 0");
  if (text.length <= chunkChars) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (current.length > 0 && size + line.length + 1 > chunkChars) {
      chunks.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

async function chatText(provider: LLMProvider, messages: Message[]): Promise<string> {
  let out = "";
  for await (const chunk of provider.chat(messages)) {
    if (chunk.type === "text" && chunk.content) out += chunk.content;
  }
  return out;
}

/**
 * RLM-style llm_query: answer `query` over `text` by chunking and querying the
 * model per chunk with a fixed system prompt (KV-cache friendly), bounded
 * concurrency, and an optional synthesis pass.
 */
export async function runChunkQuery(
  provider: LLMProvider,
  text: string,
  query: string,
  opts: ChunkQueryOptions = {},
): Promise<ChunkQueryResult> {
  const chunkChars = opts.chunkChars ?? 12000;
  const maxParallel = Math.max(1, opts.maxParallel ?? 4);
  const chunks = splitTextIntoChunks(text, chunkChars);
  const answers: string[] = new Array(chunks.length);
  const chunkSystem = opts.querySystemPrompt ?? DEFAULT_CHUNK_SYSTEM_PROMPT;

  let cursor = 0;
  let inFlight = 0;
  let maxParallelObserved = 0;

  const workers = Array.from(
    { length: Math.min(maxParallel, chunks.length) },
    async () => {
      while (cursor < chunks.length) {
        const idx = cursor++;
        inFlight++;
        maxParallelObserved = Math.max(maxParallelObserved, inFlight);
        try {
          answers[idx] = await chatText(provider, [
            { role: "system", content: chunkSystem },
            { role: "user", content: `Query: ${query}\n\nText:\n${chunks[idx]}` },
          ]);
        } finally {
          inFlight--;
        }
      }
    },
  );
  await Promise.all(workers);

  let synthesis = "";
  if (opts.synthesize !== false && chunks.length > 0) {
    const joined = answers
      .map((a, i) => `--- Chunk ${i + 1}/${chunks.length} ---\n${a}`)
      .join("\n\n");
    synthesis = await chatText(provider, [
      {
        role: "system",
        content: opts.synthesisSystemPrompt ?? DEFAULT_SYNTHESIS_SYSTEM_PROMPT,
      },
      { role: "user", content: `Query: ${query}\n\nChunk answers:\n${joined}` },
    ]);
  }

  return {
    chunks: chunks.length,
    answers,
    synthesis,
    totalChars: text.length,
    maxParallelObserved,
  };
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `bun test tests/chunk-query.test.ts`
Expected: PASS (4 tests).

- [x] **Step 5: Typecheck and commit**

Run: `tsc --noEmit`
Expected: no new errors.

```bash
git add src/modules/context/chunk-query.ts tests/chunk-query.test.ts
git commit -m "feat(chunk-query): RLM-style chunked parallel queries with synthesis (llm_query semantics)"
```

---

## Task 8: `chunk_query` tool

**Files:**

- Create: `src/tools/chunk-query.ts`
- Create: `tests/tools/chunk-query.test.ts`
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`

- [x] **Step 1: Write the failing test**

```ts
// tests/tools/chunk-query.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkQueryTool } from "../../src/tools/chunk-query";
import type { Message } from "../../src/llm/provider";

function mockProvider() {
  return {
    chat: async function* (messages: Message[]) {
      const user = messages.find((m) => m.role === "user")?.content as string;
      yield { type: "text", content: user.includes("Text:") ? "CHUNK_ANSWER" : "SYNTH" };
    },
  };
}

const baseCtx = (dir: string) =>
  ({
    baseDir: dir,
    scope: { allowed_files: [], read_only_files: [] },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    llmProvider: mockProvider() as any,
    config: {
      subagent: { maxParallelChunkQueries: 2 },
    },
  }) as any;

describe("chunkQueryTool", () => {
  it("has correct definition", () => {
    expect(chunkQueryTool.name).toBe("chunk_query");
    expect(chunkQueryTool.parameters.required).toContain("query");
  });

  it("fails without input", async () => {
    const res = await chunkQueryTool.handler(baseCtx("/tmp"), { query: "q" });
    expect(res.success).toBe(false);
  });

  it("rejects paths outside scope", async () => {
    const res = await chunkQueryTool.handler(baseCtx("/tmp"), {
      query: "q",
      input_path: "/etc/passwd",
    });
    expect(res.success).toBe(false);
    expect(res.output).toContain("SCOPE");
  });

  it("answers over a large temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-cq-"));
    try {
      const file = join(dir, "big.txt");
      writeFileSync(file, Array.from({ length: 200 }, (_, i) => `row${i}`).join("\n"), "utf8");
      const res = await chunkQueryTool.handler(
        {
          ...baseCtx(dir),
          scope: { allowed_files: [dir], read_only_files: [file] },
        },
        { query: "count rows", input_path: file, chunk_chars: 100 },
      );
      expect(res.success).toBe(true);
      expect(res.output).toContain("chunk(s)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `bun test tests/tools/chunk-query.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

```ts
// src/tools/chunk-query.ts
import { readFileSync } from "node:fs";
import { t } from "../i18n/index";
import type { ToolDefinition, ToolContext, ToolResult } from "./types";
import { isPathInScope } from "./scope-check";
import { runChunkQuery } from "../modules/context/chunk-query";

export const chunkQueryTool: ToolDefinition = {
  name: "chunk_query",
  description:
    "Answer a query over a large text (file or inline) by splitting it into chunks and querying the model per chunk in parallel, then optionally synthesizing a final answer. Use when the input is too large for the context window.",
  tags: ["research", "code"],
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The question to answer over the text.",
      },
      input_path: {
        type: "string",
        description: "Path to the large text file (scope-checked). Preferred over text.",
      },
      text: {
        type: "string",
        description: "Inline text. Use only when a file path is not available.",
      },
      chunk_chars: {
        type: "number",
        description: "Approximate chunk size in chars (default 12000).",
      },
      max_parallel: {
        type: "number",
        description: "Max parallel chunk queries (default from config.subagent.maxParallelChunkQueries).",
      },
      synthesize: {
        type: "boolean",
        description: "Run a final synthesis call over chunk answers (default true).",
      },
    },
    required: ["query"],
  },
  handler: async (ctx: ToolContext, args) => {
    const query = String(args.query || "");
    const inputPath = args.input_path ? String(args.input_path) : undefined;
    const text = args.text ? String(args.text) : undefined;

    if (!query) return { success: false, output: t("tool.chunk_query_no_query") };
    if (!inputPath && !text) return { success: false, output: t("tool.chunk_query_no_input") };

    let content = text || "";
    if (inputPath) {
      const check = isPathInScope(ctx.baseDir, inputPath, ctx.scope);
      if (!check.allowed) {
        return { success: false, output: `[SCOPE] ${check.reason || "Path not allowed"}` };
      }
      try {
        content = readFileSync(inputPath, "utf8");
      } catch (e: any) {
        return { success: false, output: `Cannot read ${inputPath}: ${e.message}` };
      }
    }

    if (!ctx.llmProvider) {
      return { success: false, output: "chunk_query: missing llmProvider in context" };
    }

    const maxParallel =
      typeof args.max_parallel === "number"
        ? args.max_parallel
        : ctx.config.subagent?.maxParallelChunkQueries ?? 4;

    const res = await runChunkQuery(ctx.llmProvider, content, query, {
      chunkChars: typeof args.chunk_chars === "number" ? args.chunk_chars : undefined,
      maxParallel,
      synthesize: typeof args.synthesize === "boolean" ? args.synthesize : undefined,
    });

    return {
      success: true,
      output: `[chunk_query] ${res.chunks} chunk(s), ${res.totalChars} chars, max parallel ${res.maxParallelObserved}\n\n${res.synthesis || res.answers.join("\n")}`,
    };
  },
};
```

Add i18n keys:

```jsonc
// src/i18n/en.json — under "tool"
"tool.chunk_query_no_query": "chunk_query: a query string is required.",
"tool.chunk_query_no_input": "chunk_query: provide input_path or text."
```

```jsonc
// src/i18n/ru.json — under "tool"
"tool.chunk_query_no_query": "chunk_query: требуется строка запроса.",
"tool.chunk_query_no_input": "chunk_query: укажите input_path или text."
```

- [x] **Step 4: Run it to verify it passes**

Run: `bun test tests/tools/chunk-query.test.ts tests/i18n.test.ts`
Expected: PASS — 4 tool tests + i18n parity.

- [x] **Step 5: Commit**

```bash
git add src/tools/chunk-query.ts tests/tools/chunk-query.test.ts src/i18n/en.json src/i18n/ru.json
git commit -m "feat(tools): chunk_query — parallel chunked queries over oversized inputs"
```

---

## Task 9: Register the tool

**Files:**

- Modify: `src/tools/index.ts`

- [x] **Step 1: Add import and registration**

In `src/tools/index.ts`:

1. Add the import next to the other tool imports (alphabetical, after `bashTool`/`subagentTool`):

```ts
import { chunkQueryTool } from "./chunk-query";
```

1. Add it to the `tools` array in `registerAllTools` (after `subagentTool` so it survives the tag-filtering path):

```ts
    bashTool,
    subagentTool,
    chunkQueryTool,
```

- [x] **Step 2: Verify with the existing tool tests**

Run: `bun test tests/registry.test.ts tests/tools/filter-tools.test.ts tests/executor.test.ts`
Expected: PASS — `chunk_query` appears in `registry.list()`, has `research`/`code` tags, and is filtered correctly by `filterToolsByTags`.

- [x] **Step 3: Full verification**

Run: `bun test` and `tsc --noEmit`
Expected: full suite green, no new errors.

- [x] **Step 4: Smoke test (manual)**

Run: `bun run mma "Прочитай docs/specs/2025-07-28-mma-v2-design.md и ответь, какие инструменты имеет MMA. Если файл слишком большой — используй chunk_query." --no-agents-md --exit-on-complete -d _testing/rlm-smoke`
Expected: agent either uses `read_file` or picks `chunk_query`; exit code 0; check `bun run mma session show <id>` for a clean run.

- [x] **Step 5: Commit**

```bash
git add src/tools/index.ts
git commit -m "feat(tools): register chunk_query tool"
```

---

## Optional follow-up (not in this plan)

- **REPL-style exploration tool** (`context` variable + `print(slice)` + truncation at the scaffold layer): real RLM fidelity, but a separate subsystem; needs its own plan if wanted.
- **Post-training data generation**: export sub-agent trajectories from `session.jsonl` into an SFT/DPO dataset — the paper's biggest win (+28.3%) but outside the codebase.

---

## Self-Review Checklist

**1. Spec coverage:**

- Pass-by-reference: Tasks 1, 3, 4 (store, tool param, MoE integration). ✅
- KV-cache-friendly stable prompt: Task 5. ✅
- Few-shot workflow block: Task 6. ✅
- Chunked oversized-input processing (llm_query semantics): Tasks 7, 8, 9. ✅
- Backward compatibility: `resultMode: "text"` default (Task 2), `stableSystemPrompt` conditional preserves old behavior (Task 5). ✅
- i18n rule #8: every new user-facing string has en+ru keys (Tasks 3, 8), parity test referenced. ✅

**2. Placeholder scan:** No TBD/TODO/"add validation" placeholders — all steps carry real code, exact paths, exact commands with expected output. ✅

**3. Type consistency:**

- `SubagentConfig` fields used identically in Tasks 2, 3, 5, 7, 8: `resultMode`, `maxSummaryChars`, `artifactsDir`, `stableSystemPrompt`, `maxParallelChunkQueries`. ✅
- `ArtifactStore` API: `constructor({baseDir, sessionId, artifactsDir?})`, `save(name, content, ext?)`, `read(path)`, `summary(content, maxChars)`, static `sanitizeName(name)` — used consistently in Tasks 1, 3, 4. ✅
- `runChunkQuery(provider, text, query, opts)` returns `{chunks, answers, synthesis, totalChars, maxParallelObserved}` — Tasks 7 and 8 use identical field names (`chunk_chars`/`chunkChars` mapping is explicit). ✅
- `SubtaskResult` fields `summary`/`result` semantics preserved in Task 4 (`summary` = bounded, `result` = full content for Router). ✅

---

## Execution Handoff

After the design is approved, two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration on the 9-task plan.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach do you prefer?
