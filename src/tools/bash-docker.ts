/**
 * Sandbox-исполнение bash (P0 изоляция, спека `2026-11-09-execution-sandbox-design.md`):
 * команда запускается в жёстком Docker-контейнере, deny-by-default egress.
 * Чистые функции (argv + preflight) тестируются оффлайн; сам запуск — только
 * при профиле `execution.profile === "sandbox"`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type { ToolContext } from "./types";

export const DEFAULT_SANDBOX_IMAGE = "oven/bun:1.3.14";
const DOCKER_TIMEOUT_MS = 120_000;

/** Путь внутри контейнера для монтирования baseDir. */
export const SANDBOX_WORKDIR = "/work";

/** Чистая сборка argv docker run (тестируемый контракт, без спавна). */
export function buildDockerRunArgs(opts: {
  image: string;
  baseDir: string;
  workdir: string;
  command: string;
}): string[] {
  const { image, baseDir, workdir, command } = opts;
  // POSIX-путь внутри контейнера (на Windows baseDir — C:\…, в mount он
  // доступен как /work; относительный workdir маппится внутрь него).
  const rel = resolve(workdir).startsWith(resolve(baseDir))
    ? resolve(workdir)
        .slice(resolve(baseDir).length)
        .replace(/^[\\/]+/, "")
        .replace(/\\/g, "/")
    : "";
  const innerWorkdir = rel ? `${SANDBOX_WORKDIR}/${rel}` : SANDBOX_WORKDIR;
  return [
    "run", "--rm",
    "--read-only",
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges=true",
    "-u", "1000:1000",
    "-v", `${baseDir}:${SANDBOX_WORKDIR}`,
    "--workdir", innerWorkdir,
    "-e", "HOME=/work",
    "--entrypoint", "bash",
    image,
    "-lc", command,
  ];
}

/** Есть ли docker CLI (лениво, без спавна при local-trusted). */
export function dockerAvailable(): boolean {
  const res = spawnSync("docker", ["--version"], { timeout: 3000, windowsHide: true });
  return !res.error;
}

export interface DockerRunResult {
  success: boolean;
  output: string;
}

const MAX_OUTPUT_CHARS = 200_000;

/**
 * Запуск команды в контейнере: stdout+stderr вместе, cap вывода,
 * abort/timeout убивают контейнер (SIGKILL) и дают честный провал.
 */
export function runDockerBash(opts: {
  command: string;
  workdir: string;
  baseDir: string;
  image: string;
  signal?: AbortSignal;
}): Promise<DockerRunResult> {
  return new Promise((resolve) => {
    const args = buildDockerRunArgs(opts);
    let child: ChildProcess;
    try {
      child = spawn("docker", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({
        success: false,
        output: `[sandbox] docker spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let out = "";
    const clip = (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > MAX_OUTPUT_CHARS) out = out.slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout?.on("data", clip);
    child.stderr?.on("data", clip);

    const finish = (success: boolean, text: string) => {
      resolve({ success, output: text });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, `[sandbox] docker run timed out after ${DOCKER_TIMEOUT_MS}ms\n${out}`);
    }, DOCKER_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      finish(false, `[sandbox] docker run error: ${err instanceof Error ? err.message : String(err)}\n${out}`);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) finish(true, out);
      else finish(false, out || `[sandbox] docker run exited with code ${code}`);
    });

    const onAbort = () => child.kill("SIGKILL");
    if (opts.signal) {
      if (opts.signal.aborted) {
        child.kill("SIGKILL");
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

/**
 * Fail-closed preflight: вернул {ok:false} при недоступном docker.
 * Дёргается только в sandbox-профиле (local-trusted — вызовов нет).
 */
export function checkSandboxProfile(ctx: ToolContext): { ok: boolean; image: string } {
  const image = ctx.config.execution?.image ?? DEFAULT_SANDBOX_IMAGE;
  if (ctx.config.execution?.profile !== "sandbox") return { ok: true, image };
  return { ok: dockerAvailable(), image };
}
