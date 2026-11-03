// Синхронизация тулов плагинов с реестрами. Вынесена из `manager.ts`: это
// отдельный слой «активные плагины → вклад в ToolRegistry», который зависит
// только от провайдера активного набора, а не от остального состояния реестра.
import type { AgentPlugin } from "../types";
import type { ToolRegistry } from "../../tools/registry";
import {
  syncPluginTools,
  detachPluginTools,
  type PluginToolSyncResult,
} from "./tools";

/** Вклад плагинов в подключённые реестры тулов (главный + раннеры сессий). */
export class PluginToolSync {
  private readonly registries = new Set<ToolRegistry>();
  /** Конфликты последней синхронизации — для `mma plugins show` и тестов. */
  private conflicts: PluginToolSyncResult["conflicts"] = [];

  constructor(private readonly active: () => AgentPlugin[]) {}

  /**
   * Подключить реестр и сразу синхронизировать: реестр мог быть собран до
   * последней перезагрузки плагинов.
   */
  attach(registry: ToolRegistry): PluginToolSyncResult {
    this.registries.add(registry);
    return this.sync();
  }

  /**
   * Отключить реестр и снять с него вклад плагинов. Вызывается при остановке
   * раннера: иначе менеджер держал бы реестр выключенной сессии и пытался бы
   * вносить в него тулы после reload.
   */
  detach(registry: ToolRegistry): boolean {
    if (!this.registries.delete(registry)) return false;
    detachPluginTools(registry);
    return true;
  }

  /** Синхронизировать все подключённые реестры с текущим набором плагинов. */
  sync(): PluginToolSyncResult {
    const result: PluginToolSyncResult = { added: [], removed: [], kept: [], conflicts: [] };
    for (const registry of this.registries) {
      const one = syncPluginTools(this.active(), registry);
      result.added.push(...one.added);
      result.removed.push(...one.removed);
      result.kept.push(...one.kept);
      result.conflicts.push(...one.conflicts);
    }
    this.conflicts = result.conflicts;
    return result;
  }

  /** Конфликты имён тулов последней синхронизации (пусто, если всё внеслось). */
  getConflicts(): PluginToolSyncResult["conflicts"] {
    return this.conflicts.map((c) => ({ ...c }));
  }
}
