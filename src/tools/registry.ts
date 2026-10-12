/** Реестр тулов: регистрация и tag-отбор для LLM. */
import type { ToolDefinition } from "./types";

/**
 * Тул, лежащий в реестре (INV-1/2): определение плюс **обязательный** владелец.
 * Авторская форма (`ToolDefinition`) владельца не несёт — его назначает путь
 * регистрации; реестр отдаёт только `RegisteredTool`, поэтому «тул без
 * владельца» невыразим по типу, а не проверяется тестом.
 */
export type RegisteredTool = ToolDefinition & { readonly owner: string };

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  register(tool: ToolDefinition, owner: string): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, { ...tool, owner });
  }

  /**
   * Зарегистрировать или заменить по имени. `register` остаётся строгим: дубль
   * в ядре — это баг, который должен упасть на старте. `upsert` нужен там, где
   * набор тулов принадлежит внешнему источнику и меняется по ходу работы —
   * плагины (см. `modules/plugins/tools.ts`).
   */
  upsert(tool: ToolDefinition, owner: string): void {
    this.tools.set(tool.name, { ...tool, owner });
  }

  /** Снять тул с регистрации (выключение/выгрузка плагина). */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Поверхностная копия реестра (те же определения, новая Map).
   * Параллельным раннерам: свои plan/set_thinking поверх общих хендлеров —
   * хендлеры `(ctx, args)`-чисты, состояние несут ctx/executor, а не реестр.
   */
  clone(): ToolRegistry {
    const copy = new ToolRegistry();
    for (const tool of this.tools.values()) copy.tools.set(tool.name, tool);
    return copy;
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Тулы по именам (отсортированы). */
  list(): string[] {
    return Array.from(this.tools.keys()).sort();
  }

  /** Все зарегистрированные определения (с владельцем). */
  getAll(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /** Подмножество с любым из тегов (без alwaysOn). */
  getByTags(tags: string[]): RegisteredTool[] {
    return this.getAll().filter((t) => {
      if (!t.tags || t.tags.length === 0) return false;
      return tags.some((tag) => t.tags!.includes(tag));
    });
  }

  /**
   * Тулы для LLM: всегда `alwaysOn`, плюс совпавшие по тегам. Без тегов —
   * все (backward-compatible). Дубликаты исключены объединением по имени.
   */
  getAllForLLM(
    tags?: string[],
  ): Array<Pick<ToolDefinition, "name" | "description" | "parameters" | "boundedOutput">> {
    const all = this.getAll();
    const tagSet = new Set(tags ?? []);
    const selected =
      tagSet.size === 0
        ? all
        : all.filter((t) => t.alwaysOn || (t.tags?.some((tag) => tagSet.has(tag))));
    return selected.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      boundedOutput: t.boundedOutput,
    }));
  }
}
