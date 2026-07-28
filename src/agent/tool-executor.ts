import type { ToolHandler, ToolResult, ToolContext, ParsedToolCall } from '../tools/types.js';
import { runPreToolUseHooks, runPostToolUseHooks } from '../tools/hooks.js';
import { notifyFileChanged } from '../indexer/cache.js';
import { invalidateSystemPromptCache } from './system-prompt.js';
import type { PluginManager } from '../plugins/manager.js';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { getGroundingConfig } from '../config/config.js';

/**
 * Диспетчер инструментов с пайплайном: pre-hooks → execute → post-hooks → truncate.
 *
 * ToolExecutor — чистый диспетчер. Никакой domain-логики.
 * Вся поведенческая логика (plan enforcement, write streak, syntax check)
 * остаётся в loop.ts.
 *
 * @module agent/tool-executor
 */

/** Инструменты, требующие path validation: путь должен существовать */
const FS_TOOLS_REQUIRE_EXIST = new Set(['read_file', 'edit_file', 'delete_file', 'file_info']);

/** Инструменты, для которых проверяем только родительскую директорию */
const FS_TOOLS_CHECK_PARENT = new Set(['write_file', 'create_dir']);

/** Инструменты с source/destination */
const FS_TOOLS_COPY_MOVE = new Set(['copy_file', 'move_file']);

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
  web_browse: 2000,
};

const DEFAULT_LIMIT = 800;
const ERROR_LIMIT = 3000;

/** Паттерны ошибок "path not found" */
const PATH_NOT_FOUND_PATTERNS = [
  /cannot find path/i,
  /no such file/i,
  /does not exist/i,
  /not found/i,
  /enoent/i,
];

/** Проверяет, является ли ошибка ошибкой "path not found" */
function isPathNotFoundError(stderr: string): boolean {
  return PATH_NOT_FOUND_PATTERNS.some(p => p.test(stderr));
}

