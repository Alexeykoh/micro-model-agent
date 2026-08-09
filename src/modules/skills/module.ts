import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import type { SkillMeta } from "./loader";
import { t } from "../../i18n/index";

export interface LoadResult {
  success: boolean;
  message: string;
  skill?: SkillMeta;
}

export class SkillsModule implements AgentModule {
  name = "skills";

  private availableSkills: SkillMeta[];
  private loadedSkills: Map<string, SkillMeta> = new Map();
  private budget: number;
  private currentTokens = 0;

  constructor(availableSkills: SkillMeta[], budget: number) {
    this.availableSkills = availableSkills;
    this.budget = budget;
  }

  loadByName(name: string): LoadResult {
    if (this.loadedSkills.has(name)) {
      return { success: false, message: t("skill.already_loaded", { name }) };
    }

    const skill = this.availableSkills.find((s) => s.name === name);
    if (!skill) {
      return { success: false, message: t("skill.not_found", { name }) };
    }

    return this.tryLoad(skill);
  }

  unload(name: string): boolean {
    const skill = this.loadedSkills.get(name);
    if (!skill) return false;
    this.loadedSkills.delete(name);
    this.currentTokens -= this.estimateTokens(skill.content);
    return true;
  }

  getLoaded(): SkillMeta[] {
    return Array.from(this.loadedSkills.values());
  }

  getAvailable(): SkillMeta[] {
    return this.availableSkills;
  }

  findByName(name: string): SkillMeta | undefined {
    return this.availableSkills.find((s) => s.name === name);
  }

  search(query: string): SkillMeta[] {
    const q = query.toLowerCase();
    return this.availableSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }

  getBudget(): { used: number; total: number; remaining: number } {
    return {
      used: this.currentTokens,
      total: this.budget,
      remaining: this.budget - this.currentTokens,
    };
  }

  getSkillContent(name: string): string | null {
    const skill = this.loadedSkills.get(name);
    return skill ? skill.content : null;
  }

  getSystemPromptBlock(): PromptBlock | null {
    const lines: string[] = [];

    if (this.availableSkills.length > 0) {
      lines.push("[Available Skills]");
      lines.push(t("skill.prompt_hint"));
      for (const skill of this.availableSkills) {
        const desc = skill.description.slice(0, 80);
        lines.push(`- ${skill.name}: ${desc}`);
      }
    }

    if (this.loadedSkills.size > 0) {
      lines.push("");
      lines.push("[Loaded Skills]");
      for (const skill of this.loadedSkills.values()) {
        lines.push(
          `--- ${skill.name} (${this.estimateTokens(skill.content)} tokens) ---`,
        );
        lines.push(skill.content);
        lines.push("");
      }
    }

    if (lines.length === 0) return null;

    const content = lines.join("\n");
    const tokens = this.estimateTokens(content);

    return {
      content,
      priority: "high",
      essential: false,
      estimatedTokens: tokens,
    };
  }

  getPlugin(): AgentPlugin {
    return {
      name: "skills",
      onSessionStart: (_ctx: any) => {},
      onBeforeThink: (_ctx: any) => {},
    };
  }

  private tryLoad(skill: SkillMeta): LoadResult {
    const tokens = this.estimateTokens(skill.content);

    if (tokens > this.budget) {
      return {
        success: false,
        message: t("skill.too_large", {
          name: skill.name,
          tokens,
          budget: this.budget,
        }),
      };
    }

    if (this.currentTokens + tokens > this.budget) {
      const remaining = this.budget - this.currentTokens;
      return {
        success: false,
        message: t("skill.exceeds_budget", {
          name: skill.name,
          tokens,
          remaining,
        }),
      };
    }

    this.loadedSkills.set(skill.name, skill);
    this.currentTokens += tokens;

    return {
      success: true,
      message: t("skill.loaded", {
        name: skill.name,
        tokens,
        remaining: this.budget - this.currentTokens,
      }),
      skill,
    };
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
