import type { ModeConfig } from './types.js';

/**
 * Реестр режимов агента.
 *
 * Хранит и управляет конфигурациями режимов.
 * Встроенные режимы (fast/base/pro) регистрируются по умолчанию.
 * Кастомные режимы загружаются из конфига.
 *
 * @module agent/modes/registry
 */

/** Встроенные режимы */
const BUILTIN_MODES: ModeConfig[] = [
  {
    id: 'fast',
    label: 'Fast',
    systemPromptTemplate: 'fast',
    constraints: {
      maxSkills: 0,
      skillTokenBudget: 0,
      minContextWindow: 0,
    },
    forcedSkills: [],
    allowAutoLoadSkills: false,
    behaviors: {
      planEnforcement: false,
      directWriteStreak: false,
      singleWritePerResponse: false,
      readConsolidation: false,
      continuationNudge: false,
    },
    ui: {
      showThinking: false,
      quiet: false,
      promptPrefix: '[fast]',
    },
    subagentMode: 'fast',
  },
  {
    id: 'base',
    label: 'Base',
    systemPromptTemplate: 'base',
    constraints: {
      maxSkills: 2,
      skillTokenBudget: 4000,
      minContextWindow: 0,
    },
    forcedSkills: [],
    allowAutoLoadSkills: true,
    behaviors: {
      planEnforcement: true,
      directWriteStreak: true,
      singleWritePerResponse: true,
      readConsolidation: true,
      continuationNudge: true,
    },
    ui: {
      showThinking: false,
      quiet: false,
      promptPrefix: '',
    },
    subagentMode: 'base',
  },
  {
    id: 'pro',
    label: 'Pro',
    systemPromptTemplate: 'pro',
    constraints: {
      maxSkills: 0,
      skillTokenBudget: 8000,
      minContextWindow: 64000,
    },
    forcedSkills: ['grill-me'],
    allowAutoLoadSkills: true,
    behaviors: {
      planEnforcement: true,
      directWriteStreak: true,
      singleWritePerResponse: true,
      readConsolidation: true,
      continuationNudge: true,
    },
    ui: {
      showThinking: true,
      quiet: false,
      promptPrefix: '[pro]',
    },
    subagentMode: 'base',
  },
];

/**
 * Реестр режимов.
 *
 * Использование:
 * ```ts
 * const registry = new ModeRegistry();
 * registry.register(customMode);
 * const mode = registry.get('pro');
 * ```
 */
export class ModeRegistry {
  private modes: Map<string, ModeConfig> = new Map();
  private defaultId: string;

  constructor() {
    // Регистрируем встроенные режимы
    for (const mode of BUILTIN_MODES) {
      this.modes.set(mode.id, mode);
    }
    this.defaultId = 'base';
  }

  /** Регистрация/переопределение режима */
  register(mode: ModeConfig): void {
    this.modes.set(mode.id, mode);
  }

  /** Регистрация нескольких режимов */
  registerAll(modes: ModeConfig[]): void {
    for (const mode of modes) {
      this.register(mode);
    }
  }

  /** Получение конфига по id */
  get(id: string): ModeConfig | undefined {
    return this.modes.get(id);
  }

  /** Получение конфика по id (с fallback на default) */
  getOrFallback(id: string): ModeConfig {
    return this.modes.get(id) ?? this.modes.get(this.defaultId)!;
  }

  /** Список всех режимов */
  list(): ModeConfig[] {
    return Array.from(this.modes.values());
  }

  /** Id режима по умолчанию */
  getDefault(): string {
    return this.defaultId;
  }

  /** Установка режима по умолчанию */
  setDefault(id: string): void {
    if (this.modes.has(id)) {
      this.defaultId = id;
    }
  }

  /** Проверка существования режима */
  has(id: string): boolean {
    return this.modes.has(id);
  }

  /** Загрузка кастомных режимов из конфига */
  loadFromConfig(modesConfig?: Record<string, Partial<ModeConfig>>): void {
    if (!modesConfig) return;

    for (const [id, overrides] of Object.entries(modesConfig)) {
      const baseId = (overrides as any).extends;
      const base = baseId ? this.modes.get(baseId) : this.modes.get('base');

      if (base) {
        const mode: ModeConfig = {
          ...base,
          ...overrides,
          id,
          constraints: { ...base.constraints, ...(overrides.constraints || {}) },
          ui: { ...base.ui, ...(overrides.ui || {}) },
          behaviors: { ...base.behaviors, ...(overrides.behaviors || {}) },
        };
        this.register(mode);
      } else {
        // Нет base — регистрируем как есть
        this.register(overrides as ModeConfig);
      }
    }
  }
}
