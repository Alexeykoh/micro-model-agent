/**
 * Тестирование MMA агента на разных сценариях.
 *
 * Запуск:
 *   bun run test-agent-conversation.ts                    # все сценарии
 *   bun run test-agent-conversation.ts --scenario chat    # один сценарий
 *   bun run test-agent-conversation.ts --list             # список сценариев
 *
 * Добавление сценария:
 *   1. Создать функцию в sections/SCENARIOS.ts
 *   2. Добавить в массив ALL_SCENARIOS
 *   3. Запустить: bun run test-agent-conversation.ts
 *
 * Настройка через env:
 *   MMA_LLM_URL=http://localhost:1234/v1
 *   MMA_LLM_MODEL=qwen/qwen3.5-9b
 *   MMA_CTX=32768
 */
import { OpenAICompat } from './src/llm/openai-compat.js';
import { ToolRegistry } from './src/tools/registry.js';
import { runAgentLoop } from './src/agent/loop.js';
import { ContextManager } from './src/agent/context.js';
import type { ChatMessage } from './src/llm/provider.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// ─── Config ───────────────────────────────────────────────

const BASE_URL = process.env.MMA_LLM_URL || 'http://localhost:1234/v1';
const MODEL = process.env.MMA_LLM_MODEL || 'qwen/qwen3.5-9b';
const CTX = parseInt(process.env.MMA_CTX || '32768', 10);

// ─── Types ────────────────────────────────────────────────

export interface TestResult {
  scenario: string;
  input: string;
  output: string;
  toolCalls: string[];
  turns: number;
  hasEmptyResponse: boolean;
  mentionsUserProfile: boolean;
  issues: string[];
}

export interface Scenario {
  name: string;
  description: string;
  prompts: string[];
}

// ─── Renderer mock (без Ink зависимостей) ─────────────────

function createSilentRenderer() {
  return {
    write: () => {},
    writeLine: () => {},
    writeNewline: () => {},
    writeError: () => {},
    writeWarning: () => {},
    writeInfo: () => {},
    writeSuccess: () => {},
    writeDim: () => {},
    writeBracketTag: () => {},
    writeHeading: () => {},
    writeToolHeader: () => {},
    writeToolPreview: () => {},
    writeToolResult: () => {},
    writeMarkdownChunk: () => {},
    writeSpinner: () => {},
    clearSpinner: () => {},
    commitMarkdown: () => {},
    updateContextUsage: () => {},
    updateStatus: () => {},
    clear: () => {},
    prompt: async () => '',
    promptWithChoices: async () => '',
    setCommands: () => {},
    abort: () => {},
    resetAbort: () => {},
    setMode: () => {},
    writeFileOutput: () => {},
    destroy: () => {},
    abortSignal: undefined,
  } as any;
}

// ─── Runner ───────────────────────────────────────────────

export async function runScenario(
  provider: OpenAICompat,
  registry: ToolRegistry,
  scenario: Scenario,
  verbose = false,
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const prompt of scenario.prompts) {
    const result: TestResult = {
      scenario: scenario.name,
      input: prompt,
      output: '',
      toolCalls: [],
      turns: 0,
      hasEmptyResponse: false,
      mentionsUserProfile: false,
      issues: [],
    };

    const renderer = createSilentRenderer();
    const ctx = new ContextManager(CTX);

    result.turns++;
    try {
      const agentResult = await runAgentLoop(
        provider,
        registry,
        prompt,
        ctx,
        undefined,
        renderer,
        'lmstudio',
        { quiet: true, mode: 'base' },
      );

      const lastAssistant = [...agentResult.messages].reverse().find(m => m.role === 'assistant');
      result.output = lastAssistant?.content || '';

      // Extract tool calls
      const toolCallMatches = result.output.matchAll(/<tool_call>\{"name":"([^"]+)"/g);
      for (const match of toolCallMatches) {
        result.toolCalls.push(match[1]);
      }

      if (!result.output.trim()) {
        result.hasEmptyResponse = true;
        result.issues.push('Empty response');
      }

      if (/user.?profile|профиль пользователя/i.test(result.output)) {
        result.mentionsUserProfile = true;
        result.issues.push('Mentions user profile');
      }

    } catch (err: any) {
      result.issues.push(`Error: ${err.message}`);
    }

    results.push(result);

    if (verbose) {
      const short = result.output.slice(0, 120).replace(/\n/g, ' ');
      process.stdout.write(`  User: ${prompt}\n`);
      process.stdout.write(`  Agent: ${short}${result.output.length > 120 ? '...' : ''}\n`);
      if (result.toolCalls.length > 0) {
        process.stdout.write(`  Tools: ${result.toolCalls.join(', ')}\n`);
      }
      if (result.issues.length > 0) {
        process.stdout.write(`  ⚠ ${result.issues.join('; ')}\n`);
      }
      process.stdout.write('\n');
    }
  }

  return results;
}

