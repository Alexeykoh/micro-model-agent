import type { ReplContext } from "../../cli/repl-commands";
import type { PreflightResult } from "../providers/preflight";
import { preflightFromConfig } from "../providers/preflight";
import { enterMeetMode } from "./mode";
import { t } from "../../i18n/index";
import { pc } from "../../ui/colors";

export interface RunMeetOptions {
  /** Test seam. */
  preflight?: () => Promise<PreflightResult>;
}

/**
 * Start the get-acquainted interview. Preflights the provider, enters meet
 * mode, and kicks off the first agent turn. Meet mode stays active across
 * subsequent REPL turns until `meet_done` fires or the user exits.
 * Returns false when the provider is unavailable (nothing is modified).
 */
export async function runMeet(ctx: ReplContext, opts: RunMeetOptions = {}): Promise<boolean> {
  if (ctx.toolCtx.onboarding) {
    ctx.output.writeLine(pc.yellow(t("onboarding.already")));
    return true;
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
