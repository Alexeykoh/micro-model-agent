// Рукопожатие `initialize` с одним ретраем.
//
// Вынесено из `connection.ts` (правило 6): ретрай нужен из-за холодного кеша
// npx, который вылетает за таймаут первой попытки.
import type { LspClientLogger } from "./client-logger";
import { errMsg } from "../../utils";

export interface InitializeRetryDeps {
  logger: LspClientLogger | null;
  command: string;
  projectRoot: string;
  timeout: number;
  /** Запрос `initialize` к текущему процессу. */
  request: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  /** Поднять процесс заново (первая попытка уже упала). */
  respawn: () => Promise<void>;
  /** Погасить текущий процесс перед ретраем или сдачей. */
  teardown: () => void;
  /** Запомнить ответ (capabilities) на успешной попытке. */
  onResult: (result: unknown) => void;
}

export async function initializeWithRetry(
  params: Record<string, unknown>,
  deps: InitializeRetryDeps,
): Promise<void> {
  try {
    deps.onResult(await deps.request("initialize", params, deps.timeout));
    return;
  } catch (e) {
    deps.logger?.warn(`LSP initialize failed (attempt 1): ${errMsg(e)}`, {
      command: deps.command,
      projectRoot: deps.projectRoot,
    });
    deps.teardown();
  }

  await deps.respawn();
  try {
    deps.onResult(await deps.request("initialize", params, deps.timeout));
  } catch (retryErr) {
    deps.logger?.error(`LSP initialize failed (attempt 2, giving up): ${errMsg(retryErr)}`, {
      command: deps.command,
      projectRoot: deps.projectRoot,
    });
    deps.teardown();
    throw retryErr;
  }
}
