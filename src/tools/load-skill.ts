import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import type { SkillsModule } from "../modules/skills/module";
import { estimateTokens } from "../llm/token-counter";

export function createLoadSkillTool(skillsModule: SkillsModule): ToolDefinition {
  return {
    name: "load_skill",
    icon: "🎯",
    tags: ["core"],
    // Skill routing must stay available under narrowing (P5): the model can
    // only use a skill it can see.
    alwaysOn: true,
    description:
      "Load a skill by name. Skills provide specialized instructions and workflows. When loaded, the skill content is injected into the system prompt (not conversation history) so it persists through context compaction. Only use when the task clearly requires domain-specific knowledge.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Exact skill name to load (see [Available Skills] for names)",
        },
      },
      required: ["name"],
    },
    handler: async (_ctx, args) => {
      const name = args.name ? String(args.name) : undefined;

      if (!name) {
        return { success: false, output: t("tool.invalid_params") };
      }

      const result = skillsModule.loadByName(name);

      if (!result.success) {
        const available = skillsModule.getAvailable();
        const hint =
          available.length > 0
            ? `\n\n${t("tool.skill_available_hint")}: ${available.map((s) => s.name).join(", ")}`
            : "";
        return { success: false, output: result.message + hint };
      }

      const budget = skillsModule.getBudget();
      const tokens = result.skill ? estimateTokens(result.skill.content) : 0;
      return {
        success: true,
        output: t("tool.skill_budget", {
          name,
          tokens,
          remaining: budget.remaining,
        }),
      };
    },
  };
}
