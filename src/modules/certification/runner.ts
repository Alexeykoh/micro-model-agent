import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync, cpSync } from "fs";
import { platform } from "os";
import { join, resolve, dirname } from "path";
import { checkSandbox } from "./fact-checker";
import type { CertScenario, ScenarioResult } from "./types";

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RepRunner {
  (env: NodeJS.ProcessEnv, cwd: string, args: string[], timeoutMs: number): Promise<SpawnResult>;
}

export interface RunScenarioOptions {
  model: string;
  providerUrl: string;
  providerKey?: string;
  contextWindow?: number;
  mmaRoot: string;
  sandboxBase: string;
  defaultReps: number;
  defaultThreshold: number;
  timeoutMs?: number;
  runner?: RepRunner;
  onRep?: (id: string, rep: number, reps: number, passed: boolean, failures: string[]) => void;
}

export async function runScenario(
  scenario: CertScenario,
  opts: RunScenarioOptions,
): Promise<ScenarioResult> {
  if (scenario.mode === "skip") {
    return {
      id: scenario.id,
      title: scenario.title,
      status: "skipped",
      passed: 0,
      of: 0,
    };
  }

  const reps = scenario.reps ?? opts.defaultReps;
  const threshold = Math.min(scenario.passThreshold ?? opts.defaultThreshold, reps);
  const runner: RepRunner = opts.runner ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const entryPoint = resolveMmaEntry(opts.mmaRoot);

  let passed = 0;
  let firstError: string | undefined;

  for (let i = 1; i <= reps; i++) {
    const sandbox = join(opts.sandboxBase, `run-${scenario.id}-${i}`);
    let failures: string[] = [];
    let exitCode = -1;
    let output = "";

    try {
      prepareSandbox(sandbox, scenario, opts.mmaRoot);
      const args = [
        entryPoint,
        "--no-agents-md",
        "--exit-on-complete",
        "-d",
        sandbox,
        scenario.prompt,
      ];
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MMA_MODEL: opts.model,
        MMA_PROVIDER_BASEURL: opts.providerUrl,
        MMA_CONTEXT_WINDOW: String(opts.contextWindow ?? 32000),
      };
      if (opts.providerKey) env.MMA_PROVIDER_APIKEY = opts.providerKey;

      const res = await runner(env, opts.mmaRoot, args, timeoutMs);
      output = `${res.stdout}\n${res.stderr}`;
      exitCode = res.code ?? -1;

      const outcome = checkSandbox(sandbox, scenario.checks, exitCode, output);
      failures = outcome.failures;
      if (res.timedOut) failures.push(`rep ${i} timed out`);
    } catch (e: any) {
      return {
        id: scenario.id,
        title: scenario.title,
        status: "error",
        passed,
        of: reps,
        error: e.message,
      };
    }

    const pass = failures.length === 0;
    if (pass) passed++;
    else if (!firstError) firstError = failures.join("; ");

    opts.onRep?.(scenario.id, i, reps, pass, failures);
  }

  const status = passed >= threshold ? "pass" : "fail";
  return {
    id: scenario.id,
    title: scenario.title,
    status,
    passed,
    of: reps,
    error: status === "pass" ? undefined : firstError,
  };
}

function prepareSandbox(sandbox: string, scenario: CertScenario, mmaRoot: string): void {
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });
  for (const f of scenario.fixtures ?? []) {
    const src = join(mmaRoot, f.source);
    if (!existsSync(src)) {
      throw new Error(`fixture missing: ${f.source}`);
    }
    const dest = join(sandbox, f.dest);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
}

export function resolveMmaEntry(mmaRoot: string): string {
  const dev = join(mmaRoot, "src", "cli", "main.ts");
  if (existsSync(dev)) return dev;
  return join(mmaRoot, "dist", "main.js");
}

export function findMmaRoot(fromDir: string): string {
  const candidates = [resolve(fromDir, "..", "..", ".."), resolve(fromDir, "..")];
  for (const c of candidates) {
    if (existsSync(join(c, "package.json"))) return c;
  }
  return process.cwd();
}

export const defaultRunner: RepRunner = (env, cwd, args, timeoutMs) =>
  new Promise<SpawnResult>((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
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
      killTree(child);
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

function killTree(child: import("child_process").ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (platform() === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}
