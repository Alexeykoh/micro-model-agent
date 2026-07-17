import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import type { AppConfig } from './config/types.js';
import { saveConfig } from './config/config.js';

interface LmStudioModel {
  id: string;
  object: string;
}

interface OllamaModel {
  name: string;
  model: string;
}

function separator(): void {
  console.log(pc.dim('─'.repeat(50)));
}

function heading(text: string): void {
  console.log(`\n${pc.cyan(pc.bold(text))}`);
}

function success(text: string): void {
  console.log(`  ${pc.green('✓')} ${text}`);
}

function warn(text: string): void {
  console.log(`  ${pc.yellow('⚠')} ${text}`);
}

function info(text: string): void {
  console.log(`  ${pc.dim('→')} ${text}`);
}

function error(text: string): void {
  console.log(`  ${pc.red('✗')} ${text}`);
}

async function ask(rl: import('node:readline/promises').Interface, question: string, defaultValue?: string): Promise<string> {
  const hint = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(pc.cyan(`  ${question}${hint}: `));
  return answer.trim() || defaultValue || '';
}

async function askSelect(rl: import('node:readline/promises').Interface, question: string, options: string[]): Promise<number> {
  console.log(`\n  ${pc.cyan(question)}`);
  for (let i = 0; i < options.length; i++) {
    console.log(`    ${pc.bold(String(i + 1))}. ${options[i]}`);
  }
  while (true) {
    const ans = (await rl.question(pc.cyan('  Выбери (1-' + options.length + '): '))).trim();
    const num = parseInt(ans);
    if (num >= 1 && num <= options.length) return num - 1;
    console.log(pc.red(`  Введи число от 1 до ${options.length}`));
  }
}

async function waitForEnter(rl: import('node:readline/promises').Interface, msg: string): Promise<void> {
  await rl.question(pc.yellow(`  ${msg} (нажми Enter)`));
}

async function testChat(url: string, model: string, apiKey: string | null): Promise<boolean> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const baseUrl = url.replace(/\/+$/, '');
    const body = {
      model,
      messages: [{ role: 'user', content: 'Say hello in one word.' }],
      max_tokens: 10,
      stream: false,
    };
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      error(`API ответила ошибкой: ${(err as any).error?.message || res.statusText}`);
      return false;
    }
    const data = await res.json() as any;
    const choice = data.choices?.[0];
    let content = choice?.message?.content || choice?.delta?.content || '';
    // Some models (e.g. thinking models) may put text in reasoning_content
    if (!content && choice?.message?.reasoning_content) {
      content = choice.message.reasoning_content;
    }
    if (content) {
      success(`Модель ответила: ${pc.dim(content.trim().slice(0, 80))}`);
      return true;
    }
    // If empty, show response structure and try with stream: true
    warn('Нестандартный ответ сервера:');
    info(`Структура: choices=${data.choices?.length || 0}, keys=${Object.keys(data).join(', ')}`);
    if (choice?.message) info(`message keys: ${Object.keys(choice.message).join(', ')}`);
    info('Пробую stream-режим...');
    return await testChatStream(baseUrl, model, headers);
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      error('Таймаут — проверь, что сервер запущен');
    } else if (e.code === 'ECONNREFUSED' || e.cause?.code === 'ECONNREFUSED') {
      error('Сервер не отвечает (connection refused)');
    } else {
      error(`Ошибка подключения: ${e.message}`);
    }
    return false;
  }
}

async function testChatStream(baseUrl: string, model: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say hello in one word.' }],
        max_tokens: 10,
        stream: true,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      error(`Stream-запрос тоже не удался: ${res.status}`);
      return false;
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n').filter(l => l.startsWith('data: '))) {
        const json = line.slice(6).trim();
        if (json === '[DONE]') break;
        try {
          const parsed = JSON.parse(json);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) fullContent += delta.content;
          if (delta?.reasoning_content) fullContent += delta.reasoning_content;
        } catch { /* skip */ }
      }
    }
    if (fullContent.trim()) {
      success(`Модель ответила: ${pc.dim(fullContent.trim().slice(0, 80))}`);
      return true;
    }
    error('Stream-режим тоже вернул пустой ответ');
    return false;
  } catch (e: any) {
    error(`Stream-запрос: ${e.message}`);
    return false;
  }
}

