// Прогон сценариев сертификации: песочница на повтор, запуск MMA, проверки.
import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readdirSync, readFileSync, } from "fs";
import { join, resolve, dirname, relative } from "path";
import { checkSandbox } from "./fact-checker";
import type { CertScenario, ScenarioResult } from "./types";
import type { AppConfig } from "../../config/types";
import { killTree } from "../processes/kill-tree";
import { toForwardSlash } from "../../tools/path-utils";
import { projectMmaDir } from "../../config/paths";

/** Итог одного запуска MMA в песочнице: код выхода, вывод, был ли таймаут. */
export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Запуск одного повтора сценария (инжект для тестов). */
export type RepRunner = (env: NodeJS.ProcessEnv, cwd: string, args: string[], timeoutMs: number) => Promise<SpawnResult>

/** Опции прогона сценария: модель, песочница, повторы, порог, раннер. */
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
  baseConfig?: AppConfig;
  onRep?: (id: string, rep: number, reps: number, passed: boolean, failures: string[]) => void;
}

/**
 * Прогоняет сценарий N повторов в изолированных песочницах.
 * `pass`, когда прошли не меньше порога; при провале прикладывает диагностику.
 */
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
  const timeoutMs = scenario.timeoutMs ?? opts.timeoutMs ?? 300_000;
  const entryPoint = resolveMmaEntry(opts.mmaRoot);

  let passed = 0;
  let firstError: string | undefined;
  let lastFailedSandbox: string | undefined;

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

      // Пишем cert-конфиг, если сценарий объявил оверрайды
      if (scenario.config && opts.baseConfig) {
        const merged = deepMergeAny(opts.baseConfig, scenario.config);
        const certConfigDir = projectMmaDir(sandbox);
        mkdirSync(certConfigDir, { recursive: true });
        writeFileSync(join(certConfigDir, "config.json"), JSON.stringify(merged, null, 2), "utf-8");
        env.MMA_CONFIG_DIR = certConfigDir;
      }

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
    else {
      if (!firstError) firstError = failures.join("; ");
      lastFailedSandbox = sandbox;
    }

    opts.onRep?.(scenario.id, i, reps, pass, failures);
  }

  const status = passed >= threshold ? "pass" : "fail";
  const diagnostics = status === "fail" && lastFailedSandbox
    ? collectDiagnostics(lastFailedSandbox)
    : undefined;

  return {
    id: scenario.id,
    title: scenario.title,
    status,
    passed,
    of: reps,
    error: status === "pass" ? undefined : firstError,
    diagnostics,
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

/** Собирает диагностику из проваленной песочницы для понятного фидбэка. */
export function collectDiagnostics(sandbox: string): string {
  const lines: string[] = [];

  // Список созданных пользователем файлов (внутренности .mma пропускаем)
  const files = listFiles(sandbox, sandbox);
  if (files.length > 0) {
    lines.push(`  Files created: ${files.join(", ")}`);
  } else {
    lines.push("  Files created: (none)");
  }

  // Читаем активный план, если есть
  const planPath = join(projectMmaDir(sandbox), "plans", "active.json");
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, "utf-8"));
      const steps = plan.steps ?? [];
      const done = steps.filter((s: any) => s.status === "done").length;
      const pending = steps.filter((s: any) => s.status === "pending" || s.status === "in_progress");
      lines.push(`  Plan: ${done}/${steps.length} steps done`);
      if (pending.length > 0) {
        lines.push(`  Pending: ${pending.map((s: any) => `#${s.id} ${s.description}`).join("; ")}`);
      }
    } catch {
      /* битый план — пропускаем */
    }
  }

  return lines.join("\n");
}

function listFiles(dir: string, root: string): string[] {
  const result: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".mma") continue;
      const abs = join(dir, entry.name);
      const rel = toForwardSlash(relative(root, abs));
      if (entry.isDirectory()) {
        result.push(...listFiles(abs, root));
      } else {
        result.push(rel);
      }
    }
  } catch {
    /* ignore */
  }
  return result;
}

/** Резолвит точку входа MMA: исходники в dev-дереве, иначе собранный бандл. */
export function resolveMmaEntry(mmaRoot: string): string {
  const dev = join(mmaRoot, "src", "cli", "main.ts");
  if (existsSync(dev)) return dev;
  return join(mmaRoot, "dist", "main.js");
}

/** Ищет корень MMA вверх от каталога (по package.json). */
export function findMmaRoot(fromDir: string): string {
  const candidates = [resolve(fromDir, "..", "..", ".."), resolve(fromDir, "..")];
  for (const c of candidates) {
    if (existsSync(join(c, "package.json"))) return c;
  }
  return process.cwd();
}

/** Дефолтный раннер: спавнит MMA дочерним процессом с таймаутом и киллом дерева. */
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMergeAny(target: any, source: any): any {
  if (!source || typeof source !== "object") return source;
  if (!target || typeof target !== "object") return source;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMergeAny(tv, sv);
    } else {
      result[key] = sv;
    }
  }
  return result;
}
