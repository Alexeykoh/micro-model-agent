// Менеджер контекста: история, бюджеты, компакция, качество, факты сессии.
// Фасад публичного API: состояние — `manager-state`, токены/пороги — `manager-estimate`,
// качество — `manager-quality`, история — `manager-history`, компакция —
// `manager-compaction{,-stages,-block}`, снапшот — `manager-snapshot` (правило 6).
import type { ContentPart } from "../../llm/provider";
import type { ContextBudget as ConfigContextBudget } from "../../config/types";
import type { TokenCounter } from "../../llm/token-counter";
import type { ContextBreakdown, ContextQualityBreakdown } from "../../core/types";
import { ContextLedger } from "./ledger";
import type { ProgressDiagnostic } from "./compaction-progress";
import { extractTriedAndFailed } from "./message-analysis";
import type { Message } from "./message";
import { createContextState, type ContextState } from "./manager-state";
import {
  breakdown, checkOverflowAllowed as checkOverflow, contextTokens, estimateDiagnostics,
  estimatedTokens, historyLimit, historyTokens, needsCompaction as stateNeedsCompaction,
  needsIntervalCompaction as stateNeedsIntervalCompaction, resizeState,
} from "./manager-estimate";
import { qualityBreakdown, qualityScore } from "./manager-quality";
import {
  addMessage as addMessageToState, clearState, resetUserTurn, updateSystemPrompt,
} from "./manager-history";
import { compact as compactState, pruneStaleToolResults } from "./manager-compaction";
import { compactAdaptive, hardDropOldest } from "./manager-compaction-stages";
import { snapshot } from "./manager-snapshot";
import type {
  CompactOptions, CompactResult, ContextBudget, ContextEstimateDiagnostics, ContextSnapshot,
} from "./manager-types";

export type { ContextBreakdown };
export type { ContextQualityBreakdown, ContextQualityPart } from "../../core/types";
export { extractTriedAndFailed };
export type {
  CompactOptions, CompactResult, ContextBudget, ContextEstimateDiagnostics, ContextSnapshot,
};
export type { Message } from "./message";

/** Менеджер контекста: история, бюджеты, компакция, трекинг задачи/миссии сессии. */
export class ContextManager {
  private s: ContextState;
  readonly standingDirectives: Map<string, string>;

  constructor(
    contextWindow: number,
    contextBudget?: ConfigContextBudget,
    tokenCounter?: TokenCounter | null,
  ) {
    this.s = createContextState(contextWindow, contextBudget, tokenCounter);
    this.standingDirectives = this.s.standingDirectives;
  }

  /** Текущий reasoning-уровень (ставит цикл агента, входит в сводку компакции). */
  get thinkingLevel(): string | null { return this.s.thinkingLevel; }
  set thinkingLevel(level: string | null) { this.s.thinkingLevel = level; }

  /** Хук после значимой компакции (сводка-сообщение). */
  get onCompact(): ((summary: Message) => void) | null { return this.s.onCompact; }
  set onCompact(fn: ((summary: Message) => void) | null) { this.s.onCompact = fn; }

  /** OO-3: подключить durable леджер адресов (путь из contextBudget.notesPath). */
  configureLedger(filePath: string, max: number): void {
    this.s.ledger = new ContextLedger(filePath, max);
    this.s.ledger.load();
  }

  /** INV-15: sink «компакция без прогресса» — bootstrap пишет `context_degraded`. */
  setProgressDiagnosticSink(fn: ((d: ProgressDiagnostic) => void) | null): void {
    this.s.compactionProgress.setSink(fn);
  }

  /** Sink инъекций харнесса: `<system-summary>`-сообщения уходят в `session.jsonl`. */
  setHarnessSink(fn: ((text: string) => void) | null): void { this.s.harnessSink = fn; }

  /** Внутренний блок последней компакции (`[Compressed: …]`) — для тестов/наблюдаемости. */
  getCompactionBlock(): string | null { return this.s.compactedBlock; }

  /** Задаёт строку "текущий план" для сводки компакции (null — плана нет). */
  setPlanSummaryProvider(fn: (() => string | null) | null): void {
    this.s.planSummaryProvider = fn;
  }