// ─── Scenarios (ДОБАВЛЯЙ СЮДА новые) ──────────────────────

const SCENARIOS: Scenario[] = [
  {
    name: 'chat',
    description: 'Простая беседа на разные темы',
    prompts: [
      'Привет! Как дела?',
      'Как тебя зовут?',
      'Что ты умеешь?',
      'Расскажи шутку',
      'Какой твой любимый язык программирования?',
      'Что такое программирование?',
      'Спасибо за беседу!',
      'До свидания!',
    ],
  },
  {
    name: 'read',
    description: 'Чтение файлов проекта',
    prompts: [
      'Прочитай файл package.json',
      'Покажи содержимое src/index.ts',
      'Что в файле src/agent/loop.ts? Покажи первые 20 строк',
    ],
  },
  {
    name: 'code',
    description: 'Написание кода',
    prompts: [
      'Напиши функцию fibonacci на TypeScript',
      'Создай класс Logger на TypeScript с методами info, warn, error',
      'Напиши функцию debounce на TypeScript',
    ],
  },
  {
    name: 'project',
    description: 'Создание микро-проекта из 5 файлов',
    prompts: [
      'Создай микро-проект "utils" в папке test-project — 5 маленьких файлов: index.ts (экспорт), math.ts (функции add/sub/mul), string.ts (функции capitalize/reverse), array.ts (функции unique/flatten), types.ts (типы). Каждый файл — 5-15 строк.',
    ],
  },
  {
    name: 'topics',
    description: 'Смена тем общения',
    prompts: [
      'Давай поговорим о космосе',
      'А теперь расскажи про пиратов',
      'Переключись на тему кулинарии — что можно приготовить из яиц?',
      'Вернёмся к программированию — что такое рекурсия?',
    ],
  },
  {
    name: 'code-quality',
    description: 'Качество кода: создание и выполнение (агент проверяет сам)',
    prompts: [
      'Напиши функцию mergeSort на TypeScript',
      'Создай файл test-run.ts с функцией factorial(n) и вызовом console.log(factorial(5)). Выполни через bun.',
      'Напиши класс Stack<T> на TypeScript с методами push, pop, peek, size',
    ],
  },
  {
    name: 'code-explain',
    description: 'Объяснение кода: агент понимает что написал',
    prompts: [
      'Напиши функцию memoize на TypeScript. Объясни как она работает.',
      'Создай файл async-map.ts с функцией asyncMap (параллельное применение async-функции к массиву). Объясни разницу параллельного и последовательного подхода.',
    ],
  },
  {
    name: 'auto-fix',
    description: 'Агент сам ловит и чинит ошибки синтаксиса (без просьбы)',
    prompts: [
      'Напиши функцию parseJSON на TypeScript которая принимает строку и возвращает объект. Оберни в try-catch.',
      'Создай класс LinkedList<T> на TypeScript с методами append, prepend, toArray, size',
      'Напиши функцию groupBy на TypeScript которая группирует массив объектов по ключу. Пример: groupBy([{type:"a",v:1},{type:"b",v:2},{type:"a",v:3}], "type") → {a:[...], b:[...]}',
    ],
  },
];

// ─── Analysis ─────────────────────────────────────────────

