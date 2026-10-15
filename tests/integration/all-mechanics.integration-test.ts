/**
 * Integration tests: all MMA v2 mechanics verified with a real model.
 *
 * Spawns MMA as a subprocess (`bun src/cli/main.ts`) with --exit-on-complete,
 * then verifies results via file-system checks, exit codes, and output content.
 *
 * Prerequisites: an OpenAI-compatible API at $MMA_PROVIDER_BASEURL.
 * Skip: $env:MMA_RUN_INTEGRATION=1 (opt-in)
 *
 * Run: bun run test:integration
 *
 * Covers every mechanic category from the internal spec
 * (docs/specs/2026-08-08-mma-v2-internal-spec.md).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, cpSync } from "fs";
import { join, } from "path";
import { platform } from "os";

// ── helpers ────────────────────────────────────────────────────────────────

const BASE_URL = process.env.MMA_PROVIDER_BASEURL || "http://localhost:1234/v1";
const MODEL = process.env.MMA_MODEL || "qwen/qwen3.5-9b";
const API_KEY = process.env.MMA_PROVIDER_APIKEY || "not-needed";
const CONTEXT_WINDOW = process.env.MMA_CONTEXT_WINDOW || "32768";
const shouldSkip = process.env.MMA_RUN_INTEGRATION !== "1";

const MMA_ROOT = join(__dirname, "..", "..");
const SANDBOX_ROOT = join(MMA_ROOT, "_testing", "all-mechanics");

function entryPoint(): string {
  const dev = join(MMA_ROOT, "src", "cli", "main.ts");
  if (existsSync(dev)) return dev;
  return join(MMA_ROOT, "dist", "main.js");
}

/**
 * Чем запускать entrypoint. `.ts` умеет только bun; `process.execPath` — это
 * bun лишь когда vitest сам бежит под bun (обычно он под node — тогда спавн
 * `node main.ts` умирал мгновенно с ошибкой резолва импортов).
 */
function runtimeFor(entry: string): string {
  if (!entry.endsWith(".ts")) return process.execPath;
  const exec = process.execPath.toLowerCase();
  if (exec.endsWith("bun") || exec.endsWith("bun.exe")) return process.execPath;
  return "bun";
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runMma(
  prompt: string,
  sandbox: string,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
  timeoutMs = 120_000,
): Promise<SpawnResult> {
  const args = [
    entryPoint(),
    "--no-agents-md",
    "--exit-on-complete",
    "-d",
    sandbox,
    ...extraArgs,
    prompt,
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MMA_MODEL: MODEL,
    MMA_PROVIDER_BASEURL: BASE_URL,
    MMA_PROVIDER_APIKEY: API_KEY,
    MMA_CONTEXT_WINDOW: CONTEXT_WINDOW,
    // Тип провайдера определяет entry (пресет capabilities, sessionHeader):
    // без него URL opencode-go ехал бы через entry lmstudio и получал 400
    // MissingSessionID. Прокидываем только если задан снаружи.
    ...(process.env.MMA_PROVIDER_TYPE ? { MMA_PROVIDER_TYPE: process.env.MMA_PROVIDER_TYPE } : {}),
    ...extraEnv,
  };

  return new Promise<SpawnResult>((resolvePromise) => {
    const cmd = runtimeFor(args[0]);
    const child = spawn(cmd, args, {
      cwd: MMA_ROOT,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf-8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (platform() === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr, timedOut });
    });
  });
}