  /** Копия текущего бюджета. */
  getBudget(): ContextBudget { return { ...this.s.budget }; }

  /** Число выполненных компакций. */
  getCompactionCount(): number { return this.s.compactionCount; }

  /** Итераций с последней компакции. */
  getIterationsSinceCompaction(): number { return this.s.iterationsSinceCompaction; }

  /** Политика компакции (v2/legacy). */
  getPolicy(): "legacy" | "v2" { return this.s.policy; }

  /** Мин. итераций между overflow-компакциями (v2). */
  getOverflowCooldown(): number { return this.s.overflowCooldown; }

  /** Сколько последних tool-результатов не чистить (v2). */
  getToolResultKeep(): number { return this.s.toolResultKeep; }

  /** Файлы из сводок компакции — сидируют known-files проверки галлюцинаций. */
  getKnownFiles(): string[] { return this.s.facts.getKnownFiles(); }

  /** Отмечает прошедшую итерацию (счётчик для интервала компакции). */
  noteIteration(): void { this.s.iterationsSinceCompaction++; }

  /** Начинает свежий ход юзера (сброс интервального счётчика и задачи хода). */
  resetUserTurn(): void { resetUserTurn(this.s); }

  /** Оценка качества контекста 0–100 (нагрузка, компакции, ошибки, свежесть). */
  getQuality(): number { return qualityScore(this.s); }

  /** Разбор оценки качества: те же факторы и веса, что в `getQuality`, плюс итог. */
  getQualityBreakdown(): ContextQualityBreakdown { return qualityBreakdown(this.s); }

  /** Добавляет сообщение в историю (задача, pending-картинки, пик токенов). */
  addMessage(msg: Message): void { addMessageToState(this.s, msg); }

  /** Кладёт картинку в очередь на аттач к следующему user-сообщению. */
  addPendingImage(part: ContentPart): void { this.s.pendingImages.add(part); }

  /** True, если есть картинки, ждущие аттача. */
  hasPendingImages(): boolean { return this.s.pendingImages.has(); }

  /** Возвращает pending-картинки, не очищая очередь. */
  getPendingImages(): ContentPart[] { return this.s.pendingImages.list(); }

  /** Очищает pending-картинки (напр., юзер шлёт чисто текстовое сообщение). */
  clearPendingImages(): void { this.s.pendingImages.clear(); }

  /** Ставит/обновляет стоящую директиву харнесса (переживает компакцию). */
  setStandingDirective(id: string, text: string): void { this.s.standingDirectives.set(id, text); }

  /** Снимает стоящую директиву (условие перестало выполняться). */
  clearStandingDirective(id: string): void { this.s.standingDirectives.delete(id); }

  /** Число сообщений в истории. */
  getMessageCount(): number { return this.s.messages.length; }

  /** Ёмкость истории: окно минус reserve, system и тулы; не выше конфигурной доли. */
  getHistoryLimit(): number { return historyLimit(this.s); }

  /** True, если истории нужна компакция (бюджет превышен или интервал + загрузка). */
  needsCompaction(): boolean { return stateNeedsCompaction(this.s); }

  /** Только интервальный триггер компакции (без порога переполнения). */
  needsIntervalCompaction(): boolean { return stateNeedsIntervalCompaction(this.s); }

  /** Уплотняет историю: старые ходы → сводка фактов, свежие — дословно. */
  compact(opts?: CompactOptions): CompactResult | null { return compactState(this.s, opts); }

  /** Stage A: чистка старых tool-результатов. @returns число очищенных результатов. */
  pruneStaleToolResults(toolResultKeep?: number, protectLast?: number): number {
    return pruneStaleToolResults(this.s, toolResultKeep, protectLast);
  }

  /** v2-компакция с гарантией прогресса: summarize → prune → aggressive → hard drop. */
  compactAdaptive(opts?: CompactOptions): CompactResult | null {
    return compactAdaptive(this.s, opts);
  }

  /** Stage C жёсткого дропа (зовётся из `compactAdaptive`; тест taint-t4 — напрямую). */
  private hardDropOldest(keep: number): CompactResult | null {
    return hardDropOldest(this.s, keep);
  }

