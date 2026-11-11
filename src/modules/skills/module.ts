// Модуль скиллов: ленивая загрузка в бюджет токенов и блок системного промпта.
import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import { SkillsLoader, type SkillMeta } from "./loader";
import { buildCatalogBlock, buildLoadedBlock } from "./catalog";
import { LoadedEvents, type LoadedSkillRef } from "./loaded-events";
import type { SkillUsage } from "./usage";
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
  /** Hub подписки на изменение загруженного набора (веб-индикатор). */
  private readonly loadedEvents = new LoadedEvents();
  private budget: number;
  private currentTokens = 0;
  /** Каталоги для `reload()`; без них пересканировать навыки нечем. */
  private sources?: SkillSources;
  /** Счётчики использования: каталог в промпте показывает топ-10. */
  private usage?: SkillUsage;

  constructor(
    availableSkills: SkillMeta[],
    budget: number,
    sources?: SkillSources,
    usage?: SkillUsage,
  ) {
    this.availableSkills = availableSkills;
    this.budget = budget;
    this.sources = sources;
    this.usage = usage;
  }

  /**
   * Есть ли вообще скиллы. Если нет — тул `load_skill` не регистрируется
   * (аудит §2.7): модель не должна видеть инструмент без содержимого.
   */
  hasAny(): boolean {
    return this.availableSkills.length > 0;
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
  /** Последняя ошибка пересканирования (для честного `health()`). */
  private lastReloadError: string | null = null;

  /** Честный health: недавняя ошибка пересканирования → degraded (INV-6). Ноль скиллов — не failure. */
  health(): { status: "ok" | "degraded" | "failed"; reason?: string } {
    if (this.lastReloadError) {
      return { status: "degraded", reason: `skills rescan failed: ${this.lastReloadError}` };
    }
    return { status: "ok" };
  }

  reload(rescan: () => SkillMeta[]): { added: number; removed: number } {
    let next: SkillMeta[];
    try {
      next = rescan();
      this.lastReloadError = null;
    } catch (err) {
      this.lastReloadError = err instanceof Error ? err.message : String(err);
      throw err;
    }
    const before = new Set(this.availableSkills.map((s) => s.name));
    const after = new Set(next.map((s) => s.name));
    // Загруженные скиллы, которых больше нет на диске, уходят из бюджета.
    let unloadedAny = false;
    for (const name of [...this.loadedSkills.keys()]) {
      if (!after.has(name)) { this.unload(name); unloadedAny = true; }
    }
    if (unloadedAny) this.loadedEvents.notify([...this.loadedSkills.values()]);
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
    this.loadedEvents.notify([...this.loadedSkills.values()]);
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

  /** Подписка на изменение загруженного набора (веб-индикатор, REPL). Возвращает отписку. */
  onChange(cb: (loaded: LoadedSkillRef[]) => void): () => void {
    return this.loadedEvents.subscribe(cb);
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

  /** Системный блок: каталог + тела загруженных (совместимый вход). */
  getSystemPromptBlock(): PromptBlock | null {
    const blocks = this.getPromptBlocks();
    if (blocks.length === 0) return null;
    const content = blocks.map((b) => b.content).join("\n\n");
    return {
      content,
      priority: "high",
      essential: false,
      estimatedTokens: this.estimateTokens(content),
    };
  }

  /**
   * Каталог и тела — отдельными блоками: каталог должен влезать сам, а тела
   * скиллов — уходить в хвост и деградировать независимо (W2 спеки v3).
   */
  getPromptBlocks(): PromptBlock[] {
    const blocks: PromptBlock[] = [];
    const catalog = this.getCatalogBlock();
    if (catalog) blocks.push(catalog);
    const loaded = this.getLoadedBlock();
    if (loaded) blocks.push(loaded);
    return blocks;
  }

  /** Компактный каталог: топ-10 по использованию, имена без описаний. */
  getCatalogBlock(): PromptBlock | null {
    return buildCatalogBlock(this.availableSkills, this.usage);
  }

  /** Тела загруженных скиллов: низкий приоритет и хвост промпта. */
  getLoadedBlock(): PromptBlock | null {
    return buildLoadedBlock([...this.loadedSkills.values()]);
  }

  /** Плагин-заглушка: модуль работает через системный блок, хуки не нужны. */
  getPlugin(): AgentPlugin {
    return {
      name: "skills",
      description: "discovers and loads agent skills",
      onSessionStart: () => {},
      onBeforeThink: () => {},
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
    this.usage?.recordLoad(skill.name);
    this.loadedEvents.notify([...this.loadedSkills.values()]);

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
