import type { SessionManager } from "../modules/session/manager";
import type { ToolCall } from "./types";
import type { PrefixDelta } from "./agent/prefix-monitor";
import type { CacheUsage } from "../llm/cache-usage";
import type { Logger } from "../logger/app-logger";
import { setAuditSessionDir } from "../modules/security/audit-log";
import { sanitizeLogMessage } from "../modules/security/data-sanitizer";
import { join } from "path";
import { readFileSync, existsSync } from "fs";

/**
 * Thin wrapper around SessionManager that eliminates repetitive
 * `if (sessionManager)` + `new Date().toISOString()` boilerplate
 * from the agent loop.
 *
 * When constructed, it configures the app logger and audit log to write into
 * the session directory (instead of global ~/.mma/logs/).
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

    setAuditSessionDir(dir);
  }

  get active(): boolean {
    return !!this.session?.getActive();
  }

  logSystem(content: string): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "system",
      content,
    });
  }

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
        content: reasoning,
        iteration,
        provider: caller?.provider,
        model: caller?.model,
      });
    }
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "assistant",
      content,
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

  saveAssistantMessage(content: string): void {
    const caller = this.getCaller?.();
    this.session?.appendMessage({
      role: "assistant",
      content,
      timestamp: new Date().toISOString(),
      provider: caller?.provider,
      model: caller?.model,
    });
  }

  logToolDefs(toolCount: number, toolNames: string[], iteration: number): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "tool_defs",
      toolCount,
      toolNames,
      iteration,
    });
  }

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
    });
  }

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
      contextTokens: info.tokens,
      quality: info.quality,
      messageCount: info.messageCount,
      compactionCount: info.compactionCount,
      iterationsSinceCompaction: info.iterationsSinceCompaction,
      blocks: info.blocks,
    });
  }

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

  logError(message: string): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "error",
      content: message,
    });
  }

  logAudit(summary: string, iteration: number): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "audit",
      content: summary,
      iteration,
    });
  }

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
   * Log session startup diagnostics: environment, LSP probe, plugins, skills.
   * Should be the FIRST entry in session.jsonl so the file is self-describing.
   * Skips if a session_start entry already exists (e.g. logged by REPL).
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
    // Skip if session_start already logged (REPL may have logged it with LSP probe)
    const meta = this.session?.getActiveMeta();
    if (meta) {
      const logPath = join(this.session!.getSessionDirectory(meta.id), "session.jsonl");
      try {
        if (existsSync(logPath)) {
          const content = readFileSync(logPath, "utf-8");
          if (content.includes('"type":"session_start"')) return;
        }
      } catch {
        // File read error — proceed to write
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
   * Log a reasoning control event (level set, policy evaluation).
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
   * Log a MoE observability event (moe_plan / moe_subtask / moe_replan /
   * moe_verify). Emitted by runWithMoE and MoEExecutor (Plan 4.2).
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
}
