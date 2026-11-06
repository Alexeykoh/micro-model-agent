/** Исполнитель тулов: allowlist, плагины, таймауты, мемо read-only. */
import type { ToolContext, ToolCall, ToolResult, PluginManager } from "./types";
import type { ToolRegistry } from "./registry";
import { filterToolsByTags } from "./filter-tools";
import { AsyncLock } from "./async-lock";
import { t } from "../i18n/index";
import { ToolMemo } from "./executor-memo";
import {
  allowedToolNames,
  enforcePathArgs,
  enforceUrlArgs,
  createPathGuard,
} from "./executor-security";
import { runBeforeToolPlugins, runAfterToolPlugins } from "./executor-hooks";
import { runToolWithTimeout } from "./executor-call";
import { finalizeToolResult, logToolResult } from "./executor-result";

/** Исполнитель: реестр, контекст, плагины, сессионное мемо. */
export class ToolExecutor {
  private registry: ToolRegistry;
  private ctx: ToolContext;
  private pluginManager: PluginManager;
  /** Сериализатор плагин-хуков, общий для родителя и его форков. */
  private hookLock: AsyncLock;
  /** Сессионное мемо read-only результатов; у форков общее хранилище. */
  private memo: ToolMemo;

  constructor(
    registry: ToolRegistry,
    ctx: ToolContext,
    pluginManager: PluginManager,
    /**
     * Общий с родителем мемо. `fork()` передаёт сюда родительскую Map, чтобы
     * мутация в субагенте (write/bash) инвалидировала кеш чтений всего прогона
     * — иначе параллельный субагент мог бы оставить родителю устаревший
     * `read_file`. Обычные исполнители создают свой мемо.
     */
    memo: Map<string, { result: ToolResult; at: number }> = new Map(),
    /** Общий с родителем сериализатор плагин-хуков (см. AsyncLock). */
    hookLock: AsyncLock = new AsyncLock(),
  ) {
    this.registry = registry;
    this.ctx = ctx;
    this.pluginManager = pluginManager;
    this.memo = new ToolMemo(() => this.ctx.sessionId, memo);
    this.hookLock = hookLock;
  }

  /**
   * Изолированная копия исполнителя для КОНКУРЕНТНОГО вызова одного тула.
   * Клонирует ToolContext по дескрипторам, даёт собственные scope/cleanup/
   * activeCallId, но РАЗДЕЛЯЕТ мемо, реестр и (по умолчанию) менеджер плагинов.
   * @param pluginManager свой — субагенту: иначе состояние плагинов (застревание,
   *   счётчики флейлинга) считается общим с родителем (A5).
   */
  fork(pluginManager: PluginManager = this.pluginManager): ToolExecutor {
    const clone = Object.create(
      Object.getPrototypeOf(this.ctx),
      Object.getOwnPropertyDescriptors(this.ctx),
    ) as ToolContext;
    // Собственное мутабельное состояние вызова — иначе сиблинги перетрут
    // друг другу scope/cleanup/activeCallId.
    clone.cleanup = undefined;
    clone.activeCallId = undefined;
    const fork = new ToolExecutor(
      this.registry,
      clone,
      pluginManager,
      this.memo.entries,
      this.hookLock,
    );
    // subagent читает ctx.toolExecutor и передаёт его дочернему агенту: он
    // обязан видеть именно форк, а не родительский инстанс.
    clone.toolExecutor = fork;
    return fork;
  }

  /**
   * Запуск тула по имени с plain-аргументами (без call id и таймаут-обвязки).
   * Для внутреннего использования — напр. bash перенаправляет ошибочный
   * tool-call-как-команду в настоящий тул. Идёт через те же реестр и хуки.
   *
   * Внимание по реентрантности: временно подменяет `this.ctx`. Безопасно для
   * последовательных вызовов, но НЕ для конкурентных на одном инстансе —
   * будет гонка на подмене. Сейчас все вызовы последовательны (bash-редирект,
   * один subagent-тул); так и держать.
   */
  async executeByName(
    name: string,
    args: Record<string, unknown>,
    ctx?: ToolContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const prevCtx = this.ctx;
    if (ctx) this.ctx = ctx;
    try {
      return await this.execute(
        {
          id: `redirect_${Date.now()}`,
          name,
          arguments: args,
        },
        signal,
      );
    } finally {
      this.ctx = prevCtx;
    }
  }

