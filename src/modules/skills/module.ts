// Модуль скиллов: ленивая загрузка в бюджет токенов и блок системного промпта.
import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import { SkillsLoader, type SkillMeta } from "./loader";
import { t } from "../../i18n/index";
import { estimateTokens } from "../../llm/token-counter";

/** Итог загрузки скилла по имени (успех, сообщение, сам скилл). */
export interface LoadResult {
  success: boolean;
  message: string;
  skill?: SkillMeta;
}

/** Каталоги-источники скиллов в порядке приоритета (builtin → global → project). */
export interface SkillSources {
  builtinDir: string;
  globalDir: string;
  projectDir: string;
}

/** Модуль скиллов: каталог доступных, загрузка в бюджет, промпт-блок. */
export class SkillsModule implements AgentModule {
  name = "skills";

  private availableSkills: SkillMeta[];
  private loadedSkills: Map<string, SkillMeta> = new Map();
  private budget: number;
  private currentTokens = 0;
  /** Каталоги для `reload()`; без них пересканировать навыки нечем. */
  private sources?: SkillSources;

  constructor(availableSkills: SkillMeta[], budget: number, sources?: SkillSources) {
    this.availableSkills = availableSkills;
    this.budget = budget;
    this.sources = sources;
  }

  /**
   * Пересканировать каталоги навыков на живом инстансе.
   *
   * Именно мутация на месте, а не пересоздание: `createLoadSkillTool` замкнул
   * модуль при построении реестра тулов, и per-session раннеры держат тот же
   * инстанс из `BootstrapResult`. Загруженные скиллы, чьих файлов больше нет,
   * выгружаются; `currentTokens` пересчитывается по тем, что остались.
   *
   * Нужен, чтобы навык, написанный агентом в `.mma/skills/`, был виден без
   * рестарта процесса.
   */
  reload(rescan: () => SkillMeta[]): { added: number; removed: number } {
    const next = rescan();
    const before = new Set(this.availableSkills.map((s) => s.name));
    const after = new Set(next.map((s) => s.name));
    // Загруженные скиллы, которых больше нет на диске, уходят из бюджета.
    for (const name of [...this.loadedSkills.keys()]) {
      if (!after.has(name)) this.unload(name);
    }
    this.availableSkills = next;
    this.currentTokens = 0;
    for (const skill of this.loadedSkills.values()) {
      this.currentTokens += this.estimateTokens(skill.content);
    }
    return {
      added: [...after].filter((n) => !before.has(n)).length,
      removed: [...before].filter((n) => !after.has(n)).length,
    };
  }

  /** Пересканировать каталоги навыков на живом инстансе (для `reload()`). */
reloadSources(): { added: number; removed: number } {
    if (!this.sources) return { added: 0, removed: 0 };
    const loader = new SkillsLoader();
    return this.reload(() =>
      loader.loadFromAllSources(
        this.sources!.builtinDir,
        this.sources!.globalDir,
        this.sources!.projectDir,
      ),
    );
  }

  /** Каталоги-источники (для пересканирования). */
  getSources(): SkillSources | undefined {
    return this.sources;
  }

  /** Загружает скилл по имени с проверкой бюджета токенов. */
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

  /** Выгружает скилл и возвращает его токены в бюджет. */
  unload(name: string): boolean {
    const skill = this.loadedSkills.get(name);
    if (!skill) return false;
    this.loadedSkills.delete(name);
    this.currentTokens -= this.estimateTokens(skill.content);
    return true;
  }

  /** Загруженные скиллы. */
  getLoaded(): SkillMeta[] {
    return Array.from(this.loadedSkills.values());
  }

  /** Все доступные (загруженные и нет) скиллы. */
  getAvailable(): SkillMeta[] {
    return this.availableSkills;
  }

  /** Ищет скилл по точному имени среди доступных. */
  findByName(name: string): SkillMeta | undefined {
    return this.availableSkills.find((s) => s.name === name);
  }

  /** Подстрочный поиск по именам и описаниям (без учёта регистра). */
  search(query: string): SkillMeta[] {
    const q = query.toLowerCase();
    return this.availableSkills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }

  /** Бюджет токенов: занято, всего, остаток. */
  getBudget(): { used: number; total: number; remaining: number } {
    return {
      used: this.currentTokens,
      total: this.budget,
      remaining: this.budget - this.currentTokens,
    };
  }

  /** Тело загруженного скилла; null, если не загружен. */
  getSkillContent(name: string): string | null {
    const skill = this.loadedSkills.get(name);
    return skill ? skill.content : null;
  }

  /** Системный блок: каталог доступных + тела загруженных скиллов. */
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
        lines.push(`--- ${skill.name} (${this.estimateTokens(skill.content)} tokens) ---`);
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

  /** Плагин-заглушка: модуль работает через системный блок, хуки не нужны. */
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
    return estimateTokens(text);
  }
}
