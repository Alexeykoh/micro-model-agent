// Реестр провайдеров: type → фабрика + capabilities. Новый провайдер = один register().
// src/modules/providers/registry.ts
import type { ProviderSpec } from "./types";

/**
 * Единый источник правды type → фабрика + capabilities.
 * Добавление провайдера — один вызов `register()`; петля агента не меняется.
 */
export class ProviderRegistry {
  private specs = new Map<string, ProviderSpec>();

  /** Зарегистрировать спек провайдера. */
  register(spec: ProviderSpec): void {
    this.specs.set(spec.type, spec);
  }

  /** Спек по типу, иначе undefined. */
  get(type: string): ProviderSpec | undefined {
    return this.specs.get(type);
  }

  /** Зарегистрирован ли тип. */
  has(type: string): boolean {
    return this.specs.has(type);
  }

  /** Все спеки. */
  list(): ProviderSpec[] {
    return [...this.specs.values()];
  }

  /** Все зарегистрированные типы. */
  types(): string[] {
    return [...this.specs.keys()];
  }
}