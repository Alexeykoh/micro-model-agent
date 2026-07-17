import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppConfig } from './types.js';

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
  agent: { maxSteps: 50, autoCompact: true, compactThreshold: 0.85, toolTimeout: 120, maxOutputLength: 2000, filterThinking: false },
};

function findProjectRoot(): string | null {
  let dir = resolve(process.cwd());
  while (true) {
    if (existsSync(join(dir, '.mmrc')) || existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(): AppConfig {
  const config = { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers }, active: { ...DEFAULT_CONFIG.active }, agent: { ...DEFAULT_CONFIG.agent } };

  const projectRoot = findProjectRoot();
  if (projectRoot) {
    const rcPath = join(projectRoot, '.mmrc');
    if (existsSync(rcPath)) {
      try {
        const rc = JSON.parse(readFileSync(rcPath, 'utf-8'));
        Object.assign(config, rc);
      } catch { /* ignore invalid config */ }
    }
  }

  const globalPath = join(homedir(), '.mma', 'config.json');
  if (existsSync(globalPath)) {
    try {
      const global = JSON.parse(readFileSync(globalPath, 'utf-8'));
      Object.assign(config, global);
    } catch { /* ignore */ }
  }

  if (process.env.MMA_PROVIDER) config.active.provider = process.env.MMA_PROVIDER;
  if (process.env.MMA_MODEL) config.active.model = process.env.MMA_MODEL;

  return config;
}

const MMA_DIR = join(homedir(), '.mma');

export function ensureMmaDir(): void {
  for (const dir of [MMA_DIR, join(MMA_DIR, 'state'), join(MMA_DIR, 'cache'), join(MMA_DIR, 'index')]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function saveConfig(config: AppConfig): void {
  const globalPath = join(MMA_DIR, 'config.json');
  ensureMmaDir();
  writeFileSync(globalPath, JSON.stringify(config, null, 2), 'utf-8');
}
