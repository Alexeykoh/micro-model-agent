// src/modules/providers/registry.ts
import type { ProviderSpec } from "./types";

/**
 * Single source of truth mapping provider `type` → factory + capabilities.
 * Adding a provider = one `register()` call; no changes to the agent loop.
 */
export class ProviderRegistry {
  private specs = new Map<string, ProviderSpec>();

  register(spec: ProviderSpec): void {
    this.specs.set(spec.type, spec);
  }

  get(type: string): ProviderSpec | undefined {
    return this.specs.get(type);
  }

  has(type: string): boolean {
    return this.specs.has(type);
  }

  list(): ProviderSpec[] {
    return [...this.specs.values()];
  }

  types(): string[] {
    return [...this.specs.keys()];
  }
}