import { t } from "../i18n/index";
import { askChoice } from "./user-input";
import type { ToolDefinition } from "./types";

export const approveTool: ToolDefinition = {
  name: "approve",
  description: "Request user approval for an action. The user picks Yes or No from a menu.",
  tags: ["core"],
  interactive: true,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Description of the action requiring approval",
      },
    },
    required: ["action"],
  },
  handler: async (ctx, args) => {
    if (ctx.exitOnComplete) {
      return { success: false, output: t("tool.interactive_disabled") };
    }
    const action = String(args.action || "");
    const indexes = await askChoice(t("tool.approve_prompt", { action }), [
      { label: t("tool.approve_yes"), description: t("tool.approve_yes_desc") },
      { label: t("tool.approve_no"), description: t("tool.approve_no_desc") },
    ]);
    if (indexes[0] === 0) {
      return { success: true, output: t("tool.approved") };
    }
    return { success: false, output: t("tool.rejected") };
  },
};
