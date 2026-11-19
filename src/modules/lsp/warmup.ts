// Прогрев LSP-серверов проекта в фоне на старте сессии.
//
// Зачем: пул тёплый только внутри процесса и только после первого обращения.
// Без прогрева первый `lsp_check`/запись в каждой сессии платит холодный старт
// (1–12 с) или упирается в бюджет ожидания. Прогрев поднимает серверы заранее,
// последовательно (параллельный `npx` на холодном кеше дерётся за лок) и не
// блокирует старт: ошибки идут в `health` с backoff.
import type { LspClient } from "./client";
import { serverKeyFor } from "./client";
import type { LspClientLogger } from "./client-logger";
import { getServerForFile } from "./config";
import type { LspHealth } from "./health";
import { findProjectRoot } from "./project-root";
import { collectCheckFiles } from "./check-tool";
import type { LspConfig } from "./types";

/** Сколько файлов сканируем, чтобы понять, какие серверы применимы. */
export const WARM_SCAN_LIMIT = 40;

/** Зависимости прогрева (всё инжектируется — тесты без процессов). */
export interface WarmProjectDeps {
  config: LspConfig;
  baseDir: string;
  client: Pick<LspClient, "isWarm" | "warmup">;
  health: LspHealth;
  logger: LspClientLogger | null;
  log(event: string, meta?: Record<string, unknown>): void;
  /** Тест-хук: бюджет сканирования (мс). */
  scanTimeoutMs?: number;
}

/** Запустить прогрев в фоне; промис нужен только тестам. */
export function warmProjectServers(deps: WarmProjectDeps): Promise<void> {
  return runWarm(deps).catch((e: unknown) => {
    deps.log("lsp.warm_project_failed", { error: e instanceof Error ? e.message : String(e) });
  });
}

async function runWarm(deps: WarmProjectDeps): Promise<void> {
  if (!deps.config.enabled || !deps.baseDir) return;
  const scan = collectCheckFiles(deps.baseDir, deps.config, WARM_SCAN_LIMIT);
  const files = deps.scanTimeoutMs
    ? await Promise.race([
        scan,
        new Promise<string[]>((resolve) => setTimeout(() => resolve([]), deps.scanTimeoutMs)),
      ])
    : await scan;

  // Один прогрев на (сервер, корень): файлы одного проекта делят соединение.
  const targets = new Map<string, { key: string; root: string; server: ReturnType<typeof getServerForFile> }>();
  for (const file of files) {
    const server = getServerForFile(file, deps.config);
    if (!server) continue;
    const key = serverKeyFor(server);
    const root = findProjectRoot(file, deps.baseDir, server.workspaceMarkers ?? []);
    const id = `${key}\u0000${root}`;
    if (!targets.has(id)) targets.set(id, { key, root, server });
  }
  if (targets.size === 0) return;

  deps.log(
    `LSP warm project: ${targets.size} server(s) — ${[...targets.values()].map((t) => t.key).join(", ")}`,
    { op: "warm_project", baseDir: deps.baseDir, servers: [...targets.values()].map((t) => t.key) },
  );

  // Последовательно: параллельный npx на холодном кеше даёт «initialize timeout».
  for (const target of targets.values()) {
    const server = target.server;
    if (!server) continue;
    if (deps.health.isDisabled(target.key)) {
      const retryInMs = deps.health.retryInMs(target.key);
      deps.log(
        `LSP warm skipped: ${target.key} (cooldown ${Math.ceil(retryInMs / 1000)}s)`,
        { op: "warm_skipped", server: target.key, retryInMs },
      );
      continue;
    }
    if (deps.client.isWarm(server, target.root)) continue;
    if (deps.health.isWarming(target.key)) continue;

    const started = Date.now();
    deps.log(`LSP warm start: ${target.key} (${target.root})`, {
      op: "warm_start",
      server: target.key,
      root: target.root,
      trigger: "session",
    });
    await new Promise<void>((resolve) => {
      deps.health.warmInBackground({
        key: target.key,
        warm: () => deps.client.warmup(server, target.root),
        onSuccess: () => {
          deps.log(`LSP ready: ${target.key} in ${Date.now() - started}ms`, {
            op: "ready",
            server: target.key,
            root: target.root,
            durMs: Date.now() - started,
            trigger: "session",
          });
          resolve();
        },
        onError: (msg) => {
          const failure = deps.health.recordFailure(target.key, server, msg);
          deps.log(
            `LSP warm failed: ${target.key} in ${Date.now() - started}ms — ${msg}` +
              (failure.blocked ? ` (next attempt in ${Math.ceil(failure.retryInMs / 1000)}s)` : ""),
            {
              op: "warm_failed",
              server: target.key,
              root: target.root,
              durMs: Date.now() - started,
              blocked: failure.blocked,
              retryInMs: failure.retryInMs,
              error: msg,
              trigger: "session",
            },
          );
          resolve();
        },
      });
    });
  }
}