  /** Есть ли тул с таким именем (проверка перед редиректами). */
  hasTool(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * Чтение мемо для `manualMemo`-тулов (bash). Возвращает откреплённую копию —
   * `toolCallId` вызывающий ставит сам.
   */
  memoGet(name: string, args: Record<string, unknown>): ToolResult | undefined {
    return this.memo.get(name, args);
  }

  /** Запись в мемо для `manualMemo`-тулов. Хранит откреплённую копию. */
  memoSet(name: string, args: Record<string, unknown>, result: ToolResult): void {
    this.memo.set(name, args, result);
  }

  /** Сброс мемо — после всего, что могло мутировать состояние. */
  memoInvalidate(): void {
    this.memo.invalidate();
  }

  /** Выполнить tool call: allowlist → плагины → хендлер → post-хуки. */
  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const allow = allowedToolNames(this.ctx);
    if (allow && !allow.has(call.name)) {
      return {
        success: false,
        output: t("tool.not_allowed", { name: call.name }),
        toolCallId: call.id,
      };
    }

    const tool = this.registry.get(call.name);
    if (!tool) {
      return {
        success: false,
        output: t("tool.unknown", { name: call.name }),
        toolCallId: call.id,
      };
    }

    // Теги ограничивают исполнение, а не только схему (INV-11): вызов тула вне
    // активного набора тегов блокируется ДО хендлера. Критерий — тот же, что у
    // `filterToolsByTags` (alwaysOn переживает сужение); пустой набор тегов —
    // легаси «все тулы».
    if (filterToolsByTags([tool], this.ctx.activeToolTags ?? []).length === 0) {
      return {
        success: false,
        output: t("tool.tags_blocked", { name: call.name }),
        toolCallId: call.id,
      };
    }

    // Enforcement политик тула — ОДНА точка (INV-9/10): scope/protected по
    // объявленным `pathArgs`, SSRF по `urlArgs` — ДО хендлера. Хендлер политику
    // не повторяет.
    const pathBlock = enforcePathArgs(this.ctx, tool, call);
    if (pathBlock) return pathBlock;
    const urlBlock = enforceUrlArgs(this.ctx, tool, call);
    if (urlBlock) return urlBlock;

    // TOCTOU-хук: мутирующий тул повторяет проверку прямо перед операцией.
    this.ctx.pathGuard = createPathGuard(this.ctx, tool, call);

    // Плагин-хуки сериализованы общим hookLock: параллельные форки-сиблинги
    // не гоняют общее состояние плагинов (stuck-detector, lint, lsp) конкурентно.
    // Лок берём ТОЛЬКО при наличии хука — иначе лишний await сдвигал бы старт
    // хендлера на микрозадачу (ломало синхронный старт, напр. fake-timer тесты).
    const plugins = this.pluginManager.getAllPlugins();
    const beforePlugins = plugins.some((p) => p.onBeforeTool);
    const blocked = beforePlugins
      ? await this.hookLock.run(() => runBeforeToolPlugins(this.ctx, call, plugins))
      : null;
    if (blocked) return blocked;

    let result: ToolResult;
    // Мемоизированный повтор детерминированного чтения (cacheable): хендлер
    // пропускается, но общий хвост (post-плагины, логирование) идёт как обычно,
    // чтобы мемо-хит был неотличим от свежего прогона.
    const memoHit = tool.cacheable ? this.memoGet(call.name, call.arguments) : undefined;
    try {
      this.ctx.activeCallId = call.id;
      this.ctx.abortSignal = signal;
      if (tool.interactive) {
        // Интерактивные тулы ждут ввода — без таймаута.
        result = memoHit ?? (await tool.handler(this.ctx, call.arguments));
      } else {
        result = await runToolWithTimeout(this.ctx, tool, call, signal, memoHit);
      }
      result.toolCallId = call.id;
    } catch (e: any) {
      // INV-15: исключение хендлера — это деградация исполнения, а не
      // содержательный отказ тула. Сигнал пишем здесь: `tool-batch-calls`
      // исключения уже не увидит, оно превращено в failed-результат.
      this.ctx.onDiagnostic?.({
        source: `tool:${call.name}`,
        operation: "tool.execute",
        kind: "failed",
        cause: e?.message ?? String(e),
        recoverable: true,
        detail: { toolCallId: call.id },
      });
      result = {
        success: false,
        output: `${t("error.prefix")}${e.message}`,
        toolCallId: call.id,
      };
    }

    result = finalizeToolResult(this.ctx, tool, call, result);
    this.memo.update(tool, call, result, memoHit);

    // После аборта работа тула отбрасывается (цикл агента завершается без
    // рендера/логирования), поэтому медленные post-плагины (LSP, lint, tsc)
    // пропускаются целиком. Аборт посреди плагина виден ему через signal
    // в контексте хука — плагин убьёт свои дочерние процессы.
    const afterPlugins = plugins.some((p) => p.onAfterTool);
    if (signal?.aborted) {
      this.ctx.logger.debug(`Tool ${call.name}: abort, skipping onAfterTool plugins`);
    } else if (afterPlugins) {
      await this.hookLock.run(() => runAfterToolPlugins(this.ctx, call, result, signal, plugins));
    }

    logToolResult(this.ctx, call, result);
    return result;
  }

  /** Определения тулов с учётом allowlist (для схемы LLM). */
  getToolDefinitions(tags?: string[]): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    boundedOutput?: boolean;
  }> {
    const allow = allowedToolNames(this.ctx);
    if (allow) {
      return this.registry
        .getAll()
        .filter((t) => allow.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          boundedOutput: t.boundedOutput,
        }));
    }
    return this.registry.getAllForLLM(tags);
  }

  /** Доступ к реестру. */
  getRegistry(): ToolRegistry {
    return this.registry;
  }

  /** Установить скоуп shared-исполнителя. */
  setScope(scope: import("./types").ToolScope | undefined): void {
    this.ctx.scope = scope;
  }

  /** Текущий скоуп shared-исполнителя (для compare-and-restore субагентов). */
  getScope(): import("./types").ToolScope | undefined {
    return this.ctx.scope;
  }

  /** Установить prompt-поверхность для интерактивных тулов. */
  setPromptIO(io?: import("./prompt-io").PromptIO): void {
    this.ctx.promptIO = io;
  }

  /** Задать приёмник диагностик fail-open путей тула (INV-15). Форки наследуют. */
  setDiagnosticSink(fn?: (diag: import("../output/types").Diagnostic) => void): void {
    this.ctx.onDiagnostic = fn;
  }

  /** Текущая глубина рекурсии субагентов. */
  getRecursionDepth(): number {
    return this.ctx.recursionDepth ?? 0;
  }

  /** Установить глубину рекурсии. */
  setRecursionDepth(depth: number): void {
    this.ctx.recursionDepth = depth;
  }

  /** Подменить LLM-провайдер в контексте. */
  updateProvider(provider: import("../llm/provider").LLMProvider): void {
    this.ctx.llmProvider = provider;
  }
}
