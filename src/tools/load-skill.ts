/** Фабрика тула загрузки скилла (инжект в системный промпт). */
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import type { SkillsModule } from "../modules/skills/module";
import { estimateTokens } from "../llm/token-counter";

/** Расстояние Левенштейна (для fuzzy-подсказки имён скиллов). */
function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

/** Длина общего префикса двух строк. */
function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** Ближайшие k имён к запросу (только подсказка, без автозагрузки). */
export function nearestSkillNames(query: string, names: string[], k = 3): string[] {
  const q = query.toLowerCase();
  return [...names]
    .map((name) => {
      const n = name.toLowerCase();
      // Расстояние Левенштейна со скидкой за общий префикс: `css-expert` →
      // `css-styling-expert` должен обгонять несвязанные имена той же длины.
      const score = levenshtein(q, n) - 2 * commonPrefixLen(q, n);
      return { name, score };
    })
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, k)
    .map((x) => x.name);
}

/**
 * Фабрика тула load_skill. Контент скилла инжектится в системный промпт
 * (не в историю) — переживает компакцию. Возврат: определение тула.
 */
export function createLoadSkillTool(skillsModule: SkillsModule): ToolDefinition {
  return {
    name: "load_skill",
    security: { caps: [] },
    icon: "🎯",
    tags: ["core"],
    // Роутинг скиллов — вне сужения (P5): модель использует только видимый скилл.
    alwaysOn: true,
    description:
      "Load a skill by name. Skills provide specialized instructions and workflows. When loaded, the skill content is injected into the system prompt (not conversation history) so it persists through context compaction. Load a skill whenever it matches the task — the [Available Skills] list in the system prompt is authoritative.",
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
        const names = available.map((s) => s.name);
        const nearest = name ? nearestSkillNames(name, names) : [];
        const suggest =
          nearest.length > 0
            ? `\n\n${t("tool.skill_did_you_mean")}: ${nearest.join(", ")}`
            : "";
        const hint =
          names.length > 0 ? `\n\n${t("tool.skill_available_hint")}: ${names.join(", ")}` : "";
        return {
          success: false,
          output: result.message + suggest + hint,
          errorMeta: {
            code: "skill_not_found",
            retryable: true,
            hint: nearest.length > 0 ? nearest.join(", ") : undefined,
          },
        };
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
