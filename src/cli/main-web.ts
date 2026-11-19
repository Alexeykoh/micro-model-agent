// Долгоживущие подкоманды `mma web` / `mma serve`: wiring после `program.parse`.
import type { Command } from "commander";
import { getDefaultChannel } from "../output";
import { pc } from "../ui/colors";
import { errMsg } from "../utils";
import { runWeb, parsePort } from "./web-command";
import { runServe, parseServePort } from "./service-command";

/** Проектные флаги, которые переезжают в bootstrap обеих подкоманд. */
export interface LongRunningContext {
  projectDir?: string;
  noAgentsMd: boolean;
}

/**
 * Разбирает `--port` подкоманды и валидирует его. Ошибка — exit 2 до старта
 * сервера: нечисловой порт не должен маскироваться под рабочий bind.
 */
function parsePortOrExit(
  raw: string | undefined,
  parse: (raw: string | undefined) => number | undefined,
): number | undefined {
  try {
    return parse(raw);
  } catch (err) {
    getDefaultChannel().writeLine(pc.red(`  ${errMsg(err)}`), "stderr");
    process.exit(2);
  }
}

/**
 * Запускает `web`/`serve`, если первый позиционный аргумент — эта подкоманда.
 * Возвращает `true`, когда ветка распознана (процесс завершается внутри:
 * серверы долгоживущие), и `false` — чтобы `main()` продолжил обычный маршрут.
 *
 * Обе подкоманды стартуют здесь, после parse, вне one-shot exit-хука: их action
 * в `commands.ts` намеренно no-op.
 */
export async function dispatchLongRunningCommand(
  program: Command,
  ctx: LongRunningContext,
): Promise<boolean> {
  const name = program.args[0];
  if (name !== "web" && name !== "serve") return false;

  const raw = (program.commands.find((c) => c.name() === name)?.opts() ?? {}) as {
    port?: string;
    host?: string;
    token?: string;
    open?: boolean;
    daemonUrl?: string;
    rotateToken?: boolean;
  };

  if (name === "web") {
    const port = parsePortOrExit(raw.port, parsePort);
    await runWeb({
      port,
      host: raw.host,
      token: raw.token,
      daemonUrl: raw.daemonUrl,
      noOpen: raw.open === false,
      projectDir: ctx.projectDir,
      noAgentsMd: ctx.noAgentsMd,
    });
    process.exit(0);
  }

  const port = parsePortOrExit(raw.port, parseServePort);
  await runServe({
    port,
    host: raw.host,
    token: raw.token,
    projectDir: ctx.projectDir,
    noAgentsMd: ctx.noAgentsMd,
    rotateToken: raw.rotateToken === true,
  });
  process.exit(0);
}