async function checkLmStudio(): Promise<LmStudioModel[]> {
  try {
    const res = await fetch('http://localhost:1234/v1/models', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.data || data.models || []) as LmStudioModel[];
  } catch {
    return [];
  }
}

async function checkOllama(): Promise<OllamaModel[]> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.models || []) as OllamaModel[];
  } catch {
    return [];
  }
}

async function setupLmStudioWizard(rl: import('node:readline/promises').Interface, config: AppConfig): Promise<boolean> {
  heading('LM Studio');
  info('Проверяю localhost:1234...');
  let models = await checkLmStudio();

  if (models.length === 0) {
    let tried = false;
    while (models.length === 0) {
      if (tried) {
        warn('Всё ещё нет ответа от LM Studio.');
        return false;
      }
      tried = true;
      warn('LM Studio не отвечает на localhost:1234.');
      info('Убедись, что:');
      info('1. LM Studio запущена');
      info('2. Вкладка Local Server → Start Server');
      info('3. Сервер слушает порт 1234');
      info('4. Разреши доступ в фаерволе при запросе');
      await waitForEnter(rl, 'Нажми Enter, когда сервер будет запущен');
      models = await checkLmStudio();
    }
  }

  if (models.length === 0) {
    warn('Модели не загружены в LM Studio.');
    info('Открой LM Studio → Local Server tab → выбери модель из списка');
    info('Или скачай Qwen 3.5-9B: https://huggingface.co/Qwen/Qwen3.5-9B-Instruct-GGUF');
    await waitForEnter(rl, 'Нажми Enter после загрузки модели');
    models = await checkLmStudio();
  }

  if (models.length === 0) {
    error('Не удалось обнаружить модели в LM Studio.');
    return false;
  }

  success('Найдены модели:');
  for (let i = 0; i < models.length; i++) {
    console.log(`    ${pc.bold(String(i + 1))}. ${models[i].id}`);
  }

  const defaultIdx = Math.min(0, models.length - 1);
  const ans = await rl.question(pc.cyan(`  Выбери модель (1-${models.length}) [${defaultIdx + 1}]: `));
  const idx = (parseInt(ans) || defaultIdx + 1) - 1;
  const modelId = models[Math.min(idx, models.length - 1)].id;

  // Infer context window
  let ctx = 32768;
  const ctxAns = await rl.question(pc.cyan(`  Context window (токенов) [${ctx}]: `));
  if (ctxAns.trim()) ctx = parseInt(ctxAns) || ctx;

  config.providers['lmstudio'] = {
    type: 'openai-compat',
    url: 'http://localhost:1234/v1',
    apiKey: null,
    models: {},
  };
  config.providers['lmstudio'].models[modelId] = {
    model: modelId,
    contextWindow: ctx,
    params: { temperature: 0.7, max_tokens: 4096 },
  };
  config.active = { provider: 'lmstudio', model: modelId };

  success(`Модель ${modelId} добавлена в провайдер lmstudio`);

  heading('Тест соединения');
  const ok = await testChat('http://localhost:1234/v1', modelId, null);
  return ok;
}

async function setupOllamaWizard(rl: import('node:readline/promises').Interface, config: AppConfig): Promise<boolean> {
  heading('Ollama');
  info('Проверяю localhost:11434...');
  let models = await checkOllama();

  if (models.length === 0) {
    let tried = false;
    while (models.length === 0) {
      if (tried) {
        warn('Всё ещё нет ответа от Ollama.');
        return false;
      }
      tried = true;
      warn('Ollama не отвечает на localhost:11434.');
      info('Убедись, что:');
      info('1. Ollama запущен (ollama serve)');
      await waitForEnter(rl, 'Нажми Enter после запуска');
      models = await checkOllama();
    }
  }

  success('Найдены модели:');
  for (let i = 0; i < models.length; i++) {
    console.log(`    ${pc.bold(String(i + 1))}. ${models[i].name}`);
  }

  const defaultIdx = Math.min(0, models.length - 1);
  const ans = await rl.question(pc.cyan(`  Выбери модель (1-${models.length}) [${defaultIdx + 1}]: `));
  const idx = (parseInt(ans) || defaultIdx + 1) - 1;
  const modelEntry = models[Math.min(idx, models.length - 1)];
  const modelName = modelEntry.name;

  let ctx = 32768;
  const ctxAns = await rl.question(pc.cyan(`  Context window (токенов) [${ctx}]: `));
  if (ctxAns.trim()) ctx = parseInt(ctxAns) || ctx;

  config.providers['ollama'] = {
    type: 'openai-compat',
    url: 'http://localhost:11434/v1',
    apiKey: null,
    models: {},
  };
  config.providers['ollama'].models[modelName] = {
    model: modelName,
    contextWindow: ctx,
    params: { temperature: 0.7, max_tokens: 4096 },
  };
  config.active = { provider: 'ollama', model: modelName };

  success(`Модель ${modelName} добавлена в провайдер ollama`);

  heading('Тест соединения');
  const ok = await testChat('http://localhost:11434/v1', modelName, null);
  return ok;
}

