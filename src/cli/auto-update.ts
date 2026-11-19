// Fire-and-forget самоапдейт фоновом для one-shot и REPL.
import { fileURLToPath } from "node:url";
import { type UpdaterModule, createUpdater, busLogger } from "../modules/updater/index";
import type { AppConfig } from "../config/types";

/**
 * Стартует апдейтер фоном: проверка никогда не блокирует старт, установка —
 * best-effort. `entryPath` — путь текущей точки входа (`import.meta.url` этого
 * модуля); по расширению `.ts`/`.js` фабрика отличает dev-прогон от установки.
 */
export function startAutoUpdate(config: { updater: AppConfig["updater"] }): UpdaterModule | undefined {
  return createUpdater({
    config: config.updater,
    entryPath: fileURLToPath(import.meta.url),
    logger: busLogger(),
  });
}
