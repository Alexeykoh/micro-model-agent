/**
 * Мягкий re-read источников без перезапуска процесса: конфиг с диска и
 * инструкции `AGENTS.md`.
 *
 * Поверхности с долгоживущим процессом (`mma web`, `mma serve`, thin-REPL)
 * вызывают его по `/reload`, чтобы правки файлов подъехали без потери сессий.
 * Живой объект конфига мутируется, а не заменяется: агенты и раннеры держат
 * ссылку на него.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import type { AppConfig } from "../config/types";
import { agentsMdPaths, loadAgentsMdBlocks } from "./bootstrap/state";
import type { PromptBlock } from "./types";

/** Что подтянулось с диска: файлы инструкций и свежие промпт-блоки. */
export interface ReloadSourcesResult {
  /** Найденные `AGENTS.md` (пусто при `--no-agents-md`). */
  files: string[];
  /** Свежие блоки инструкций для `Agent.reloadInstructions`. */
  instructions: PromptBlock[];
}

/**
 * Перечитывает глобальный конфиг и `AGENTS.md` в живой объект.
 *
 * @param opts живой конфиг (мутируется), каталоги и флаг `--no-agents-md`.
 * @returns файлы инструкций и готовые промпт-блоки.
 */
export function reloadSources(opts: {
  config: AppConfig;
  configDir: string;
  baseDir: string;
  noAgentsMd?: boolean;
}): ReloadSourcesResult {
  const { config: fresh } = loadConfig({
    configDir: opts.configDir,
    projectConfigPath: join(opts.baseDir, ".mmrc"),
  });
  Object.assign(opts.config, fresh);

  if (opts.noAgentsMd) return { files: [], instructions: [] };
  const instructions = loadAgentsMdBlocks(opts.baseDir, opts.configDir, false);
  const files = agentsMdPaths(opts.baseDir, opts.configDir).filter((p) => existsSync(p));
  return { files, instructions };
}