/** Извлекает путь из ошибки */
function extractPathFromError(stderr: string): string | null {
  // Windows: "Cannot find path 'E:\foo\bar' because it does not exist."
  const winMatch = stderr.match(/(?:cannot find path|no such file|does not exist)['"]\s*['"]?([A-Z]:\\[^'"]+)['"]?/i);
  if (winMatch) return winMatch[1];
  // Unix: "No such file or directory '/foo/bar'"
  const unixMatch = stderr.match(/['"]?(\/[^\s'"]+)['"]?\s*(?:because|no such)/i);
  if (unixMatch) return unixMatch[1];
  return null;
}

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
/**
 * Хэш ошибки для детекции повторяющихся паттернов.
 * Нормализует stderr, убирая вариативные части (пути, timestamps).
 */
function hashError(toolName: string, stderr: string): string {
  // Убираем пути файлов, numbers, timestamps для нормализации
  const normalized = stderr
    .replace(/[A-Z]:\\[^\s"']+/gi, '<PATH>')
    .replace(/\/[^\s"']+/g, '<PATH>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, '<TS>')
    .replace(/\b\d{10,13}\b/g, '<ID>')
    .trim();
  return `${toolName}::${normalized}`;
}

export class ToolExecutor {
  private handlers: Map<string, ToolHandler> = new Map();
  private pluginManager?: PluginManager;
  /** Повторяющиеся ошибки: hash → { count, lastStderr } */
  private recentErrors: Map<string, { count: number; lastStderr: string }> = new Map();

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

  /** Pre-flight проверка существования пути для FS-тулов */
  private preFlightCheck(name: string, args: Record<string, unknown>, cwd: string): string | null {
    const groundingCfg = getGroundingConfig();
    if (!groundingCfg.checkFiles) return null;

    const pathArg = String(args.path ?? '');
    const sourceArg = String(args.source ?? '');
    const destArg = String(args.destination ?? '');

    if (FS_TOOLS_REQUIRE_EXIST.has(name) && pathArg) {
      const resolved = resolve(cwd, pathArg);
      if (!existsSync(resolved)) {
        return `ENOENT: path not found — "${pathArg}" does not exist.\nCheck the path with glob_search before calling ${name}.`;
      }
    }

    if (FS_TOOLS_CHECK_PARENT.has(name) && pathArg) {
      const resolved = resolve(cwd, pathArg);
      const parent = dirname(resolved);
      if (parent !== resolved && !existsSync(parent)) {
        return `ENOENT: parent directory "${dirname(pathArg)}" does not exist.\nCreate it first with create_dir before calling ${name}.`;
      }
    }

    if (FS_TOOLS_COPY_MOVE.has(name)) {
      if (sourceArg) {
        const resolvedSource = resolve(cwd, sourceArg);
        if (!existsSync(resolvedSource)) {
          return `ENOENT: source path not found — "${sourceArg}" does not exist.\nCheck the source path with glob_search before calling ${name}.`;
        }
      }
      if (destArg && name === 'copy_file') {
        const resolvedDest = resolve(cwd, destArg);
        const parent = dirname(resolvedDest);
        if (parent !== resolvedDest && !existsSync(parent)) {
          return `ENOENT: parent directory of destination "${dirname(destArg)}" does not exist.\nCreate it first with create_dir.`;
        }
      }
    }

    return null;
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

    // 2.5 Pre-flight validation путей для FS-тулов
    const preFlightError = this.preFlightCheck(call.name, call.arguments, context.cwd);
    if (preFlightError) {
      return {
        result: { stdout: '', stderr: preFlightError, exitCode: 1, truncated: false },
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
    let truncatedStderr = truncateOutput(call.name, result.stderr, result.exitCode);

    // 5.5. Path-not-found enrichment — показываем содержимое родительской директории
    if (result.exitCode !== 0 && isPathNotFoundError(result.stderr)) {
      const errPath = extractPathFromError(result.stderr) ?? (call.arguments as any)?.path;
      if (errPath) {
        const parentDir = dirname(String(errPath));
        const listDirHandler = this.handlers.get('list_dir');
        if (listDirHandler) {
          try {
            const dirResult = await listDirHandler.execute({ path: parentDir }, context);
            if (dirResult.exitCode === 0 && dirResult.stdout.trim()) {
              truncatedStderr += `\n\n[ENRICHMENT] Contents of ${parentDir}:\n${dirResult.stdout}`;
            } else {
              truncatedStderr += `\n\n[ENRICHMENT] Parent directory ${parentDir} is empty or inaccessible.`;
            }
          } catch { /* enrichment is best-effort */ }
        }
      }
    }

    // 6. Error pattern detection — обогащение при повторяющихся ошибках
    if (result.exitCode !== 0 && truncatedStderr) {
      const errHash = hashError(call.name, truncatedStderr);
      const prev = this.recentErrors.get(errHash);
      if (prev) {
        prev.count++;
        if (prev.count === 2) {
          truncatedStderr += `\n[HINT] This error occurred ${prev.count} times. The input is likely wrong — double-check arguments before retrying.`;
        } else if (prev.count >= 3) {
          truncatedStderr += `\n[WARNING] Same error ${prev.count} times in a row. STOP retrying this exact call. Try a different approach or ask for help.`;
        }
      } else {
        this.recentErrors.set(errHash, { count: 1, lastStderr: truncatedStderr });
      }
      // Ограничиваем размер карты
      if (this.recentErrors.size > 50) {
        const first = this.recentErrors.keys().next().value!;
        this.recentErrors.delete(first);
      }
    } else if (result.exitCode === 0) {
      // При успехе — сбрасываем счётчик для этого инструмента
      for (const [key] of this.recentErrors) {
        if (key.startsWith(call.name + '::')) {
          this.recentErrors.delete(key);
        }
      }
    }

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
