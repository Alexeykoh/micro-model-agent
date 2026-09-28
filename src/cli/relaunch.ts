// Перезапуск CLI в свежем процессе после визарда настройки.
import { spawnSync } from "node:child_process";
import { t } from "../i18n/index";
import { getDefaultChannel } from "../output";
import { MMA_ENV } from "../config/env";

/**
 * Аргументы для перезапуска текущего CLI в свежем процессе: дропаем argv[0]
 * рантайма (бинарник bun/node), оставляем входной скрипт и все юзер-аргументы.
 */
export function relaunchArgs(argv: string[]): string[] {
  return argv.slice(1);
}

/**
 * Переисполняет текущий CLI в brand-new процессе с inherit stdio и выходит
 * с его статусом.
 *
 * Первый запуск использует это, чтобы визард и REPL не делили процесс: на
 * Bun/Windows raw-режимный `LineEditor` получает keypress, только будучи ПЕРВЫМ
 * потребителем stdin, а переиспользование одного редактора через фазы
 * wizard → bootstrap → REPL протекает состоянием промпта/кадра. Свежий процесс
 * делает REPL-редактор первым потребителем по построению.
 *
 * `MMA_POST_SETUP=1` ставится ребёнку, чтобы неуспешная запись конфига не могла
 * зациклить визард.
 */
export function relaunchCli(): never {
  const args = relaunchArgs(process.argv);
  const entry = args[0];
  if (!entry) process.exit(0);
  const child = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, [MMA_ENV.POST_SETUP]: "1" },
  });
  if (child.error) {
    getDefaultChannel().writeLine(t("cli.relaunch_failed", { message: child.error.message }), "stderr");
    process.exit(1);
  }
  process.exit(child.status ?? 0);
}
