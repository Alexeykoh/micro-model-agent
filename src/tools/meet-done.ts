/** Сентинел завершения meet-интервью: ставит флаг, REPL выходит из режима. */
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";

/** Модель зовёт по финальному саммари; вне онбординга — no-op по флагу. */
export const meetDoneTool: ToolDefinition = {
  name: "meet_done",
  description:
    "Signal that the get-acquainted interview is complete. Call only after the final summary.",
  tags: ["memory"],
  parameters: { type: "object", properties: {} },
  handler: async (ctx) => {
    if (ctx.onboarding) ctx.onboarding.done = true;
    return { success: true, output: t("tool.meet_done") };
  },
};