function analyzeResults(allResults: TestResult[]) {
  console.log('\n' + '═'.repeat(60));
  console.log('📊 АНАЛИЗ РЕЗУЛЬТАТОВ');
  console.log('═'.repeat(60));

  const total = allResults.length;
  const withIssues = allResults.filter(r => r.issues.length > 0);
  const empty = allResults.filter(r => r.hasEmptyResponse);
  const withTools = allResults.filter(r => r.toolCalls.length > 0);

  console.log(`\nВсего промптов: ${total}`);
  console.log(`С проблемами: ${withIssues.length}`);
  console.log(`Пустые ответы: ${empty.length}`);
  console.log(`Использовали инструменты: ${withTools.length}`);

  // Tool usage
  const toolCounts: Record<string, number> = {};
  for (const r of allResults) {
    for (const t of r.toolCalls) {
      toolCounts[t] = (toolCounts[t] || 0) + 1;
    }
  }
  if (Object.keys(toolCounts).length > 0) {
    console.log('\nИнструменты:');
    for (const [tool, count] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${tool}: ${count}`);
    }
  }

  // Response lengths
  const lengths = allResults.map(r => r.output.length);
  console.log(`\nДлина ответов: min=${Math.min(...lengths)}, max=${Math.max(...lengths)}, avg=${Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)}`);

  // Issues
  if (withIssues.length > 0) {
    console.log('\nПроблемы:');
    for (const r of withIssues) {
      console.log(`  [${r.scenario}] ${r.issues.join('; ')}`);
    }
  }

  // Per-scenario summary
  console.log('\nПо сценариям:');
  const byScenario = new Map<string, TestResult[]>();
  for (const r of allResults) {
    const arr = byScenario.get(r.scenario) || [];
    arr.push(r);
    byScenario.set(r.scenario, arr);
  }
  for (const [name, results] of byScenario) {
    const ok = results.filter(r => r.issues.length === 0).length;
    const total = results.length;
    const icon = ok === total ? '✅' : '⚠️';
    console.log(`  ${icon} ${name}: ${ok}/${total} OK`);
  }
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // --list: show available scenarios
  if (args.includes('--list')) {
    console.log('Доступные сценарии:\n');
    for (const s of SCENARIOS) {
      console.log(`  ${s.name.padEnd(12)} ${s.description} (${s.prompts.length} промптов)`);
    }
    console.log(`\nВсего: ${SCENARIOS.length} сценариев, ${SCENARIOS.reduce((a, s) => a + s.prompts.length, 0)} промптов`);
    return;
  }

  // --scenario <name>: filter
  const scenarioIdx = args.indexOf('--scenario');
  const filterName = scenarioIdx !== -1 ? args[scenarioIdx + 1] : null;
  const scenarios = filterName
    ? SCENARIOS.filter(s => s.name === filterName)
    : SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`Сценарий "${filterName}" не найден. Используйте --list для списка.`);
    process.exit(1);
  }

  console.log('🧪 Тестирование MMA агента\n');
  console.log(`Provider: ${BASE_URL}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Context: ${CTX}\n`);

  // Check LLM
  try {
    const res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('Not OK');
    console.log('✅ LLM доступен\n');
  } catch {
    console.error('❌ LLM недоступен. Запустите LM Studio.');
    process.exit(1);
  }

  const provider = new OpenAICompat(BASE_URL, MODEL, CTX);

  // Create isolated temp directory for testing
  const testDir = mkdtempSync(join(tmpdir(), 'mma-test-'));
  const origCwd = process.cwd();
  process.chdir(testDir);

  // Set up minimal project structure
  writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test-project', version: '1.0.0', type: 'module' }, null, 2));
  mkdirSync(join(testDir, 'src'), { recursive: true });
  writeFileSync(join(testDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, esModuleInterop: true, skipLibCheck: true, jsx: 'react-jsx' } }, null, 2));

  // Install typescript so syntax checking works (tsc --noEmit)
  try {
    execSync('npm install typescript --save-dev --silent', { cwd: testDir, stdio: 'pipe', timeout: 30000 });
  } catch { /* ignore — syntax checks will be skipped if tsc unavailable */ }

  console.log(`📁 Test directory: ${testDir}\n`);

  const registry = new ToolRegistry(testDir);
  const allResults: TestResult[] = [];

  try {
    for (const scenario of scenarios) {
      console.log(`━━━ ${scenario.name}: ${scenario.description} ━━━`);
      const results = await runScenario(provider, registry, scenario, true);
      allResults.push(...results);
    }

    analyzeResults(allResults);
  } finally {
    // Restore original CWD and cleanup
    process.chdir(origCwd);
    if (args.includes('--keep')) {
      console.log(`\n📂 Files kept in: ${testDir}`);
    } else {
      rmSync(testDir, { recursive: true, force: true });
      console.log(`\n🧹 Cleaned up: ${testDir}`);
    }
  }

  console.log('\n✅ Готово');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