  /** Сегментная разбивка контекста: system / tools / history / reserve / free. */
  getBreakdown(): ContextBreakdown { return breakdown(this.s); }

  /** Снапшот состояния контекста — для логов и веб-поверхности. */
  getSnapshot(): ContextSnapshot { return snapshot(this.s); }

  /** Заменяет системный промпт на месте (остаётся первым) или пренпендит новый. */
  updateSystemPrompt(content: string): void { updateSystemPrompt(this.s, content); }

  /** Копия активной истории сообщений. */
  getActiveHistory(): Message[] { return [...this.s.messages]; }

  /** Снимает маркер начала захода для сбора tool-событий (критик/evidence). */
  beginTurn(): number { return this.s.book.beginTurn(); }

  /** Монотонный seq сообщения; `-1` — сообщение не из этого контекста. */
  seqOf(msg: object): number { return this.s.book.seqOf(msg); }

  /** Доверие цели egress на ход (T2). */
  setEgressTrusted(trusted: boolean): void { this.s.book.setEgressTrusted(trusted); }

  /** Помечено ли сообщение как производное (INV-T1). */
  isTainted(msg: Message): boolean { return this.s.book.isTainted(msg); }

  /** Индексы tainted-сообщений, выровненные с историей (T3). */
  taintedIndexes(): boolean[] { return this.s.book.taintedIndexes(this.s.messages); }

  /** История для egress (T3): на внешней цели tainted-записи маскируются. */
  getHistoryForEgress(trusted: boolean): Message[] {
    return this.s.book.historyForEgress(this.s.messages, trusted);
  }

  /** Восстановить taint из загруженной истории (T4); число — для `taint_degraded`. */
  rehydrateTaint(): number { return this.s.book.rehydrate(this.s.messages); }
  hasTaint(): boolean { return this.s.book.taintedIndexes(this.s.messages).some(Boolean); }
  markNextToolTainted(): void { this.s.book.markNextToolTainted(); }
  taintAll(): void { this.s.book.taintAll(); }

  /** Сбрасывает всё, что принадлежит текущему ходу диалога (факты переживают). */
  clear(): void { clearState(this.s); }

  /** Оценка токенов истории (сообщения + токены тулов). */
  getEstimatedTokens(): number { return estimatedTokens(this.s); }

  /** Калиброванная оценка — вход для порогов компакции. */
  getContextTokens(): number { return contextTokens(this.s); }

  /** Принимает реальный `usage` после LLM-вызова и обновляет калибровку. */
  calibrate(actual: number, estimatedAtSend: number, messageCount: number): void {
    this.s.calibrator.observe(actual, estimatedAtSend, messageCount);
  }

  /** Помечает LLM-вызов без `usage` (провайдер не отдал токены). */
  noteMissingUsage(): void { this.s.calibrator.noteMissingUsage(); }

  /** Диагностика оценки контекста (аддитивные поля лога/снимка). */
  getEstimateDiagnostics(): ContextEstimateDiagnostics { return estimateDiagnostics(this.s); }

  /** Проверка порога overflow с safety-clamp (один раз на итерацию). */
  checkOverflowAllowed(): {
    allowed: boolean; raw: number; calibrated: number; implausible: boolean;
  } {
    return checkOverflow(this.s);
  }

  /** True, если последняя проверка overflow была отброшена safety-clamp. */
  wasLastJumpImplausible(): boolean { return this.s.lastJumpWasImplausible; }

  /** Задаёт токены определений тулов (прибавляются к оценке). */
  setToolTokens(tokens: number): void { this.s.toolTokens = tokens; }

  /** Пересчитывает бюджеты под новое окно контекста (и опционально счётчик). */
  resize(
    contextWindow: number,
    contextBudget?: ConfigContextBudget,
    tokenCounter?: TokenCounter | null,
  ): void {
    resizeState(this.s, contextWindow, contextBudget, tokenCounter);
  }

  /** Токены истории для порога overflow: `used − system − tools` (калькулировано). */
  getHistoryTokens(): number { return historyTokens(this.s); }
}
