// Чистые помощники соединения: параметры `initialize` и текст причины выхода.
//
// Вынесено из `connection.ts` (правило 6: файл на потолке) — обе функции не
// трогают состояние, их легко проверить отдельно.
import { buildClientCapabilities } from "./capabilities";
import type { LspExitInfo } from "./connection-types";
import type { LspServerConfig } from "./types";
import { pathToUri } from "./uri";

/**
 * Параметры `initialize`: корень, capabilities, clientInfo, токен прогресса и
 * серверные `initializationOptions`.
 */
export function buildInitializeParams(
  projectRoot: string,
  config: LspServerConfig,
): Record<string, unknown> {
  const rootUri = pathToUri(projectRoot);
  return {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "workspace" }],
    clientInfo: { name: "micro-models-agent", version: "lsp-connection/1" },
    capabilities: buildClientCapabilities(),
    // Токен прогресса: по спеке сервер вправе слать `$/progress` с ним уже во
    // время initialize (загрузка проекта). Без токена «жив, но занят»
    // неотличим от таймаута.
    workDoneToken: "mma/lsp-init",
    ...(config.initializationOptions
      ? { initializationOptions: config.initializationOptions }
      : {}),
  };
}

/**
 * Причина завершения для ошибок ожидающих запросов. По спеке LSP код 0 —
 * чистый выход после `shutdown`, 1 — выход без него (крах).
 */
export function exitReason(exit: LspExitInfo | null): string {
  if (!exit) return "LSP server exited";
  if (exit.code === null || exit.code === undefined) {
    return exit.signal ? `LSP server exited (signal ${exit.signal})` : "LSP server exited";
  }
  return `LSP server exited (code ${exit.code})`;
}

/**
 * Текст прогресса из `$/progress` (например, «Loading project»); null — прогресс
 * завершён или пуст. Сервер вправе слать его во время `initialize`.
 */
export function progressTextOf(params: unknown): string | null {
  const value = (params as { value?: { kind?: string; message?: string; title?: string } } | undefined)
    ?.value;
  if (!value || value.kind === "end") return null;
  return value.message ?? value.title ?? value.kind ?? null;
}
