/** Логгер сессии: тонкая обёртка над SessionManager для цикла агента. */
import type { SessionManager } from "../modules/session/manager";
import type { SessionLogEntry } from "../modules/session/store";
import type { Diagnostic, DiagnosticEvent } from "../output";
import type { ToolCall, RetractInfo } from "./types";
import type { Logger } from "../logger/app-logger";
import { sanitizeLogMessageTargeted } from "../modules/security/data-sanitizer";
import { redactContextSecrets } from "./agent/context-log";
import { toolChannelEvent } from "./session-log-events";
import {
  gateTimingEntry,
  retractEntry,
  sessionStartEntry,
  type SessionStartData,
} from "./session-log-entries";
import {
  assistantMessage,
  bindSessionLog,
  sessionStartAlreadyLogged,
  toolMessage,
  userMessage,
} from "./session-log-io";
import {
  assistantEntries,
  auditEntry,
  claimRetryEntry,
  criticEntry,
  onboardingEntry,
  reasoningControlEntry,
  sanitizeToolArgs,
  systemEntry,
  toolCallEntry,
  toolDefsEntry,
  toolResultEntry,
  userEntry,
} from "./session-log-messages";
import {
  compactionEntry,
  contextEntry,
  diagnosticEntry,
  llmUsageEntry,
  type CompactionLogInfo,
  type ContextLogInfo,
  type LlmUsageLogInfo,
} from "./session-log-telemetry";
import {
  persistToolImages as persistToolImageAssets,
  persistUserImages as persistUserImageAssets,
  type ImageLimits,
} from "./session-logger-images";
import type { ToolImageAsset, ToolImageRef } from "../modules/session/image-store";

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
    bindSessionLog(this.session, this.logger);
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
   */
  logSystem(content: string): void {
    this.log(systemEntry(content));
  }

  /**
   * Пишет сообщение пользователя (санитизированное) и историю сессии.
   */
  logUser(content: string, imageRefs?: ToolImageRef[]): void {
    const sanitized = sanitizeLogMessageTargeted(content);
    this.session?.appendMessage(userMessage(sanitized));
    this.log(userEntry(sanitized, imageRefs));
  }

  /**
   * Пишет ответ ассистента (+ reasoning и tool_calls при наличии).
   */
  logAssistant(
    content: string,
    reasoning?: string,
    toolCalls?: ToolCall[],
    iteration?: number,
    finish?: string,
  ): void {
    const entries = assistantEntries(
      content,
      reasoning,
      toolCalls,
      iteration,
      finish,
      this.getCaller?.(),
    );
    for (const entry of entries) this.log(entry);
  }

  /**
   * Сохраняет сообщение ассистента в историю сессии (для resume).
   */
  saveAssistantMessage(content: string): void {
    this.session?.appendMessage(
      assistantMessage(redactContextSecrets(content), this.getCaller?.()),
    );
  }

  /**
   * Пишет набор определений тулов итерации (состав для пост-анализа).
   */
  logToolDefs(toolCount: number, toolNames: string[], iteration: number): void {
    this.log(toolDefsEntry(toolCount, toolNames, iteration));
  }

  /**
   * Пишет вызов тула (имя, id, санитизированные аргументы).
   * @param call вызов тула; @param iteration номер итерации.
   */
  logToolCall(call: ToolCall, iteration: number): void {
    const args = sanitizeToolArgs(call.arguments, (message) => this.logger?.warn(message));
    this.log(toolCallEntry(call, iteration, args));
  }

  /**
   * Пишет результат тула (успех, вывод, diff, длительность) и историю.
   */
  logToolResult(
    call: ToolCall,
    result: { success: boolean; output: string; diff?: string },
    duration: number,
    iteration: number,
    imageRefs?: ToolImageRef[],
  ): void {
    const caller = this.getCaller?.();
    this.session?.appendMessage(
      toolMessage(call.name, sanitizeLogMessageTargeted(result.output), caller),
    );
    this.log(toolResultEntry(call, result, duration, iteration, imageRefs, caller));
  }

  /**
   * Ассеты тулов → `<sessionDir>/images/` с ротацией (шифрование → без записи; fail-open).
   */
  persistToolImages(assets: ToolImageAsset[] | undefined, limits?: ImageLimits): ToolImageRef[] {
    return persistToolImageAssets(this.session, this.logger, assets, limits);
  }

  /**
   * Картинки пользователя (data URL) → тот же каталог с общей ротацией; fail-open.
   */
  persistUserImages(dataUrls: string[] | undefined, limits?: ImageLimits): ToolImageRef[] {
    return persistUserImageAssets(this.session, this.logger, dataUrls, limits);
  }

  /**
   * Пишет событие компакции (причина, токены/качество до и после).
   * @param info параметры компакции.
   */
  logCompaction(info: CompactionLogInfo): void {
    this.log(compactionEntry(info));
  }

  /**
   * Пишет снапшот контекста (бюджеты, токены, качество, состав блоков).
   * @param info параметры снапшота.
   */
  logContext(info: ContextLogInfo): void {
    this.log(contextEntry(info));
  }

  /**
   * Пишет usage LLM-вызова (токены, источник, кеш, стабильность префикса).
   * @param iteration номер итерации; @param usage токены и мета.
   */
  logLlmUsage(iteration: number, usage: LlmUsageLogInfo): void {
    this.log(llmUsageEntry(iteration, usage));
  }

  /**
   * Пишет диагностику (INV-14): `source`/`operation`/`errorKind`/`cause`/
   * `recoverable`; `content` несёт причину — старые читатели лога продолжают
   * работать без изменений.
   */
  logError(diag: Diagnostic): void {
    this.appendDiagnostic("error", diag);
  }

  /**
   * Пишет сигнал fail-open пути (INV-15): `critic_error`/`verify_error`/
   * `tool_attempt` вместо «тихого ok».
   */
  logDiagnosticEvent(event: DiagnosticEvent, diag: Diagnostic): void {
    this.appendDiagnostic(event, diag);
  }

  /** Общая запись Diagnostic: `content` = причина (совместимо со старыми читателями). */
  private appendDiagnostic(type: "error" | DiagnosticEvent, diag: Diagnostic): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      source: diag.source,
      ...diagnosticEntry(type, diag),
    });
  }

  /** Пишет вердикт финального аудита; `tests` — пометка тест-прогона (INV-15). */
  logAudit(summary: string, iteration: number, durationMs?: number, tests?: string): void {
    this.log(auditEntry(summary, iteration, durationMs, tests));
  }

  /** Агрегат гейтов хода (`gate_timing`): сколько стояли hallucination/critic/audit, мс (A15). */
  logGateTiming(d: { iteration: number; total: number; gates: SessionLogEntry["gates"] }): void {
    this.log(gateTimingEntry(d));
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
   * Первая запись `session.jsonl`: окружение, LSP-проба, плагины, скиллы.
   */
  logSessionStart(data: SessionStartData): void {
    // REPL мог уже записать session_start (вместе с LSP-пробой) — не дублируем.
    if (sessionStartAlreadyLogged(this.session)) return;
    this.log(sessionStartEntry(data));
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
    this.log(reasoningControlEntry(data));
  }

  /** Пишет событие онбординга (meet/init) для пост-анализа. */
  logOnboarding(
    event: "meet_start" | "meet_done" | "init_start" | "init_done",
    data: Record<string, unknown> = {},
  ): void {
    this.log(onboardingEntry(event, data));
  }

  /**
   * Пишет отклонение уже отстримленного черновика гейтом (hallucination /
   * success-claim / artifact-claim / output-claim): без этого в session.jsonl
   * дырка (llm_usage без assistant), а в ленте — дубль при переответе.
   */
  logClaimRetry(data: { kind: string; reason: string; iteration: number }): void {
    this.log(claimRetryEntry(data));
  }

  /** Отзыв черновика (`retract`): reason/source/verdict/iteration; живёт и в истории. */
  logRetract(info: RetractInfo): void {
    this.log(retractEntry(info));
  }

  /** Пишет событие критика (контр-агент). */
  logCritic(
    event: "critic_check" | "critic_verdict" | "critic_escalation",
    data: Record<string, unknown> = {},
  ): void {
    this.log(criticEntry(event, data));
  }
}
