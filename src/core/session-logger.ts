/** Логгер сессии: тонкая обёртка над SessionManager для цикла агента. */
import type { SessionManager } from "../modules/session/manager";
import type { ToolCall } from "./types";
import type { PrefixDelta } from "./agent/prefix-monitor";
import type { CacheUsage } from "../llm/cache-usage";
import type { Logger } from "../logger/app-logger";
import { setAuditSessionDir } from "../modules/security/audit-log";
import { sanitizeLogMessage } from "../modules/security/data-sanitizer";
import { redactContextSecrets } from "./agent/context-log";

/**
 * Тонкая обёртка над SessionManager: убирает повторяющиеся
 * `if (sessionManager)` + `new Date().toISOString()` из цикла агента.
 *
 * При создании привязывает логгер приложения и аудит-лог к каталогу сессии
 * (вместо глобального ~/.mma/logs/).
 */
export class SessionLogger {
  private logger: Logger | undefined;

  constructor(
    private session: SessionManager | undefined,
    logger?: Logger,
    private getCaller?: () => { provider: string; model: string },
  ) {
    this.logger = logger;
    this.bindSessionDir();
  }

  private bindSessionDir(): void {
    const session = this.session;
    const meta = session?.getActiveMeta();
    if (!session || !meta) return;

    const dir = session.getSessionDirectory(meta.id);

    if (this.logger) {
      this.logger.setSessionDir(dir);
      this.logger.initSessionLog(meta.id);
    }

    setAuditSessionDir(dir, meta.id);
  }

  /** Есть ли активная сессия. */
  get active(): boolean {
    return !!this.session?.getActive();
  }

