// Встроенные сценарии сертификации — многошаговые воркфлоу.
// Данные вынесены из `scenarios.ts` (правило ≤300), порядок сохранён.
import type { ScenarioDef } from "./scenarios-def";

export const WORKFLOW_SCENARIOS: ScenarioDef[] = [
  {
    id: "3.1-calculator",
    title: "Multi-step calculator module",
    tags: ["core"],
    mode: "run",
    prompt:
      "Create a simple calculator module: 1. Create src/calculator.ts with functions add, subtract, multiply, divide. 2. Create src/calculator.test.ts with a basic test for each function. 3. Run the tests with bun test src/calculator.test.ts",
    checks: [
      { type: "fileExists", path: "src/calculator.ts" },
      { type: "fileExists", path: "src/calculator.test.ts" },
      {
        type: "fileContent",
        path: "src/calculator.ts",
        contains: "export function add",
      },
    ],
  },
  {
    id: "3.5-data-pipeline",
    title: "Data processing pipeline",
    tags: ["core"],
    mode: "run",
    // Рассуждающим локалкам нужно ~12 LLM-вызовов по 30-45с; работа
    // завершается корректно, но дефолтный таймаут 300с убивает процесс
    // до финального ответа (прогоны 2026-08-25: qwen3.6-35b-a3b).
    timeoutMs: 600_000,
    prompt:
      "Create a data processing script: 1. Create data/input.json with an array of 10 objects {id, name, value}. 2. Create src/process.ts that reads input, filters value > 50, writes output.json AT THE PROJECT ROOT (not inside data/). 3. Run the script and verify output.json has filtered results.",
    checks: [
      { type: "fileExists", path: "data/input.json" },
      { type: "fileExists", path: "src/process.ts" },
      { type: "fileExists", path: "output.json" },
    ],
  },
  {
    id: "3.6-bash-run",
    title: "Run bash command and capture output",
    tags: ["core"],
    mode: "run",
    prompt:
      'Run the command "echo hello-mma" using the bash tool and save the output to bash-output.txt.',
    checks: [
      { type: "fileExists", path: "bash-output.txt" },
      { type: "fileContent", path: "bash-output.txt", contains: "hello-mma" },
    ],
  },
  {
    id: "3.7-grep-search",
    title: "Search file contents with grep",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create file src/utils.ts with content: export const PI = 3.14; export const E = 2.71;. Then use the grep tool to search for "PI" in src/utils.ts and save the match to grep-result.txt.',
    checks: [
      { type: "fileExists", path: "src/utils.ts" },
      { type: "fileExists", path: "grep-result.txt" },
      { type: "fileContent", path: "grep-result.txt", contains: "PI" },
    ],
  },
  {
    id: "3.8-glob-find",
    title: "Find files with glob",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create files: src/a.ts, src/b.ts, lib/c.ts. Then use the glob tool to find all .ts files matching "src/**/*.ts" and save the file list to glob-result.txt.',
    checks: [
      { type: "fileExists", path: "src/a.ts" },
      { type: "fileExists", path: "src/b.ts" },
      { type: "fileExists", path: "glob-result.txt" },
      { type: "fileContent", path: "glob-result.txt", contains: "a.ts" },
      { type: "fileContent", path: "glob-result.txt", contains: "b.ts" },
    ],
  },
  {
    id: "3.9-multi-tool-chain",
    title: "Read → grep → edit chain",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create file app.ts with content: const DEBUG = false; export function run() { return "ok"; }. Then: 1. Use read_file to read app.ts. 2. Use grep to find "DEBUG" in app.ts. 3. Use edit_file to change DEBUG from false to true. 4. Verify the file contains DEBUG = true.',
    checks: [
      { type: "fileExists", path: "app.ts" },
      { type: "fileContent", path: "app.ts", contains: "DEBUG = true" },
    ],
  },
  {
    id: "3.10-subagent-delegate",
    title: "Delegate to subagent",
    tags: ["core"],
    mode: "run",
    prompt:
      'Use the subagent tool to create a file delegated.ts with content: export const delegated = true;. Verify the file exists after the subagent completes.',
    checks: [
      { type: "fileExists", path: "delegated.ts" },
      { type: "fileContent", path: "delegated.ts", contains: "delegated = true" },
    ],
  },
  {
    id: "3.11-plan-create-update",
    title: "Create and update a plan",
    tags: ["core"],
    mode: "run",
    prompt:
      "Create a plan with 2 steps: step 1 is to create file step1.ts (check file-exists:step1.ts), step 2 is to create file step2.ts (check file-exists:step2.ts). Then mark step 1 as done with plan_step step=1 status=done. Show the plan.",
    checks: [
      { type: "fileExists", path: "step1.ts" },
      { type: "outputContains", text: "step" },
    ],
  },
  {
    id: "1.1-question-tool",
    title: "Question tool (interactive-only)",
    tags: ["core"],
    mode: "skip",
    prompt: "",
    checks: [],
    skipReason: "question tool needs a live user; headless cert runs fail fast by design",
  },

  // ─── Plan / Execution ────────────────────────────────────────────────
  {
    id: "6.1-plan-create-execute",
    title: "Plan creation and step tracking",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create a plan with 2 steps using the plan tool: step 1 "Create file a.txt" with check "file-exists:a.txt", step 2 "Create file b.txt" with check "file-exists:b.txt". Then execute both steps: create a.txt with content "alpha" and b.txt with content "beta". Mark each step done with plan_step step=N status=done when complete.',
    checks: [
      { type: "fileExists", path: "a.txt" },
      { type: "fileExists", path: "b.txt" },
      { type: "fileContent", path: "a.txt", contains: "alpha" },
      { type: "fileContent", path: "b.txt", contains: "beta" },
    ],
  },

  // ─── Subagent ────────────────────────────────────────────────────────
  {
    id: "7.1-subagent-file",
    title: "Subagent writes file in isolated scope",
    tags: ["core"],
    mode: "run",
    prompt:
      'Use the subagent tool to create a file called subagent-output.txt with content "created by subagent". Then verify the file exists.',
    checks: [
      { type: "fileExists", path: "subagent-output.txt" },
      { type: "fileContent", path: "subagent-output.txt", contains: "created by subagent" },
    ],
  },

  // ─── Tool narrowing ──────────────────────────────────────────────────
  {
    id: "8.1-enable-tools",
    title: "Enable hidden tools on demand",
    tags: ["core"],
    mode: "run",
    prompt:
      'Use the enable_tools tool to enable the "research" tag. Then use web_search to search for "TypeScript" and save the first result title to research-result.txt.',
    checks: [
      { type: "fileExists", path: "research-result.txt" },
    ],
  },

  // ─── LSP ─────────────────────────────────────────────────────────────
  {
    id: "9.1-lsp-check",
    title: "LSP detects TypeScript errors",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create a file broken.ts with content: const x: number = "not a number";. Then use the lsp_check tool to check the file for errors. Save the result (should contain error) to lsp-result.txt.',
    checks: [
      { type: "fileExists", path: "broken.ts" },
      { type: "fileExists", path: "lsp-result.txt" },
    ],
  },
];