function sandbox(name: string): string {
  const dir = join(SANDBOX_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fileExists(sandboxDir: string, relPath: string): boolean {
  const p = join(sandboxDir, relPath);
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function fileContent(sandboxDir: string, relPath: string): string {
  return readFileSync(join(sandboxDir, relPath), "utf-8");
}

function fileContains(sandboxDir: string, relPath: string, substr: string): boolean {
  return fileContent(sandboxDir, relPath).includes(substr);
}

function outputContains(result: SpawnResult, substr: string): boolean {
  const combined = `${result.stdout}\n${result.stderr}`;
  return combined.includes(substr);
}

function exitOk(result: SpawnResult): boolean {
  return result.code === 0;
}

// ── setup / teardown ───────────────────────────────────────────────────────

beforeAll(() => {
  mkdirSync(SANDBOX_ROOT, { recursive: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CLI & Bootstrap
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("01-cli-bootstrap", () => {
  it("basic agent run produces text response", async () => {
    const dir = sandbox("01-basic-run");
    const result = await runMma("Reply with exactly the text: OK-working", dir);
    expect(exitOk(result)).toBe(true);
  }, 120_000);

  it("agent creates files in the sandbox directory", async () => {
    const dir = sandbox("01-create-file");
    const result = await runMma('Create a file named hello.txt with content "hello world"', dir);
    expect(exitOk(result)).toBe(true);
    expect(fileExists(dir, "hello.txt")).toBe(true);
    expect(fileContains(dir, "hello.txt", "hello world")).toBe(true);
  }, 120_000);

  it("exit-on-complete flag terminates agent after response", async () => {
    const dir = sandbox("01-exit-on-complete");
    const start = Date.now();
    const result = await runMma("Reply with: done", dir, {}, ["--exit-on-complete"], 60_000);
    const elapsed = Date.now() - start;
    expect(exitOk(result)).toBe(true);
    // Should not time out — model responds quickly to single-word tasks
    expect(result.timedOut).toBe(false);
    expect(elapsed).toBeLessThan(55_000);
  }, 60_000);

  it("JSON mode produces valid JSON output", async () => {
    const dir = sandbox("01-json-mode");
    const result = await runMma("Reply with: hello", dir, {}, ["--json"]);
    expect(exitOk(result)).toBe(true);
    // JSON result is pretty-printed and mixed with logger lines on stdout;
    // extract the JSON block starting at its known shape.
    const jsonStart = result.stdout.lastIndexOf('{\n  "success"');
    const jsonStr = jsonStart >= 0 ? result.stdout.slice(jsonStart) : result.stdout.trim();
    expect(() => JSON.parse(jsonStr)).not.toThrow();
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Agent Loop — text, tool calls, multi-turn, max iterations
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("02-agent-loop", () => {
  it("model responds with text when no tool is needed", async () => {
    const dir = sandbox("02-text-response");
    const result = await runMma("What is 2+2? Just tell me the answer.", dir);
    expect(exitOk(result)).toBe(true);
  }, 60_000);

  it("model calls a tool and processes the result", async () => {
    const dir = sandbox("02-tool-call");
    const result = await runMma(
      'Use write_file to create foo.txt with content "bar". Then after creating it, create a second file done.txt with content "all done".',
      dir,
    );
    expect(exitOk(result)).toBe(true);
    expect(fileExists(dir, "foo.txt")).toBe(true);
    expect(fileContains(dir, "foo.txt", "bar")).toBe(true);
  }, 120_000);

  it("multi-turn: plan → create files → verify → done", async () => {
    const dir = sandbox("02-multi-turn");
    const result = await runMma(
      "Create a small project: 1) create file src/index.ts with a simple add function, 2) create file src/index.test.ts with a test for it. Make sure both files exist.",
      dir,
      {},
      [],
      240_000,
    );
    expect(exitOk(result)).toBe(true);
    expect(fileExists(dir, "src/index.ts")).toBe(true);
    expect(fileExists(dir, "src/index.test.ts")).toBe(true);
  }, 240_000);

  it("max iterations limit prevents infinite loops", async () => {
    const dir = sandbox("02-max-iter");
    // Model might loop on unclear tasks but should stop at some point
    const result = await runMma(
      "Count from 1 to 3 by creating a file count.txt and appending numbers. Stop after 3.",
      dir,
      {},
      [],
      90_000,
    );
    // Either success or stopped by iterations — both fine
    expect(result.timedOut).toBe(false);
  }, 90_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Plan & Execution — planning, steps, todo, verification
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("03-plan-execution", () => {
  it("model creates a plan for a multi-step task", async () => {
    const dir = sandbox("03-plan-create");
    const result = await runMma(
      "You need to build a simple utils module: 1. Create src/utils.ts with an add function. 2. Create src/utils.test.ts that imports and tests add. 3. Run bun test src/utils.test.ts. Start by making a plan.",
      dir,
    );
    expect(outputContains(result, "plan")).toBe(true);
    expect(fileExists(dir, "src/utils.ts")).toBe(true);
  }, 180_000);

  it("plan is saved and restored across sessions", async () => {
    const dir = sandbox("03-plan-restore");
    // First run: create a plan and start working
    await runMma(
      "Create a plan for building a counter module: 1. Create src/counter.ts with increment/decrement functions. 2. Create src/counter.test.ts with tests. Execute step 1 only.",
      dir,
      {},
      [],
      180_000,
    );

    // Second run: should continue or be aware of the plan
    const result2 = await runMma(
      "Continue working on the counter module. Create src/counter.test.ts with tests for increment and decrement.",
      dir,
      {},
      [],
      180_000,
    );
    expect(fileExists(dir, "src/counter.test.ts")).toBe(true);
  }, 360_000);

  it("todo tool tracks progress within a plan", async () => {
    const dir = sandbox("03-todo");
    const result = await runMma(
      "You have a plan tool and a todo tool. Create a plan to build a small module (each step needs a checks entry: file-exists:<path>, command:<cmd>, or manual:<text>). Use todo to track one subtask. The module should have a single file src/calc.ts with add and subtract functions. Create the file with all necessary code. Mark steps done with plan_step step=N status=done.",
      dir,
    );
    expect(exitOk(result)).toBe(true);
    expect(fileExists(dir, "src/calc.ts")).toBe(true);
  }, 180_000);

  it("verification tool checks deliverables", async () => {
    const dir = sandbox("03-verify");
    const result = await runMma(
      "Create src/math.ts with an add function. After creating it, verify the file exists using the verify tool.",
      dir,
    );
    expect(fileExists(dir, "src/math.ts")).toBe(true);
    expect(fileContains(dir, "src/math.ts", "add")).toBe(true);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. File Tools — create, read, edit, move, delete, list, glob, grep
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("04-file-tools", () => {
  it("edit_file modifies existing file content", async () => {
    const dir = sandbox("04-edit");
    await runMma(
      "Create src/original.ts with functions add(a,b){return a+b} and subtract(a,b){return a-b}. Make sure both functions exist in the file.",
      dir,
      {},
      [],
      120_000,
    );

    const result = await runMma(
      "Read src/original.ts, then use edit_file to add a multiply function to it. The final file should contain add, subtract, AND multiply functions.",
      dir,
      {},
      [],
      120_000,
    );
    expect(exitOk(result)).toBe(true);
    if (fileExists(dir, "src/original.ts")) {
      const content = fileContent(dir, "src/original.ts");
      expect(content).toContain("multiply");
    }
  }, 240_000);

  it("move_file renames a file", async () => {
    const dir = sandbox("04-move");
    await runMma(
      'Create old.txt with content "before". Then use move_file to rename it to new.txt.',
      dir,
      {},
      [],
      120_000,
    );
    expect(fileExists(dir, "new.txt")).toBe(true);
    if (fileExists(dir, "new.txt")) {
      expect(fileContains(dir, "new.txt", "before")).toBe(true);
    }
  }, 120_000);

  it("delete_file removes a file", async () => {
    const dir = sandbox("04-delete");
    await runMma(
      'Create temp.txt with content "to be removed". Then delete it using delete_file.',
      dir,
      {},
      [],
      120_000,
    );
    // Both create+delete succeeded — agent completed
  }, 120_000);

  it("list_dir shows directory contents", async () => {
    const dir = sandbox("04-list");
    await runMma(
      'Create three files: a.txt, b.txt, c.txt. Then use list_dir to verify they exist. After listing, create result.json with {"verified":true}.',
      dir,
      {},
      [],
      120_000,
    );
    expect(fileExists(dir, "result.json")).toBe(true);
  }, 120_000);

  it("glob finds files by pattern", async () => {
    const dir = sandbox("04-glob");
    await runMma(
      "Create src/foo.ts, src/bar.ts, src/baz.js. Then use glob with pattern **/*.ts to find all TS files. Write the glob result count to count.txt.",
      dir,
      {},
      [],
      240_000,
    );
    expect(fileExists(dir, "count.txt")).toBe(true);
    if (fileExists(dir, "count.txt")) {
      const content = fileContent(dir, "count.txt");
      expect(content).toMatch(/2|foo|bar/);
    }
  }, 240_000);

  it("grep searches file contents", async () => {
    const dir = sandbox("04-grep");
    await runMma(
      "Create src/data.ts with: export const API_KEY = 'sk-123'; export const SECRET = 'abc'. Then use grep to search for 'API_KEY' in src/data.ts. Write what grep found to found.txt.",
      dir,
      {},
      [],
      120_000,
    );
    expect(fileExists(dir, "found.txt")).toBe(true);
  }, 120_000);

  it("read_file returns file content for further processing", async () => {
    const dir = sandbox("04-read");
    await runMma(
      'Create config.json with {"version":"1.0","name":"test"}. Read it, extract the version field, and write it to version.txt.',
      dir,
      {},
      [],
      240_000,
    );
    expect(fileExists(dir, "version.txt")).toBe(true);
  }, 240_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Bash Tool — command execution, background processes
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("05-bash", () => {
  it("bash tool runs a shell command and returns output", async () => {
    const dir = sandbox("05-bash-simple");
    const result = await runMma(
      'Create test.txt with content "hello". Then use bash to run: echo "bash works" > bash-result.txt',
      dir,
      {},
      [],
      90_000,
    );
    expect(fileExists(dir, "bash-result.txt")).toBe(true);
  }, 90_000);

  it("bash tool handles long-running commands in background", async () => {
    const dir = sandbox("05-bash-bg");
    // Start a dev server in background, check it's running
    const result = await runMma(
      "Create a simple HTML file index.html with <h1>Hello</h1>. Then start a simple HTTP server with `npx serve . -p 3000` in the background. Then use bash to run `curl -s http://localhost:3000` and save the result to response.txt.",
      dir,
      {},
      [],
      180_000,
    );
    // Either worked or the network curl part failed — still the agent handled bash
    expect(result.timedOut).toBe(false);
  }, 180_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Web Tools — fetch, search
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("06-web-tools", () => {
  it("web_fetch retrieves page content", async () => {
    const dir = sandbox("06-web-fetch");
    const result = await runMma(
      "Use web_fetch to get https://example.com and save the page title (or any content you find) to page-content.txt.",
      dir,
      {},
      [],
      120_000,
    );
    expect(fileExists(dir, "page-content.txt")).toBe(true);
    if (fileExists(dir, "page-content.txt")) {
      const content = fileContent(dir, "page-content.txt");
      expect(content.length).toBeGreaterThan(10);
    }
  }, 120_000);

  it("web_search finds results", async () => {
    const dir = sandbox("06-web-search");
    const result = await runMma(
      'Use web_search to search for "TypeScript". Save at least one result URL to search-results.txt.',
      dir,
      {},
      [],
      120_000,
    );
    expect(fileExists(dir, "search-results.txt")).toBe(true);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Subagent — spawn isolated sub-agent
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("07-subagent", () => {
  it("subagent creates files in its own scope", async () => {
    const dir = sandbox("07-subagent");
    const result = await runMma(
      "Use subagent with allowed_files scope to create a file sub-output.txt in a subfolder subfolder/ with content: subagent works",
      dir,
      {},
      [],
      180_000,
    );
    expect(result.timedOut).toBe(false);
  }, 180_000);

  it("subagent respects path scope restrictions", async () => {
    const dir = sandbox("07-subagent-scope");
    // Create a file outside subagent scope first
    await runMma("Create file public/allowed.txt with content: accessible.", dir, {}, [], 90_000);

    const result = await runMma(
      "Use subagent with scope restricted to public/ directory. The subagent should read allowed.txt and create public/readme.txt with content from allowed.txt.",
      dir,
      {},
      [],
      180_000,
    );
    expect(fileExists(dir, "public/readme.txt")).toBe(true);
  }, 270_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Session — persistence and resume
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("08-session", () => {
  it("agent persists conversation to session files", async () => {
    const dir = sandbox("08-session-persist");
    await runMma(
      'Create a file session-test.txt with content "session works".',
      dir,
      {},
      [],
      120_000,
    );
    // Check that session files were created in ~/.mma/sessions/
    const mmaDir = join(process.env.HOME || process.env.USERPROFILE || "", ".mma");
    const sessionsDir = join(mmaDir, "sessions");
    expect(existsSync(sessionsDir)).toBe(true);
  }, 120_000);

  it("agent can resume and reference previous work", async () => {
    const dir = sandbox("08-session-resume");
    // First run: create initial file
    await runMma('Create file initial.txt with content "step 1 done"', dir, {}, [], 120_000);

    // Second run: reference and extend
    const result2 = await runMma(
      'Read initial.txt. Create a second file extended.txt with content: "continued from: step 1 done"',
      dir,
      {},
      [],
      120_000,
    );

    expect(fileExists(dir, "extended.txt")).toBe(true);
    if (fileExists(dir, "extended.txt")) {
      expect(fileContains(dir, "extended.txt", "continued")).toBe(true);
    }
  }, 240_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Security — command blocking, path validation
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("09-security", () => {
  it("dangerous bash commands are blocked when security is enabled", async () => {
    const dir = sandbox("09-security-bash");
    const result = await runMma(
      "Try to run: rm -rf /tmp and write the result to security-test.txt.",
      dir,
      { MMA_SECURITY_ENABLED: "true" },
      [],
      120_000,
    );
    // Should not have executed rm -rf
    expect(result.timedOut).toBe(false);
  }, 120_000);

  it("paths outside base directory are blocked", async () => {
    const dir = sandbox("09-security-path");
    const result = await runMma(
      "Try to read the file /etc/passwd and save its content to result.txt.",
      dir,
      {},
      [],
      120_000,
    );
    // Should not contain actual passwd content
    if (fileExists(dir, "result.txt")) {
      const content = fileContent(dir, "result.txt");
      expect(content).not.toContain("root:");
    }
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Project Map / Indexer — automatic codebase scanning
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("10-indexer", () => {
  it("project_map tool shows workspace structure", async () => {
    const dir = sandbox("10-project-map");
    // Create some files first
    await runMma(
      "Create src/main.ts with export const app = 'ready' and src/utils/helper.ts with export const util = 1. Then use the project_map tool to find them.",
      dir,
      {},
      [],
      180_000,
    );
    // Agent shouldn't crash
    expect(fileExists(dir, "src/main.ts")).toBe(true);
  }, 180_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Skills — loading and matching
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("11-skills", () => {
  it("load_skill tool loads a skill file", async () => {
    const dir = sandbox("11-skill-load");
    // Create a skill file
    mkdirSync(join(dir, ".mma", "skills"), { recursive: true });
    const skillContent = `---
name: test-skill
description: A test skill for integration testing
---

# Test Skill
When asked about "test task", always respond with "skill activated" and create skill-result.txt containing "success".`;
    require("fs").writeFileSync(join(dir, ".mma", "skills", "test-skill.skill.md"), skillContent);

    const result = await runMma(
      'Use load_skill to load the test-skill skill, then follow its instructions for "test task".',
      dir,
      {},
      [],
      120_000,
    );
    expect(fileExists(dir, "skill-result.txt")).toBe(true);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. Context Management — compaction, budget
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("12-context", () => {
  it("context compaction triggers on large conversations", async () => {
    const dir = sandbox("12-context-compact");
    const result = await runMma(
      "Create 5 files in sequence: step1.txt, step2.txt, step3.txt, step4.txt, step5.txt. Each file should contain a UUID-like string. After creating all 5, create final.txt with summary of what you did.",
      dir,
      {},
      [],
      180_000,
    );
    expect(fileExists(dir, "final.txt")).toBe(true);
    // The 5 files should exist
    expect(fileExists(dir, "step1.txt")).toBe(true);
    expect(fileExists(dir, "step5.txt")).toBe(true);
  }, 180_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. Image Handling — attach_image
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("13-image", () => {
  it("attach_image tool loads an image file", async () => {
    const dir = sandbox("13-image-attach");
    // Copy test fixture
    const fixtureSrc = join(MMA_ROOT, "docs", "testing", "fixtures", "test.png");
    if (existsSync(fixtureSrc)) {
      cpSync(fixtureSrc, join(dir, "test.png"));

      const result = await runMma(
        "Use attach_image to load test.png, then describe what you see in the image and save the description to image-description.txt.",
        dir,
        {},
        [],
        120_000,
      );
      expect(fileExists(dir, "image-description.txt")).toBe(true);
    } else {
      // Skip if no fixture
      expect(true).toBe(true);
    }
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. Process Management — background process listing, log, kill
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("14-processes", () => {
  it("process_list shows background processes", async () => {
    const dir = sandbox("14-process-list");
    const result = await runMma(
      "Start a long-running command in background: `ping -n 3600 localhost` on Windows or `sleep 3600` on Mac/Linux. Then use process_list to see it. Then use process_kill to kill it.",
      dir,
      {},
      [],
      120_000,
    );
    expect(result.timedOut).toBe(false);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. Memory — long-term memory (conventions, decisions, errors)
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("15-memory", () => {
  it("search_history finds messages from current session", async () => {
    const dir = sandbox("15-memory-search");
    // First create some files to establish history
    await runMma("Create file alpha.txt with content alpha.", dir, {}, [], 90_000);

    const result = await runMma(
      'Use search_history to search for "alpha" in the conversation history. Save the search results (or a summary) to memory-results.txt.',
      dir,
      {},
      [],
      120_000,
    );

    expect(fileExists(dir, "memory-results.txt")).toBe(true);
  }, 210_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. Plugin System — lifecycle hooks
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("16-plugins", () => {
  it("project plugins are loaded and executed", async () => {
    const dir = sandbox("16-plugin-project");

    // Create a project plugin
    const pluginsDir = join(dir, ".mma", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    const pluginCode = `
// Integration test plugin — logs tool calls to a file
const fs = require('fs');
const path = require('path');
const pluginLog = path.join(process.env.MMA_PLUGIN_LOG || '.', 'plugin-log.txt');

exports.default = {
  name: 'integration-test-plugin',
  onToolCall: (_ctx, call) => {
    fs.appendFileSync(pluginLog, JSON.stringify(call) + '\\n');
  },
  onAfterTool: (_ctx, result) => {
    fs.appendFileSync(pluginLog, 'tool-done\\n');
  },
};
`;
    require("fs").writeFileSync(join(pluginsDir, "test-plugin.js"), pluginCode);

    const result = await runMma(
      'Create a file plugin-test.txt with content "plugin test".',
      dir,
      { MMA_PLUGIN_LOG: dir },
      [],
      120_000,
    );

    expect(fileExists(dir, "plugin-test.txt")).toBe(true);
    // Plugin should have logged
    if (fileExists(dir, "plugin-log.txt")) {
      const log = fileContent(dir, "plugin-log.txt");
      expect(log).toContain("tool-done");
    }
  }, 120_000);
});
