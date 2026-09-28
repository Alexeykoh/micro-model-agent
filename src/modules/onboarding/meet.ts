// Вход «Познакомимся»: префлайт провайдера, meet-режим и первый ход интервью.
import type { ReplContext } from "../../cli/repl-commands";
import type { PreflightResult } from "../providers/preflight";
import { preflightFromConfig } from "../providers/preflight";
import { enterMeetMode } from "./mode";
import { t } from "../../i18n/index";
import { pc } from "../../ui/colors";

/** Опции запуска интервью. */
export interface RunMeetOptions {
  /** Шов для тестов: подмена проверки провайдера. */
  preflight?: () => Promise<PreflightResult>;
}

/**
 * Запускает интервью-знакомство. Проверяет провайдер, входит в meet-режим
 * и делает первый ход агента. Режим живёт между ходами REPL, пока не
 * сработает `meet_done` или пользователь не выйдет.
 * Возвращает false, когда провайдер недоступен (ничего не меняется).
 */
export async function runMeet(ctx: ReplContext, opts: RunMeetOptions = {}): Promise<boolean> {
  if (ctx.toolCtx.onboarding) {
    ctx.output.writeLine(pc.yellow(t("repl.meet_already_hint")));
    return true;
  }

  if (process.stdout.isTTY !== true) {
    ctx.output.writeLine(pc.yellow(t("onboarding.non_interactive")));
    return false;
  }

  const check = opts.preflight ?? (() => preflightFromConfig(ctx));

  const pre = await check();
  if (!pre.ok) {
    ctx.output.writeLine(pc.yellow(t("repl.meet_unavailable", { reason: pre.reason })));
    ctx.output.writeLine(t("repl.meet_unavailable_hint"));
    return false;
  }

  enterMeetMode(ctx);
  await ctx.runAgent(t("repl.meet_start_prompt"));
  return true;
}
