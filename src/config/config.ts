import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppConfig } from './types.js';

/**
 * Загрузка и сохранение конфигурации.
 *
 * Конфигурация собирается из трёх источников (в порядке приоритета):
 * 1. DEFAULT_CONFIG — встроенные значения по умолчанию
 * 2. ~/.mma/config.json — глобальная конфигурация пользователя
 * 3. .mmrc — проектная конфигурация (перезаписывает глобальную)
 *
 * Также поддерживаются переменные окружения:
 * - MMA_PROVIDER — провайдер
 * - MMA_MODEL — модель
 *
 * @module config/config
 */

const DEFAULT_CONFIG: AppConfig = {
  providers: {
    lmstudio: {
      type: 'openai-compat',
      url: 'http://localhost:1234/v1',
      apiKey: null,
      models: {
        'qwen/qwen3.5-9b': {
          model: 'qwen/qwen3.5-9b',
          contextWindow: 32768,
          params: { temperature: 0.7, top_p: 0.9, max_tokens: 4096 },
        },
      },
    },
    ollama: {
      type: 'openai-compat',
      url: 'http://localhost:11434/v1',
      apiKey: null,
      models: {
        'qwen3.5:9b': {
          model: 'qwen3.5:9b',
          contextWindow: 32768,
          params: { temperature: 0.7, top_p: 0.9, num_ctx: 32768 },
        },
      },
    },
  },
  active: { provider: 'lmstudio', model: 'qwen/qwen3.5-9b' },
  agent: {
    maxSteps: 100, autoCompact: true, compactThreshold: 0.70,
    toolTimeout: 120, maxOutputLength: 2000, showThinking: false, mode: 'base',
    skillTokenBudget: 4000, maxSkillsBase: 2, maxSkillsPro: 0,
  },
};

/** Ищет корень проекта (по .mmrc или package.json) */
function findProjectRoot(): string | null {
  let dir = resolve(process.cwd());
  while (true) {
    if (existsSync(join(dir, '.mmrc')) || existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Рекурсивное слияние объектов (deep merge) */
function deepAssign(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const tv = target[key];
    const sv = source[key];
    if (tv && typeof tv === 'object' && !Array.isArray(tv) && sv && typeof sv === 'object' && !Array.isArray(sv)) {
      deepAssign(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      target[key] = sv;
    }
  }
}

/**
 * Загружает конфигурацию из всех источников.
 * Приоритет: DEFAULT < global < project < env vars.
 */
export function loadConfig(): AppConfig {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;

  const projectRoot = findProjectRoot();
  if (projectRoot) {
    const rcPath = join(projectRoot, '.mmrc');
    if (existsSync(rcPath)) {
      try {
        const rc = JSON.parse(readFileSync(rcPath, 'utf-8'));
        deepAssign(config as unknown as Record<string, unknown>, rc);
      } catch { /* ignore invalid config */ }
    }
  }

  const globalPath = join(homedir(), '.mma', 'config.json');
  if (existsSync(globalPath)) {
    try {
      const global = JSON.parse(readFileSync(globalPath, 'utf-8'));
      deepAssign(config as unknown as Record<string, unknown>, global);
    } catch { /* ignore */ }
  }

  if (process.env.MMA_PROVIDER) config.active.provider = process.env.MMA_PROVIDER;
  if (process.env.MMA_MODEL) config.active.model = process.env.MMA_MODEL;

  return config;
}

const MMA_DIR = join(homedir(), '.mma');

/** Создаёт директории ~/.mma/, state/, cache/, index/ если не существуют */
export function ensureMmaDir(): void {
  for (const dir of [MMA_DIR, join(MMA_DIR, 'state'), join(MMA_DIR, 'cache'), join(MMA_DIR, 'index')]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/** Сохраняет конфигурацию в ~/.mma/config.json */
export function saveConfig(config: AppConfig): void {
  const globalPath = join(MMA_DIR, 'config.json');
  ensureMmaDir();
  writeFileSync(globalPath, JSON.stringify(config, null, 2), 'utf-8');
}
