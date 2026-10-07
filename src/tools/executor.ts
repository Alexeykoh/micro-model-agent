/** Исполнитель тулов: allowlist, плагины, таймауты, мемо read-only. */
import type { ToolContext, ToolCall, ToolResult, PluginManager, PluginHook } from "./types";
import type { ToolRegistry } from "./registry";
import { killByCallId } from "../modules/processes/runner";
import { t } from "../i18n/index";
import {
  TOOL_EXECUTION_TIMEOUT_MS,
  TOOL_MEMO_TTL_MS as MEMO_TTL_MS,
} from "../config/timeouts";

const MEMO_MAX_ENTRIES = 100;

/** Стабильная сериализация: сортировка ключей, порядок аргументов на ключ не влияет. */
function stableArgsKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableArgsKey);
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, stableArgsKey((value as Record<string, unknown>)[k])]);
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * FIFO-мьютекс для диспатча плагин-хуков. Плагины (execution stuck-detector,
 * lint-on-write, lsp) несут общее мутабельное состояние и не
 * конкурентно-безопасны. Параллельные форки (subagent-сиблинги / MoE-волны)
 * делят один экземпляр — хуки сериализуются, а тело тула бежит конкурентно.
 */
class AsyncLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    // Хвост всегда settle-resolved: упавший хук не должен ломать очередь.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Исполнитель: реестр, контекст, плагины, сессионное мемо. */
export class ToolExecutor {
  private registry: ToolRegistry;
  private ctx: ToolContext;
  private pluginManager: PluginManager;
  /** Сериализатор плагин-хуков, общий для родителя и его форков. */
  private hookLock: AsyncLock;
  /**
   * Сессионное мемо детерминированных read-only результатов
   * (`ToolDefinition.cacheable` + ручные записи `manualMemo`-тулов вроде bash).
   * Ключ: `sessionId::name::stableArgs`.
   */
  private memo = new Map<string, { result: ToolResult; at: number }>();

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
    this.memo = memo;
    this.hookLock = hookLock;
  }

  /**
   * Изолированная копия исполнителя для КОНКУРЕНТНОГО вызова одного тула.
   * Клонирует ToolContext по дескрипторам (сохраняя живые геттеры config/
   * sessionId/capabilities), даёт собственные scope/recursionDepth/cleanup/
   * activeCallId, но РАЗДЕЛЯЕТ мемо, реестр и менеджер плагинов. Нужен, потому
   * что один инстанс `ToolExecutor` не конкурентно-безопасен: последовательный
   * путь так и держать, параллельный — через fork на каждый вызов.
   */
  fork(): ToolExecutor {
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
      this.pluginManager,
      this.memo,
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
  ): Promise<ToolResult> {
    const prevCtx = this.ctx;
    if (ctx) this.ctx = ctx;
    try {
      return await this.execute({
        id: `redirect_${Date.now()}`,
        name,
        arguments: args,
      });
    } finally {
      this.ctx = prevCtx;
    }
  }

  /** Есть ли тул с таким именем (проверка перед редиректами). */
  hasTool(name: string): boolean {
    return this.registry.has(name);
  }

  private memoKey(name: string, args: Record<string, unknown>): string {
    return `${this.ctx.sessionId ?? ""}::${name}::${JSON.stringify(stableArgsKey(args))}`;
  }

  /**
   * Чтение мемо для `manualMemo`-тулов (bash). Возвращает откреплённую копию —
   * `toolCallId` вызывающий ставит сам.
   */
  memoGet(name: string, args: Record<string, unknown>): ToolResult | undefined {
    const hit = this.memo.get(this.memoKey(name, args));
    if (!hit) return undefined;
    if (Date.now() - hit.at > MEMO_TTL_MS) {
      this.memo.delete(this.memoKey(name, args));
      return undefined;
    }
    return { ...hit.result };
  }

  /** Запись в мемо для `manualMemo`-тулов. Хранит откреплённую копию. */
  memoSet(name: string, args: Record<string, unknown>, result: ToolResult): void {
    const key = this.memoKey(name, args);
    if (!this.memo.has(key) && this.memo.size >= MEMO_MAX_ENTRIES) {
      const oldest = this.memo.keys().next();
      if (!oldest.done) this.memo.delete(oldest.value);
    }
    this.memo.set(key, { result: { ...result }, at: Date.now() });
  }

  /** Сброс мемо — после всего, что могло мутировать состояние. */
  memoInvalidate(): void {
    this.memo.clear();
  }

  /**
   * Имена разрешённых тулов множеством, `null` — без ограничений.
   * `undefined` — без ограничений; `[]` — запрещено всё.
   */
  private allowedNames(): Set<string> | null {
    const allow = this.ctx.toolAllowlist;
    return allow ? new Set(allow) : null;
  }

  /** Выполнить tool call: allowlist → плагины → хендлер → post-хуки. */
  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const allow = this.allowedNames();
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

    // Плагин-хуки сериализованы общим hookLock: параллельные форки-сиблинги
    // не гоняют общее состояние плагинов (stuck-detector, lint, lsp) конкурентно.
    // Лок берём ТОЛЬКО при наличии хука — иначе лишний await сдвигал бы старт
    // хендлера на микрозадачу (ломало синхронный старт, напр. fake-timer тесты).
    const plugins = this.pluginManager.getAllPlugins();
    const beforePlugins = plugins.some((p) => p.onBeforeTool);
    const blocked = beforePlugins
      ? await this.hookLock.run(() => this.runBeforeToolPlugins(call, plugins))
      : null;
    if (blocked) return blocked;

    let result: ToolResult;
    // Мемоизированный повтор детерминированного чтения (cacheable): хендлер
    // пропускается, но общий хвост (post-плагины, логирование) идёт как обычно,
    // чтобы мемо-хит был неотличим от свежего прогона.
    const memoHit = tool.cacheable ? this.memoGet(call.name, call.arguments) : undefined;
    try {
      this.ctx.activeCallId = call.id;
      if (tool.interactive) {
        // Интерактивные тулы ждут ввода — без таймаута.
        result = memoHit ?? (await tool.handler(this.ctx, call.arguments));
      } else {
        const timeoutMs =
          typeof tool.timeoutMs === "function"
            ? tool.timeoutMs(this.ctx)
            : (tool.timeoutMs ?? TOOL_EXECUTION_TIMEOUT_MS);
        const failFast = (message: string) => {
          // Убить долгоживущий дочерний процесс этого вызова.
          killByCallId(call.id, this.ctx.sessionId);
          // Тул-специфичный cleanup (напр. восстановление скоупа subagent) —
          // до reject, чтобы общее состояние восстановилось и при abandonment.
          const cleanup = this.ctx.cleanup;
          if (cleanup) {
            cleanup();
            // Сбрасывать, только если более новый вызов не подменил тем временем.
            if (this.ctx.cleanup === cleanup) this.ctx.cleanup = undefined;
          }
          return new Error(message);
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const timeoutPromise = new Promise<ToolResult>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              failFast(
                t("tool.timeout", {
                  name: call.name,
                  seconds: Math.round(timeoutMs / 1000),
                }),
              ),
            );
          }, timeoutMs);
        });
        const racePromises: Promise<ToolResult>[] = [
          memoHit ? Promise.resolve(memoHit) : tool.handler(this.ctx, call.arguments),
          timeoutPromise,
        ];
        if (signal) {
          const abortPromise = new Promise<ToolResult>((_, reject) => {
            onAbort = () => reject(failFast(t("tool.aborted", { name: call.name })));
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          });
          racePromises.push(abortPromise);
        }
        try {
          result = await Promise.race(racePromises);
        } finally {
          // Остановить таймер и снять abort-слушатель, чтобы они не сработали
          // против контекста/cleanup УЖЕ ДРУГОГО вызова.
          if (timer !== undefined) clearTimeout(timer);
          if (onAbort && signal) signal.removeEventListener("abort", onAbort);
          // У проигравших промисов потребителя после settled race нет (их
          // kill/cleanup-эффекты уже применены в failFast). Залогировать
          // reject и отцепить, чтобы не всплыл как unhandled rejection.
          for (const p of racePromises.slice(1)) {
            p.catch((e: Error) => {
              this.ctx.logger.debug(
                `Tool ${call.name}: discarded race loser: ${e.message}`,
              );
            });
          }
        }
      }
      result.toolCallId = call.id;
    } catch (e: any) {
      result = {
        success: false,
        output: `${t("error.prefix")}${e.message}`,
        toolCallId: call.id,
      };
    }

    if (!memoHit) {
      // Успешные детерминированные чтения мемоизируются; всё остальное, что
      // реально выполнялось, могло мутировать состояние (даже упавшая команда
      // применяется наполовину) — мемо сбрасывается. `manualMemo` (bash) ведут
      // свои записи сами.
      if (tool.cacheable && result.success) {
        this.memoSet(call.name, call.arguments, result);
      } else if (!tool.cacheable && !tool.manualMemo) {
        this.memoInvalidate();
      }
    }

    // После аборта работа тула отбрасывается (цикл агента завершается без
    // рендера/логирования), поэтому медленные post-плагины (LSP, lint, tsc)
    // пропускаются целиком. Аборт посреди плагина виден ему через signal
    // в контексте хука — плагин убьёт свои дочерние процессы.
    const afterPlugins = plugins.some((p) => p.onAfterTool);
    if (signal?.aborted) {
      this.ctx.logger.debug(`Tool ${call.name}: abort, skipping onAfterTool plugins`);
    } else if (afterPlugins) {
      await this.hookLock.run(() => this.runAfterToolPlugins(call, result, signal, plugins));
    }

    this.ctx.logger.logToolCall(
      call.name,
      JSON.stringify(call.arguments)?.slice(0, 200) ?? "",
      result.success ? "OK" : `FAIL: ${result.output?.slice(0, 200)}`,
    );
    this.ctx.logger.logToolOutput(call.name, result.output ?? "", result.success ? 0 : 1);
    this.ctx.logger.debug(`Tool ${call.name}: ${result.success ? "OK" : "FAIL"}`);
    return result;
  }

  /**
   * Прогон `onBeforeTool` по всем плагинам (под hookLock). Возвращает
   * blocked-результат, если плагин отклонил вызов, иначе `null`.
   */
  private async runBeforeToolPlugins(
    call: ToolCall,
    plugins: PluginHook[],
  ): Promise<ToolResult | null> {
    for (const plugin of plugins) {
      if (!plugin.onBeforeTool) continue;
      try {
        const proceed = await plugin.onBeforeTool(this.ctx, call);
        if (proceed === false || typeof proceed === "string") {
          const pluginName =
            (plugin as { name?: string }).name || plugin.constructor?.name || "unknown";
          const reason = typeof proceed === "string" ? proceed : undefined;
          return {
            success: false,
            blocked: true,
            output: reason
              ? t("tool.blocked_reason", { plugin: pluginName, reason })
              : t("tool.blocked", { plugin: pluginName }),
            toolCallId: call.id,
          };
        }
      } catch (e: any) {
        this.ctx.logger.warn(`Plugin onBeforeTool error: ${e.message}`);
      }
    }
    return null;
  }

  /** Прогон `onAfterTool` по всем плагинам (под hookLock; `signal` в ctx хука). */
  private async runAfterToolPlugins(
    call: ToolCall,
    result: ToolResult,
    signal: AbortSignal | undefined,
    plugins: PluginHook[],
  ): Promise<void> {
    const pluginCtx = signal ? { ...this.ctx, signal } : this.ctx;
    for (const plugin of plugins) {
      if (!plugin.onAfterTool) continue;
      try {
        await plugin.onAfterTool(pluginCtx, call, result);
      } catch (e: any) {
        this.ctx.logger.warn(`Plugin onAfterTool error: ${e.message}`);
      }
    }
  }

  /** Определения тулов с учётом allowlist (для схемы LLM). */
  getToolDefinitions(tags?: string[]): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    boundedOutput?: boolean;
  }> {
    const allow = this.allowedNames();
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
