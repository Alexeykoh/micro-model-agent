/**
 * Isolated e2e harness for `mma web`.
 *
 * Spawns the real CLI (`src/cli/main.ts`) as a child process with
 * `MMA_CONFIG_DIR` pointed at a temp dir, so e2e writes never touch the real
 * `~/.mma`. The seeded `config.json` makes the server boot non-virgin
 * (no first-run gate), with a dummy local provider — no network calls leave
 * the box during UI scenarios.
 *
 * Rule: run e2e only on explicit user request (Playwright + a live server are
 * slow and spawn external processes). See `docs/agents/testing.md`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../../src/config/defaults";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root (harness must spawn from here, never from a sandbox). */
export const REPO_ROOT = resolve(here, "..", "..");

/** Where scenario artifacts go (screenshots, DOM snapshots, console logs). */
export const ARTIFACTS_ROOT = join(REPO_ROOT, "_testing", "web-e2e");

export interface E2EConfig {
  /** Directory holding the isolated `config.json` (i.e. `MMA_CONFIG_DIR`). */
  dir: string;
  /** Full URL of the booted server, e.g. `http://127.0.0.1:4319`. */
  baseUrl: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
}

interface OutputLog {
  stdout(): string;
  stderr(): string;
}

function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/127\.0\.0\.1:\d+|https?:\/\/localhost:\d+/);
  return m ? m[0] : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Seed an isolated `MMA_CONFIG_DIR` with a non-virgin dummy config.
 * Pure filesystem helper — unit-tested without spawning anything.
 */
export function seedE2EConfigDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const config = structuredClone(DEFAULTS);
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  return join(dir, "config.json");
}

/** Wait until `url` answers 200 (or throw on timeout). */
export async function waitForReady(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) {
        await res.arrayBuffer().catch(() => {});
        return;
      }
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(250);
  }
  throw new Error(`server at ${url} not ready: ${String(lastErr)}`);
}

function buildWebArgs(port?: number): string[] {
  const args = ["run", "src/cli/main.ts", "web", "--host", "127.0.0.1", "--no-open"];
  if (port !== undefined) args.push("--port", String(port));
  return args;
}

/** Collect child stdout/stderr into getters (pollable while it runs). */
function attachOutput(child: ChildProcess): OutputLog {
  let out = "";
  let err = "";
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    err += d.toString();
  });
  return { stdout: () => out, stderr: () => err };
}

/** Poll the child's stdout for the printed server URL (or throw). */
async function awaitServerUrl(child: ChildProcess, log: OutputLog, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`mma web exited early (code ${child.exitCode}): ${log.stderr().slice(-2000)}`);
    }
    const url = extractUrl(log.stdout());
    if (url) return url;
    if (Date.now() > deadline) {
      throw new Error(`mma web did not print a URL in time: ${log.stderr().slice(-2000)}`);
    }
    await sleep(250);
  }
}

function persistLogs(artifactsDir: string, log: OutputLog): void {
  try {
    writeFileSync(join(artifactsDir, "server.out.log"), log.stdout());
    writeFileSync(join(artifactsDir, "server.err.log"), log.stderr());
  } catch {
    /* best-effort artifact flush */
  }
}

/**
 * Boot `mma web --no-open` in the background with an isolated config dir.
 * Logs stream into `<artifactsDir>/server.{out,err}.log`; the child's handle
 * is returned for a strict `stopE2EServer` by handle (never "kill all bun").
 */
export async function startE2EServer(opts?: {
  port?: number;
  artifactsDir?: string;
}): Promise<E2EConfig> {
  const dir = mkdtempSync(join(tmpdir(), "mma-web-e2e-"));
  seedE2EConfigDir(dir);
  const artifactsDir = opts?.artifactsDir ?? join(ARTIFACTS_ROOT, `run-${Date.now()}`);
  mkdirSync(artifactsDir, { recursive: true });

  const child = spawn("bun", buildWebArgs(opts?.port), {
    cwd: REPO_ROOT,
    env: { ...process.env, MMA_CONFIG_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = attachOutput(child);
  let baseUrl: string;
  try {
    baseUrl = await awaitServerUrl(child, log, 60_000);
    // The URL line prints before the socket is bound; poll before handing over.
    await waitForReady(`${baseUrl}/`, 30_000);
  } catch (err) {
    stopChild(child);
    throw err;
  }
  persistLogs(artifactsDir, log);
  child.on("exit", () => persistLogs(artifactsDir, log));
  return { dir, baseUrl, child, stdout: log.stdout(), stderr: log.stderr() };
}

function stopChild(child: ChildProcess): void {
  try {
    if (child.exitCode === null) child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

/** Stop the server by handle and remove the isolated config dir. */
export async function stopE2EServer(cfg: E2EConfig): Promise<void> {
  stopChild(cfg.child);
  await new Promise<void>((resolve) => {
    if (cfg.child.exitCode !== null) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      stopChild(cfg.child);
      try {
        cfg.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve();
    }, 5000);
    cfg.child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
  rmSync(cfg.dir, { recursive: true, force: true });
}

/** Non-virgin check used by scenarios: the setup gate must stay closed. */
export async function expectNonVirgin(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/setup`);
  if (res.status !== 200) throw new Error(`/api/setup answered ${res.status}`);
  const body = (await res.json()) as { required?: boolean };
  if (body.required) throw new Error("e2e server booted virgin (setup gate open)");
}

export function artifactsDirFor(scenario: string): string {
  const dir = join(ARTIFACTS_ROOT, scenario);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
