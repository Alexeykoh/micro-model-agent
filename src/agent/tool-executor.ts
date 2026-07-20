import type { ToolHandler, ToolResult, ToolContext, ParsedToolCall } from '../tools/types.js';
import { runPreToolUseHooks, runPostToolUseHooks } from '../tools/hooks.js';
import { notifyFileChanged } from '../indexer/cache.js';
import { invalidateSystemPromptCache } from './system-prompt.js';
import type { PluginManager } from '../plugins/manager.js';

/**
 * Диспетчер инструментов с пайплайном: pre-hooks → execute → post-hooks → truncate.
 *
 * ToolExecutor — чистый диспетчер. Никакой domain-логики.
 * Вся поведенческая логика (plan enforcement, write streak, syntax check)
 * остаётся в loop.ts.
 *
 * @module agent/tool-executor
 */

/** Инструменты, которые модифицируют файловую систему */
const MODIFYING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'copy_file', 'move_file']);

/** Извлекает пути изменённых файлов из аргументов инструмента */
function getChangedFilePaths(toolName: string, args: Record<string, unknown>): string[] {
  const normalize = (p: unknown) => String(p ?? '').replace(/\\/g, '/');
  switch (toolName) {
    case 'write_file': return [normalize(args.path)];
    case 'edit_file':  return [normalize(args.path)];
    case 'delete_file': return [normalize(args.path)];
    case 'copy_file':  return [normalize(args.destination)];
    case 'move_file':  return [normalize(args.source), normalize(args.destination)];
    default: return [];
  }
}

/** Лимиты обрезки вывода по инструментам (в символах) */
const TRUNCATION_LIMITS: Record<string, number> = {
  read_file: 2000,
  write_file: 200,
  edit_file: 300,
  bash: 1500,
  list_dir: 1500,
  glob_search: 1000,
  grep_search: 1500,
  tree: 1500,
  subagent: 500,
  web_search: 1000,
  web_fetch: 1500,
};

const DEFAULT_LIMIT = 800;
const ERROR_LIMIT = 3000;

/** Обрезка вывода инструмента для экономии токенов */
function truncateOutput(toolName: string, output: string, exitCode: number): string {
  if (exitCode !== 0) {
    return output.length > ERROR_LIMIT ? output.slice(0, ERROR_LIMIT) + '\n...[truncated]' : output;
  }
  const limit = TRUNCATION_LIMITS[toolName] ?? DEFAULT_LIMIT;
  if (output.length <= limit) return output;
  return output.slice(0, limit) + '\n...[truncated]';
}

/** Результат выполнения ToolExecutor */
export interface ExecutorResult {
  result: ToolResult;
  /** Время выполнения в секундах */
  elapsed: number;
}

/**
 * Диспетчер инструментов.
 *
 * Пайплайн для каждого tool call:
 * 1. pre-hooks (runPreToolUseHooks) — могут заблокировать выполнение
 * 2. handler.execute() — выполнение инструмента
 * 3. post-hooks (runPostToolUseHooks)
 * 4. Уведомление indexer (для модифицирующих инструментов)
 * 5. Обрезка вывода (truncateOutput)
 */
export class ToolExecutor {
  private handlers: Map<string, ToolHandler> = new Map();
  private pluginManager?: PluginManager;

  /** Установка менеджера плагинов */
  setPluginManager(pm: PluginManager): void {
    this.pluginManager = pm;
  }

  /** Регистрация обработчика инструмента */
  register(handler: ToolHandler): void {
    this.handlers.set(handler.name, handler);
  }

  /** Регистрация нескольких обработчиков */
  registerAll(handlers: ToolHandler[]): void {
    for (const h of handlers) {
      this.register(h);
    }
  }

  /** Проверка существования обработчика */
  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** Получение обработчика по имени */
  get(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  /** Получение определений всех инструментов для LLM */
  getDefinitions() {
    return Array.from(this.handlers.values()).map(h => h.definition);
  }

  /**
   * Выполнение tool call через пайплайн.
   *
   * @param call - инструментальный вызов из LLM
   * @param context - контекст выполнения (cwd, renderer и т.д.)
   * @param hookCmd - строка для хуков (bash command или tool name + args)
   * @returns результат выполнения с обрезанным выводом
   */
  async execute(
    call: ParsedToolCall,
    context: ToolContext,
    hookCmd: string,
  ): Promise<ExecutorResult> {
    const start = performance.now();

    // 1. Pre-hooks
    const preHook = runPreToolUseHooks(context.cwd, call.name, hookCmd);
    if (!preHook.continue) {
      return {
        result: {
          stdout: '',
          stderr: `Hook blocked: ${preHook.message || ''}`,
          exitCode: 1,
          truncated: false,
        },
        elapsed: (performance.now() - start) / 1000,
      };
    }

    // 1.5. Plugin: tool:before
    if (this.pluginManager) {
      try {
        await this.pluginManager.emit('tool:before', call.name, call.arguments);
      } catch (e: any) {
        if (e.name === 'PluginError') {
          return {
            result: { stdout: '', stderr: 'Plugin blocked: ' + e.message, exitCode: 1, truncated: false },
            elapsed: (performance.now() - start) / 1000,
          };
        }
      }
    }

    // 2. Execute handler
    const handler = this.handlers.get(call.name);
    if (!handler) {
      return {
        result: {
          stdout: '',
          stderr: `Unknown tool: ${call.name}`,
          exitCode: 1,
          truncated: false,
        },
        elapsed: (performance.now() - start) / 1000,
      };
    }

    let result: ToolResult;
    try {
      result = await handler.execute(call.arguments, context);
    } catch (e: any) {
      result = {
        stdout: '',
        stderr: `Tool error: ${e.message}`,
        exitCode: 1,
        truncated: false,
      };
    }

    // 3. Post-hooks
    runPostToolUseHooks(context.cwd, call.name, hookCmd, result.stdout, result.exitCode);

    // 3.5. Plugin: tool:after
    if (this.pluginManager) {
      try {
        await this.pluginManager.emit('tool:after', call.name, result);
      } catch { /* plugin errors non-fatal in post */ }
    }

    // 4. Notify indexer (для модифицирующих инструментов)
    if (result.exitCode === 0 && MODIFYING_TOOLS.has(call.name)) {
      const paths = getChangedFilePaths(call.name, call.arguments);
      for (const p of paths) {
        notifyFileChanged(p);
      }
      invalidateSystemPromptCache();
    }

    // 5. Truncate output
    const truncatedStdout = truncateOutput(call.name, result.stdout, result.exitCode);
    const truncatedStderr = truncateOutput(call.name, result.stderr, result.exitCode);

    const elapsed = (performance.now() - start) / 1000;

    return {
      result: {
        ...result,
        stdout: truncatedStdout,
        stderr: truncatedStderr,
        truncated: result.truncated || truncatedStdout !== result.stdout || truncatedStderr !== result.stderr,
      },
      elapsed,
    };
  }
}
