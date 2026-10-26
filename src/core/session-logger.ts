/** Логгер сессии: тонкая обёртка над SessionManager для цикла агента. */
import type { SessionManager } from "../modules/session/manager";
import type { SessionLogEntry } from "../modules/session/store";
import { moduleOf, type Diagnostic, type DiagnosticEvent } from "../output";
import type { ToolCall } from "./types";
import type { PrefixDelta } from "./agent/prefix-monitor";
import type { CacheUsage } from "../llm/cache-usage";
import type { Logger } from "../logger/app-logger";
import { setAuditSessionDir } from "../modules/security/audit-log";
import { sanitizeLogMessageTargeted } from "../modules/security/data-sanitizer";
import { redactContextSecrets } from "./agent/context-log";
import { toolChannelEvent } from "./session-log-events";
import {
  decodeDataUrl,
  saveToolImage,
  type ToolImageAsset,
  type ToolImageRef,
} from "../modules/session/image-store";
import { compactionSummary } from "./compaction-summary";

/**
 * Тонкая обёртка над SessionManager: убирает повторяющиеся
 * `if (sessionManager)` + `new Date().toISOString()` из цикла агента.
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
   * Единая точка записи событий ЯДРА: `ts` (время) и provenance (INV-13,
   * `source`) проставляются здесь, методы несут только содержательные поля.
   * Запись без источника стала невозможной не на словах, а по построению (W11).
   */
  private log(entry: Omit<SessionLogEntry, "ts" | "source">): void {
    this.session?.appendLog({ ts: new Date().toISOString(), source: "core", ...entry });
  }

  /**
   * Пишет системное сообщение в лог сессии.
   * @param content текст системного сообщения.
   */
  logSystem(content: string): void {
    this.log({
      type: "system",
      content: redactContextSecrets(content),
    });
  }

  /**
   * Пишет сообщение пользователя (санитизированное).
   * @param content текст пользователя.
   * @param imageRefs ref'ы приложенных картинок (для web-replay после reload).
   */
  logUser(content: string, imageRefs?: ToolImageRef[]): void {
    const sanitized = sanitizeLogMessageTargeted(content);
    this.session?.appendMessage({
      role: "user",
      content: sanitized,
      timestamp: new Date().toISOString(),
    });
    this.log({
      type: "user",
      content: sanitized,
      ...(imageRefs?.length ? { images: imageRefs } : {}),
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
      this.log({
        type: "reasoning",
        content: redactContextSecrets(reasoning),
        iteration,
        provider: caller?.provider,
        model: caller?.model,
      });
    }
    this.log({
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
    this.log({
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
    this.log({
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
    const sanitized = sanitizeLogMessageTargeted(raw);
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
   * @param iteration номер итерации; @param imageRefs ref'ы сохранённых картинок.
   */
  logToolResult(
    call: ToolCall,
    result: { success: boolean; output: string; diff?: string },
    duration: number,
    iteration: number,
    imageRefs?: ToolImageRef[],
  ): void {
    const caller = this.getCaller?.();
    this.session?.appendMessage({
      role: "tool",
      content: sanitizeLogMessageTargeted(result.output),
      name: call.name,
      timestamp: new Date().toISOString(),
      provider: caller?.provider,
      model: caller?.model,
    });
    this.log({
      type: "tool_result",
      tool: call.name,
      tool_call_id: call.id,
      success: result.success,
      content: sanitizeLogMessageTargeted(result.output.slice(0, 1000)),
      diff: result.diff,
      ...(imageRefs?.length ? { images: imageRefs } : {}),
      duration,
      iteration,
      provider: caller?.provider,
      model: caller?.model,
    });
  }

  /**
   * Сохраняет полноразмерные ассеты тулов в `<sessionDir>/images/` с ротацией.
   *
   * Приватность: при включённом шифровании сессии на диск ничего не пишется —
   * веб получает картинку inline (data URL), история — пометку «недоступно».
   * Fail-open: ошибка записи одного ассета не роняет остальные и ход.
   */
  persistToolImages(
    assets: ToolImageAsset[] | undefined,
    limits: { maxCount: number; maxBytes: number } = { maxCount: 30, maxBytes: 104_857_600 },
  ): ToolImageRef[] {
    const dir = this.toolImageDir();
    if (!dir || !assets?.length) return [];
    return assets.flatMap((asset) => this.saveToolImageSafe(dir, asset, limits));
  }

  /**
   * Сохраняет картинки пользователя (data URL) в тот же `<sessionDir>/images/`
   * с общей ротацией, что и ассеты тулов. Не-data URL (http) пропускаются —
   * декодировать нечего. Шифрование сессии → [] (live остаётся inline,
   * история — без картинок), как и у тулов. Fail-open.
   */
  persistUserImages(
    dataUrls: string[] | undefined,
    limits: { maxCount: number; maxBytes: number } = { maxCount: 30, maxBytes: 104_857_600 },
  ): ToolImageRef[] {
    const dir = this.toolImageDir();
    if (!dir || !dataUrls?.length) return [];
    const assets: ToolImageAsset[] = [];
    for (const url of dataUrls) {
      try {
        const decoded = decodeDataUrl(url);
        assets.push({ bytes: decoded.bytes, mime: decoded.mime });
      } catch {
        /* not a base64 data URL (e.g. http(s)) — skip */
      }
    }
    return assets.flatMap((asset) => this.saveToolImageSafe(dir, asset, limits));
  }

  /** Каталог картинок активной сессии; null — нет сессии или включено шифрование. */
  private toolImageDir(): string | null {
    const session = this.session;
    const meta = session?.getActiveMeta();
    if (!session || !meta || session.isEncryptionEnabled?.()) return null;
    return session.getSessionDirectory(meta.id);
  }

  /** Запись одного ассета; ошибка — warn и пустой результат (fail-open). */
  private saveToolImageSafe(
    dir: string,
    asset: ToolImageAsset,
    limits: { maxCount: number; maxBytes: number },
  ): ToolImageRef[] {
    try {
      return [saveToolImage(dir, asset, limits)];
    } catch (err) {
      this.logger?.warn(
        `failed to persist tool image (${asset.mime}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
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
    this.log({
      type: "compaction",
      content: compactionSummary(info),
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
    this.log({
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
      /** Кумулятивный прогресс хода (не стрик). */
      progress?: { totalBatches: number; novelTools: number; duplicateBatches: number };
    },
  ): void {
    this.log({
      type: "llm_usage",
      iteration,
      provider: usage.provider,
      model: usage.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      origin: usage.source,
      durationMs: usage.durationMs,
      cacheStable: usage.prefix ? Number(usage.prefix.stableRatio.toFixed(4)) : undefined,
      cacheCause: usage.prefix?.cause,
      cachedTokens: usage.cache?.cachedTokens,
      cacheWriteTokens: usage.cache?.cacheWriteTokens,
      cacheSource: usage.cache?.source,
      progress: usage.progress,
    });
  }

  /**
   * Пишет диагностику (INV-14) в лог сессии: `source`/`operation`/`errorKind`/
   * `cause`/`recoverable`. `content` несёт причину — старые читатели лога
   * (session show, Trace) продолжают работать без изменений.
   * @param diag единый объект диагностики; `cause` обязателен при `kind !== "ok"`.
   */
  logError(diag: Diagnostic): void {
    this.appendDiagnostic("error", diag);
  }

  /**
   * Пишет сигнал fail-open пути (INV-15): отдельный тип события вместо «тихого ok».
   * `critic_error` — критик не дал вердикта; `verify_error` — верификатор деградировал;
   * `tool_attempt` — попытка тула завершилась отказом/исключением.
   * @param event тип события; @param diag единая диагностика (INV-14).
   */
  logDiagnosticEvent(
    event: DiagnosticEvent,
    diag: Diagnostic,
  ): void {
    this.appendDiagnostic(event, diag);
  }

  /** Общая запись Diagnostic: `content` = причина (совместимо со старыми читателями). */
  private appendDiagnostic(
    type: "error" | DiagnosticEvent,
    diag: Diagnostic,
  ): void {
    const cause = diag.cause ? redactContextSecrets(diag.cause) : undefined;
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type,
      content: cause ?? diag.operation,
      source: diag.source,
      module: moduleOf(diag.source),
      operation: diag.operation,
      errorKind: diag.kind,
      cause,
      recoverable: diag.recoverable,
    });
  }

  /**
   * Пишет вердикт финального аудита.
   * @param summary сводка аудита; @param iteration номер итерации.
   */
  logAudit(summary: string, iteration: number): void {
    this.log({
      type: "audit",
      content: summary,
      iteration,
    });
  }

  /** Событие плана (создание, шаги, re-plan). */
  logPlan(event: string, detail: string, iteration?: number): void {
    this.log(toolChannelEvent("plan", event, detail, iteration));
  }

  /** Инъекция харнесса в контекст модели (не жизненный цикл плана). */
  logDirective(event: string, detail: string, iteration?: number): void {
    this.log(toolChannelEvent("directive", event, detail, iteration));
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
    this.log({
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
    this.log({
      type: "reasoning_control",
      content: `reasoning level: ${data.level} (source: ${data.source ?? "policy"})`,
      iteration: data.iteration,
      level: data.level,
      strategy: data.strategy,
      probePassed: data.probePassed,
      origin: data.source,
    });
  }

  /** Пишет событие онбординга (meet/init) для пост-анализа. */
  logOnboarding(
    event: "meet_start" | "meet_done" | "init_start" | "init_done",
    data: Record<string, unknown> = {},
  ): void {
    this.log({
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
    this.log({
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
    this.log({
      type: event,
      content: (data.summary as string) ?? event,
      ...data,
    });
  }
}
