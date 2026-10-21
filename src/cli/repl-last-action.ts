// Печать последнего действия агента (Ctrl+O) — вынесено из `repl.ts`:
// это самостоятельный кусок вывода, а не состояние REPL (правило 6 AGENTS).
import { pc } from "../ui/colors";
import { glyph, toolAccent } from "../ui/theme";
import { getLastAction } from "../ui/action-log";
import { t } from "../i18n/index";

/** Куда печатать. */
export interface LastActionSink {
  writeLine(text: string): void;
}

/**
 * Печатает последнее действие агента (тул + аргументы + итог + тело вывода).
 * Нет действия — сообщение об этом.
 */
export function printLastAction(output: LastActionSink): void {
  const last = getLastAction();
  if (!last) {
    output.writeLine(pc.dim(t("repl.last_action_none")));
    return;
  }
  const mark =
    last.status === "error"
      ? pc.red(glyph.failure)
      : last.status === "warn"
        ? pc.yellow(glyph.warning)
        : pc.green(glyph.success);
  const accent = toolAccent(last.tool);
  const head = `${accent(glyph.action)} ${accent(last.label)}${
    last.args ? ` ${pc.dim("·")} ${pc.dim(last.args)}` : ""
  }  ${mark} ${pc.dim(`${last.durationMs}ms`)}`;
  const lines = [head, ...last.body.map((l) => `  ${l}`)];
  output.writeLine(`\n${lines.join("\n")}`);
}