async function setupRemoteWizard(rl: import('node:readline/promises').Interface, config: AppConfig): Promise<boolean> {
  heading('Remote API (OpenAI-совместимый)');

  const name = await ask(rl, 'Название провайдера', 'together');
  let url = await ask(rl, 'Base URL (напр. https://api.together.xyz/v1)');
  if (!url) url = 'https://api.together.xyz/v1';
  const apiKey = await ask(rl, 'API key (если есть)');

  const modelKey = await ask(rl, 'Название модели (напр. Qwen/Qwen3.5-9B-Instruct)', 'Qwen/Qwen3.5-9B-Instruct');
  let ctx = 32768;
  const ctxAns = await rl.question(pc.cyan(`  Context window [${ctx}]: `));
  if (ctxAns.trim()) ctx = parseInt(ctxAns) || ctx;

  config.providers[name] = {
    type: 'openai-compat',
    url,
    apiKey: apiKey || null,
    models: {},
  };
  config.providers[name].models[modelKey] = {
    model: modelKey,
    contextWindow: ctx,
    params: { temperature: 0.7, max_tokens: 4096 },
  };
  config.active = { provider: name, model: modelKey };

  success(`Провайдер "${name}" с моделью "${modelKey}" добавлен`);

  heading('Тест соединения');
  const ok = await testChat(url, modelKey, apiKey || null);
  return ok;
}

function getVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.2.21';
  }
}

function makeDefaultConfig(): AppConfig {
  return {
    providers: {},
    active: { provider: '', model: '' },
    agent: { maxSteps: 50, autoCompact: true, compactThreshold: 0.85, toolTimeout: 120, maxOutputLength: 2000, filterThinking: false },
  };
}

export async function runSetupWizard(): Promise<AppConfig> {
  const globalPath = join(homedir(), '.mma', 'config.json');
  if (existsSync(globalPath)) {
    return makeDefaultConfig();
  }

  const config = makeDefaultConfig();

  console.clear();
  console.log(pc.cyan(pc.bold(`\n  ⚡ Micro Models Agent (MMA) v${getVersion()}`)));
  console.log(pc.dim('  Первый запуск — давай настроим агента'));
  separator();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    let configured = false;

    while (!configured) {
      const choice = await askSelect(rl, 'Какой провайдер будем использовать?', [
        'LM Studio (локально, localhost:1234)',
        'Ollama (локально, localhost:11434)',
        'Remote API (Together AI, vLLM и др.)',
        'Настроить вручную / пропустить',
      ]);

      if (choice === 0) {
        configured = await setupLmStudioWizard(rl, config);
      } else if (choice === 1) {
        configured = await setupOllamaWizard(rl, config);
      } else if (choice === 2) {
        configured = await setupRemoteWizard(rl, config);
      } else {
        configured = true;
      }

      if (!configured && choice < 3) {
        separator();
        warn('Не удалось подключиться.');
        const retry = await askSelect(rl, 'Что делаем?', ['Попробовать другой провайдер', 'Настроить вручную']);
        if (retry === 1) configured = true;
      }
    }

    separator();
    if (config.active.provider && config.active.model) {
      saveConfig(config);
      success(`Конфигурация сохранена в ~/.mma/config.json`);
      info(`Провайдер: ${config.active.provider}`);
      info(`Модель: ${config.active.model}`);
      info(`URL: ${config.providers[config.active.provider]?.url || 'не указан'}`);
    } else {
      warn('Настройка пропущена. Используются настройки по умолчанию.');
      info('Настроить позже: mma provider add / mma model add');
      info('Или отредактировать: ~/.mma/config.json');
    }

    console.log();
  } finally {
    rl.close();
  }

  return config;
}
