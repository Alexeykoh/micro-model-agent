import type { ToolDefinition } from "./types";

/** Sentinel: the model calls this to signal the meet interview is finished. */
export const meetDoneTool: ToolDefinition = {
  name: "meet_done",
  description:
    "Signal that the get-acquainted interview is complete. Call only after the final summary.",
  tags: ["memory"],
  parameters: { type: "object", properties: {} },
  handler: async (ctx) => {
    if (ctx.onboarding) ctx.onboarding.done = true;
    return { success: true, output: "Interview marked complete." };
  },
};