  /**
   * Пишет системное сообщение в лог сессии.
   * @param content текст системного сообщения.
   */
  logSystem(content: string): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "system",
      content: redactContextSecrets(content),
    });
  }

  /**
   * Пишет сообщение пользователя (санитизированное).
   * @param content текст пользователя.
   */
  logUser(content: string): void {
    const sanitized = sanitizeLogMessage(content);
    this.session?.appendMessage({
      role: "user",
      content: sanitized,
      timestamp: new Date().toISOString(),
    });
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "user",
      content: sanitized,
    });
  }

  /**
   * Пишет ответ ассистента (+ reasoning и tool_calls при наличии).
   * @param content текст ответа; @param reasoning reasoning-контент;
   * @param toolCalls вызовы тулов; @param iteration номер итерации.
   */
  logAssistant(
    content: string,
    reasoning?: string,
    toolCalls?: ToolCall[],
    iteration?: number,
  ): void {
    const caller = this.getCaller?.();
    if (reasoning) {
      this.session?.appendLog({
        ts: new Date().toISOString(),
        type: "reasoning",
        content: redactContextSecrets(reasoning),
        iteration,
        provider: caller?.provider,
        model: caller?.model,
      });
    }
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "assistant",
      content: redactContextSecrets(content),
      ...(toolCalls
        ? {
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })),
          }
        : {}),
      iteration,
      provider: caller?.provider,
      model: caller?.model,
    });
  }

  /**
   * Сохраняет сообщение ассистента в историю сессии (для resume).
   * @param content текст сообщения.
   */
  saveAssistantMessage(content: string): void {
    const caller = this.getCaller?.();
    this.session?.appendMessage({
      role: "assistant",
      content: redactContextSecrets(content),
      timestamp: new Date().toISOString(),
      provider: caller?.provider,
      model: caller?.model,
    });
  }

  /**
   * Пишет набор определений тулов итерации (состав для пост-анализа).
   * @param toolCount число тулов; @param toolNames имена; @param iteration итерация.
   */
  logToolDefs(toolCount: number, toolNames: string[], iteration: number): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "tool_defs",
      toolCount,
      toolNames,
      iteration,
    });
  }

  /**
   * Пишет вызов тула (имя, id, санитизированные аргументы).
   * @param call вызов тула; @param iteration номер итерации.
   */
  logToolCall(call: ToolCall, iteration: number): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "tool_call",
      tool: call.name,
      tool_call_id: call.id,
      args: this.sanitizeArgs(call.arguments),
      iteration,
    });
  }

  /**
   * Сериализует аргументы тула для лога. Санитайзер может испортить JSON
   * (например, режет закрывающую кавычку в `password=secret"`), поэтому при
   * ошибке парсинга пишем сырую санитизированную строку и предупреждаем —
   * запись tool_call не должна теряться.
   */
  private sanitizeArgs(args: unknown): Record<string, unknown> {
    const raw = JSON.stringify(args ?? {});
    const sanitized = sanitizeLogMessage(raw);
    try {
      const parsed: unknown = JSON.parse(sanitized);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { raw: sanitized };
    } catch {
      this.logger?.warn(
        `tool_call args sanitization broke JSON; storing raw string (${raw.length} chars)`,
      );
      return { raw: sanitized };
    }
  }

  /**
   * Пишет результат тула (успех, вывод, diff, длительность).
   * @param call вызов; @param result результат; @param duration длительность, мс;
   * @param iteration номер итерации.
   */
  logToolResult(
    call: ToolCall,
    result: { success: boolean; output: string; diff?: string },
    duration: number,
    iteration: number,
  ): void {
    const caller = this.getCaller?.();
    this.session?.appendMessage({
      role: "tool",
      content: sanitizeLogMessage(result.output),
      name: call.name,
      timestamp: new Date().toISOString(),
      provider: caller?.provider,
      model: caller?.model,
    });
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "tool_result",
      tool: call.name,
      tool_call_id: call.id,
      success: result.success,
      content: sanitizeLogMessage(result.output.slice(0, 1000)),
      diff: result.diff,
      duration,
      iteration,
      provider: caller?.provider,
      model: caller?.model,
    });
  }

  /**
   * Пишет событие компакции (причина, токены/качество до и после).
   * @param info параметры компакции.
   */
  logCompaction(info: {
    reason: string;
    iteration: number;
    tokensBefore?: number;
    tokensAfter?: number;
    qualityBefore?: number;
    qualityAfter?: number;
    messagesBefore?: number;
    messagesAfter?: number;
    removedTurns?: number;
    keptTurns?: number;
    summary?: string;
    /** Насколько упал объём (токены). */
    reducedBy?: number;
    /** Стадия сокращения: summarize|prune-tools|aggressive|hard-drop. */
    strategy?: string;
  }): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "compaction",
      content: `${info.reason}, iteration ${info.iteration}`,
      iteration: info.iteration,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      tokensAfter: info.tokensAfter,
      qualityBefore: info.qualityBefore,
      qualityAfter: info.qualityAfter,
      messagesBefore: info.messagesBefore,
      messagesAfter: info.messagesAfter,
      removedTurns: info.removedTurns,
      keptTurns: info.keptTurns,
      summary: info.summary,
      reducedBy: info.reducedBy,
      strategy: info.strategy,
    });
  }

  /**
   * Пишет снапшот контекста (бюджеты, токены, качество, состав блоков).
   * @param info параметры снапшота.
   */
  logContext(info: {
    kind: "start" | "iteration";
    iteration: number;
    provider?: string;
    model?: string;
    window?: number;
    systemBudget?: number;
    reserveBudget?: number;
    historyBudget?: number;
    systemTokens?: number;
    toolTokens?: number;
    tokens: number;
    /** Сырая оценка контекста (аддитивное диагностическое поле). */
    estimatedTokensRaw?: number;
    /** Калиброванная оценка контекста (аддитивное поле). */
    contextTokens?: number;
    /** Отношение actual/estimated калибратора. */
    calibrationRatio?: number;
    /** Состояние калибратора: cold|warming|trusted|stale. */
    calibrationState?: string;
    quality: number;
    messageCount: number;
    compactionCount: number;
    iterationsSinceCompaction: number;
    blocks?: Array<{
      label: string;
      priority: string;
      tokens: number;
      included: boolean;
    }>;
  }): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "context",
      content:
        info.kind === "start"
          ? "context snapshot at session start"
          : `context at iteration ${info.iteration}`,
      iteration: info.iteration,
      provider: info.provider,
      model: info.model,
      window: info.window,
      systemBudget: info.systemBudget,
      reserveBudget: info.reserveBudget,
      historyBudget: info.historyBudget,
      systemTokens: info.systemTokens,
      toolTokens: info.toolTokens,
      estimatedTokensRaw: info.estimatedTokensRaw ?? info.tokens,
      contextTokens: info.contextTokens ?? info.tokens,
      calibrationRatio: info.calibrationRatio,
      calibrationState: info.calibrationState,
      quality: info.quality,
      messageCount: info.messageCount,
      compactionCount: info.compactionCount,
      iterationsSinceCompaction: info.iterationsSinceCompaction,
      blocks: info.blocks,
    });
  }

  /**
   * Пишет usage LLM-вызова (токены, источник, кеш, стабильность префикса).
   * @param iteration номер итерации; @param usage токены и мета.
   */
  logLlmUsage(
    iteration: number,
    usage: {
      provider?: string;
      model?: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      source: "api" | "estimate";
      durationMs: number;
      /** Стабильность префикса промпта (client-side монитор кеша). */
      prefix?: PrefixDelta;
      /** Кеш-статистика вызова от провайдера. */
      cache?: CacheUsage;
    },
  ): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "llm_usage",
      iteration,
      provider: usage.provider,
      model: usage.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      source: usage.source,
      durationMs: usage.durationMs,
      cacheStable: usage.prefix ? Number(usage.prefix.stableRatio.toFixed(4)) : undefined,
      cacheCause: usage.prefix?.cause,
      cachedTokens: usage.cache?.cachedTokens,
      cacheWriteTokens: usage.cache?.cacheWriteTokens,
      cacheSource: usage.cache?.source,
    });
  }

  /**
   * Пишет ошибку в лог сессии.
   * @param message текст ошибки.
   */
  logError(message: string): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "error",
      content: redactContextSecrets(message),
    });
  }

  /**
   * Пишет вердикт финального аудита.
   * @param summary сводка аудита; @param iteration номер итерации.
   */
  logAudit(summary: string, iteration: number): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "audit",
      content: summary,
      iteration,
    });
  }

  /**
   * Пишет событие плана MoE/обычного (создание, шаги, re-plan).
   * @param event имя события; @param detail детали; @param iteration итерация.
   */
  logPlan(event: string, detail: string, iteration?: number): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "plan",
      content: detail,
      tool: event,
      ...(iteration !== undefined ? { iteration } : {}),
    });
  }

  /**
   * Пишет стартовую диагностику сессии: окружение, LSP-проба, плагины, скиллы.
   * Должна быть ПЕРВОЙ записью в session.jsonl (файл самоописываем).
   * Пропускает, если session_start уже есть (напр., записан REPL).
   */
  logSessionStart(data: {
    environment?: Record<string, unknown>;
    lspProbe?: {
      ok: Array<{ language: string; durationMs: number }>;
      failed: Array<{ language: string; error?: string; durationMs: number }>;
      noneApplicable: boolean;
    };
    plugins?: string[];
    skills?: number;
  }): void {
    // Пропуск при уже записанном session_start (REPL мог записать с LSP-пробой).
    // Чтение через decrypt-aware store: при шифровании сессии строки на диске —
    // шифртекст, поэтому проверка подстрокой никогда не срабатывала и дубль дописывался.
    const meta = this.session?.getActiveMeta();
    if (meta) {
      try {
        const entries = this.session!.loadSessionLog(meta.id);
        if (entries.some((e) => e.type === "session_start")) return;
      } catch {
        // Ошибка чтения — всё равно пишем
      }
    }
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "session_start",
      content: "session started",
      environment: data.environment,
      lspProbe: data.lspProbe,
      plugins: data.plugins,
      skills: data.skills,
    });
  }

  /**
   * Пишет событие управления reasoning (уровень, оценка политики).
   */
  logReasoningControl(data: {
    iteration: number;
    level: string;
    strategy?: string;
    probePassed?: boolean;
    source?: string;
  }): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "reasoning_control",
      content: `reasoning level: ${data.level} (source: ${data.source ?? "policy"})`,
      iteration: data.iteration,
      level: data.level,
      strategy: data.strategy,
      probePassed: data.probePassed,
      source: data.source,
    });
  }

  /**
   * Пишет событие наблюдаемости MoE (moe_plan / moe_subtask / moe_replan /
   * moe_verify). Эмитят runWithMoE и MoEExecutor (Plan 4.2).
   */
  logMoE(
    event: "moe_plan" | "moe_subtask" | "moe_replan" | "moe_verify",
    data: Record<string, unknown>,
  ): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: event,
      content: (data.detail as string) ?? (data.explanation as string) ?? event,
      ...data,
    });
  }

  /** Пишет событие онбординга (meet/init) для пост-анализа. */
  logOnboarding(event: string, data: Record<string, unknown> = {}): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: `onboarding_${event}`,
      content: event,
      ...data,
    });
  }

  /**
   * Пишет отклонение уже отстримленного черновика гейтом (hallucination /
   * success-claim / artifact-claim / output-claim): без этого в session.jsonl
   * дырка (llm_usage без assistant), а в ленте — дубль при переответе.
   */
  logClaimRetry(data: { kind: string; reason: string; iteration: number }): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "claim_retry",
      content: data.reason,
      kind: data.kind,
      iteration: data.iteration,
    });
  }

  /** Пишет событие критика (контр-агент). */
  logCritic(
    event: "critic_check" | "critic_verdict" | "critic_escalation",
    data: Record<string, unknown> = {},
  ): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: event,
      content: (data.summary as string) ?? event,
      ...data,
    });
  }
}
