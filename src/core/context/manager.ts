// Менеджер контекста: история, бюджеты, компакция, качество, факты сессии.
import type { ContentPart, TextPart } from "../../llm/provider";
import { getMessageText } from "../../llm/provider";
import { FactExtractor } from "./fact-extractor";
import { ContextLedger } from "./ledger";
import { absorbLedgers, observeToolResult } from "./ledger-absorb";
import { CompactionProgressTracker, type ProgressDiagnostic } from "./compaction-progress";
import { extractTriedAndFailed, looksLikeErrorPaste } from "./message-analysis";
import type { ContextBreakdown } from "../../core/types";
export type { ContextBreakdown };
export { extractTriedAndFailed };

/** Сообщение истории: роль, контент, tool-метаданные. */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  success?: boolean;
  /** Вызов, заблокированный плагином — решение гарда, не реальный фейл. */
  blocked?: boolean;
  arguments?: Record<string, unknown>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

import type { ContextBudget as ConfigContextBudget } from "../../config/types";
import { DEFAULTS } from "../../config/defaults";
import type { TokenCounter } from "../../llm/token-counter";
import {
  ContextCalibrator,
  isImplausibleJump,
  type CalibrationState,
} from "../../core/api";

/** Бюджет контекста в токенах: системный промпт, резерв ответа, история. */
export interface ContextBudget {
  systemPrompt: number;
  responseReserve: number;
  history: number;
}

const COMPACTION_INTERVAL = 15;
const KEEP_LAST_N = 6;

/** Результат компакции: счётчики ходов/токенов/качества + внутренняя сводка. */
export interface CompactResult {
  /** Ходов удалено компакцией (oldTurns). */
  removedTurns: number;
  /** Ходов оставлено дословно (свежие, минус протухшие <system-summary>). */
  keptTurns: number;
  tokensBefore: number;
  tokensAfter: number;
  qualityBefore: number;
  qualityAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  /** Внутренний блок [Compressed: ...] (без обёртки <system-summary>). */
  summary: string;
  /** Насколько упал объём в токенах (tokensBefore − tokensAfter). */
  reducedBy: number;
  /** Стадия, давшая сокращение: summarize|prune-tools|aggressive|hard-drop. */
  strategy: string;
}

/** Опции компакции (v2). */
export interface CompactOptions {
  /** Сколько свежих сообщений оставить дословно (по умолчанию KEEP_LAST_N). */
  keepLastN?: number;
  /** Сколько последних tool-результатов не чистить при prune-tools. */
  toolResultKeep?: number;
  /** Порог значимости: ниже него счётчик/лог не обновляются. */
  minReduction?: number;
}

/** Снапшот состояния контекста для логов/наблюдаемости. */
export interface ContextSnapshot {
  window: number;
  budget: ContextBudget;
  /** Оценка токенов в истории (сообщения + определения тулов). */
  tokens: number;
  toolTokens: number;
  messageCount: number;
  quality: number;
  compactionCount: number;
  iterationsSinceCompaction: number;
  /** Разбивка контекста по частям (сегменты полосы в UI). */
  breakdown: ContextBreakdown;
  /** Сырая оценка (сообщения + тулы) без калибровки. */
  estimatedTokensRaw: number;
  /** Калиброванная оценка — вход для порогов компакции. */
  contextTokens: number;
  /** Текущее отношение actual/estimated калибратора. */
  calibrationRatio: number;
  /** Состояние калибратора. */
  calibrationState: CalibrationState;
}

/** Диагностика оценки контекста (аддитивные поля лога/снимка). */
export interface ContextEstimateDiagnostics {
  raw: number;
  calibrated: number;
  ratio: number;
  state: CalibrationState;
}

/** Менеджер контекста: история, бюджеты, компакция, трекинг задачи/миссии сессии. */
export class ContextManager {
  private contextWindow: number;
  private messages: Message[] = [];
  private compactedBlock: string | null = null;
  private iterationsSinceCompaction = 0;
  private compactionCount = 0;
  private peakTokens = 0;
  private budget: ContextBudget;
  private compactionThreshold: number;
  /**
   * Минимальная загрузка истории (доля бюджета), нужная интервалу итераций для
   * срабатывания компакции. Интервал — защита от частоты, не триггер: слабо
   * загруженный контекст нельзя уплотнять лишь потому, что прошло N итераций
   * (было: компакция на ~40% бюджета стирала 33-44 полезных хода посреди задачи).
   */
  private compactionMinLoad: number;
  /** Политика компакции v2/legacy. */
  private policy: "legacy" | "v2";
  /** Мин. итераций между overflow-компакциями (v2). */
  private overflowCooldown: number;
  /** Сколько последних tool-результатов не чистить (v2). */
  private toolResultKeep: number;
  /** Режим сводки компакции: пинить `[Tool ledger]` или нет. */
  private compactionSummaryMode: "off" | "ledger";
  /**
   * Структурный леджер тулов: что уже прочитано/найдено/запущено. Копится через
   * компакции (пинится в каждой сводке), чтобы модель не переисследовала тот же
   * источник после сжатия истории (наблюдалось: 6× один и тот же web_fetch).
   */
  private toolLedger: string[] = [];
  private toolLedgerKeys = new Set<string>();
  /**
   * OO-3: durable леджер адресов (файловый), переживает любую компакцию. Когда
   * задан, блок компакции несёт только указатель, а не сырые заметки.
   */
  private ledger: ContextLedger | null = null;
  /**
   * INV-15: детектор серии компакций без роста durable-леджера. Состояние и
   * эмит живут в helper'е (manager.ts на потолке ≤300-строк правила 6).
   */
  private compactionProgress = new CompactionProgressTracker();
  private facts = new FactExtractor();
  /** Последняя реальная инструкция юзера (мимо <system-summary>). */
  private lastUserTask = "";
  /** Первая реальная инструкция сессии — переживает resetUserTurn(). */
  private sessionMission = "";
  /** Последнее сообщение юзера, похожее на вставленную ошибку/лог (не задача). */
  private lastUserFeedback = "";
  private tokenCounter: TokenCounter | null;
  private pendingImageParts: ContentPart[] = [];
  private toolTokens = 0;
  /**
   * Монотонный счётчик штампов сообщений (см. `beginTurn`/`seqOf`). Храним seq
   * в WeakMap, а не полем Message: объекты истории уходят в LLM как есть
   * (`body.messages = opts.messages`), и лишнее поле могло бы ломать строгие
   * OpenAI-совместимые бэкенды. WeakMap не сериализуется и следует за объектом.
   */
  private nextSeq = 0;
  private seqByMessage = new WeakMap<object, number>();
  /** Калибратор оценки по реальному usage провайдера. */
  private calibrator: ContextCalibrator;
  /** Опции калибратора — чтобы пересоздать при clear(). */
  private calibrationOptions: { warmup?: number; ratioFloor?: number };
  /** Предыдущая сырая оценка и число сообщений — вход safety-clamp. */
  private lastEstimateRaw = 0;
  private lastEstimateMessageCount = 0;
  /** Последняя проверка overflow отказана safety-clamp (для лога). */
  private lastJumpWasImplausible = false;
  /** Текущий reasoning-уровень (ставит цикл агента, входит в сводку компакции). */
  thinkingLevel: string | null = null;
  onCompact: ((summary: Message) => void) | null = null;
  /**
   * Опциональная короткая строка в сводку компакции, чтобы модель знала про
   * активный план с прогрессом. Прокидывается из bootstrap в execution-модуль —
   * без неё 9B-модель пересоздаёт план с нуля сразу после компакции (было:
   * ses_msvuao0h — plan_e07pb2 (1/6) выброшен ради свежего plan_xzq9xe в ту же
   * итерацию, когда старый план ещё был виден).
   */
  private planSummaryProvider: (() => string | null) | null = null;

  constructor(
    contextWindow: number,
    contextBudget?: ConfigContextBudget,
    tokenCounter?: TokenCounter | null,
  ) {
    this.contextWindow = contextWindow;
    const tuning = ContextManager.resolveTuning(contextBudget);
    this.compactionThreshold = tuning.compactionThreshold;
    this.compactionMinLoad = tuning.compactionMinLoad;
    this.policy = tuning.policy;
    this.overflowCooldown = tuning.overflowCooldown;
    this.toolResultKeep = tuning.toolResultKeep;
    this.compactionSummaryMode = tuning.compactionSummary;
    this.budget = this.calculateBudget(contextWindow, contextBudget);
    this.tokenCounter = tokenCounter ?? null;
    this.calibrationOptions = { warmup: tuning.calibrationWarmup, ratioFloor: tuning.ratioFloor };
    this.calibrator = new ContextCalibrator(this.calibrationOptions);
  }

  /** OO-3: подключить durable леджер адресов (путь из contextBudget.notesPath). */
  configureLedger(filePath: string, max: number): void {
    this.ledger = new ContextLedger(filePath, max);
    this.ledger.load();
  }

  /**
   * INV-15: sink диагностики «компакция без прогресса» — bootstrap пишет
   * `context_degraded` в сессию тем же путём, что `admission_degraded`.
   */
  setProgressDiagnosticSink(fn: ((d: ProgressDiagnostic) => void) | null): void {
    this.compactionProgress.setSink(fn);
  }

  /** Внутренний блок последней компакции (`[Compressed: …]`) — для тестов/наблюдаемости. */
  getCompactionBlock(): string | null {
    return this.compactedBlock;
  }

  /** Резолвит тюнинг-параметры бюджета с безопасными дефолтами. */
  private static resolveTuning(b: ConfigContextBudget | undefined) {
    const merged = {
      ...DEFAULTS.contextBudget,
      ...(b ?? {}),
    } as Required<ConfigContextBudget>;
    return {
      compactionThreshold: merged.compactionThreshold,
      compactionMinLoad: merged.compactionMinLoad,
      policy: merged.policy,
      overflowCooldown: merged.overflowCooldown,
      toolResultKeep: merged.toolResultKeep,
      calibrationWarmup: merged.calibrationWarmup,
      ratioFloor: merged.ratioFloor,
      compactionSummary: merged.compactionSummary,
    };
  }

  /**
   * Задаёт короткую строку "текущий план" для сводки компакции, или null если
   * плана нет. Инжектится один раз на bootstrap (не per-turn состояние).
   */
  setPlanSummaryProvider(fn: (() => string | null) | null): void {
    this.planSummaryProvider = fn;
  }

  private calculateBudget(window: number, contextBudget?: ConfigContextBudget): ContextBudget {
    if (contextBudget) {
      const systemPrompt = Math.floor(window * contextBudget.systemPrompt);
      const responseReserve = Math.floor(window * contextBudget.responseReserve);
      const history = Math.max(0, window - systemPrompt - responseReserve);
      return { systemPrompt, responseReserve, history };
    }
    // Фолбэк для обратной совместимости (тесты, сабагенты без явного бюджета)
    return {
      systemPrompt: Math.floor(window * 0.25),
      responseReserve: Math.floor(window * 0.12),
      history: Math.floor(window * 0.63),
    };
  }

  /** Копия текущего бюджета. */
  getBudget(): ContextBudget {
    return { ...this.budget };
  }

  /** Число выполненных компакций. */
  getCompactionCount(): number {
    return this.compactionCount;
  }

  /** Итераций с последней компакции. */
  getIterationsSinceCompaction(): number {
    return this.iterationsSinceCompaction;
  }

  /** Политика компакции (v2/legacy). */
  getPolicy(): "legacy" | "v2" {
    return this.policy;
  }

  /** Мин. итераций между overflow-компакциями (v2). */
  getOverflowCooldown(): number {
    return this.overflowCooldown;
  }

  /** Сколько последних tool-результатов не чистить (v2). */
  getToolResultKeep(): number {
    return this.toolResultKeep;
  }

  /** Файлы, известные из сводок компакции — сидируют known-files проверки
   *  галлюцинаций, чтобы голые имена переживали сбросы контекста. */
  getKnownFiles(): string[] {
    return this.facts.getKnownFiles();
  }

  /** Отмечает прошедшую итерацию (счётчик для интервала компакции). */
  noteIteration(): void {
    this.iterationsSinceCompaction++;
  }

  /**
   * Начинает свежий ход юзера. 15-итерационный интервал компакции не должен
   * течь через сообщения юзера — иначе ход, кончившийся на итерации 14,
   * форсит компакцию на первой же итерации следующего сообщения (было:
   * компакция на итерации 8 нового хода снесла свежеприсланную задачу юзера
   * вместе с 40+ старыми ходами). Факты сохраняются.
   */
  resetUserTurn(): void {
    this.iterationsSinceCompaction = 0;
    // Новое сообщение юзера начинает новый ход — сбрасываем задачу прошлого хода,
    // чтобы сводка сохранила свежую инструкцию. Миссия сессии выживает: вставка
    // ошибки/лога в новом ходе не должна стирать исходную цель.
    this.lastUserTask = "";
    this.lastUserFeedback = "";
  }

  /** Оценка качества контекста 0–100 (нагрузка, компакции, ошибки, свежесть). */
  getQuality(): number {
    const usedTokens = this.getContextTokens();
    const tokenLoad = this.budget.history > 0
      ? Math.max(0, 1 - usedTokens / this.budget.history)
      : 0;

    // Восстанавливаемый штраф: каждая компакция теряет часть информации, но штраф
    // ОГРАНИЧЕН СВЕРХУ, чтобы кумулятивные компакции не прикалывали качество ниже
    // триггера форсированной компакции (40%). До капа сессия с ~7+ компакциями
    // клампила слагаемое в 0 навсегда; вместе с тяжёлой токенной нагрузкой и
    // плотностью ошибок качество застревало ниже 40 и компакция срабатывала на
    // КАЖДОЙ итерации (было: 56 компакций за 28 минут).
    const COMPACTION_PENALTY_FLOOR = 0.5;
    const compactionLoss = Math.max(COMPACTION_PENALTY_FLOOR, 1 - this.compactionCount * 0.15);

    const msgCount = this.messages.length || 1;
    const errorDensity = Math.max(0, 1 - Math.min(1, this.facts.errorCount / msgCount));

    const freshness = Math.max(0, 1 - this.iterationsSinceCompaction / COMPACTION_INTERVAL);

    const score = tokenLoad * 0.4 + compactionLoss * 0.25 + errorDensity * 0.2 + freshness * 0.15;
    return Math.round(Math.min(100, Math.max(0, score * 100)));
  }

  /** Добавляет сообщение в историю (трекает задачу, аттачит pending-картинки, пик токенов). */
  addMessage(msg: Message): void {
    // Трекаем задачу, над которой работает агент, чтобы пережила компакцию.
    // Реальная инструкция юзера — ПЕРВОЕ не-system-summary user-сообщение хода;
    // всё после (результаты тулов, retry-nudge'и) — инжектированные `user`-
    // конверты, которые не должны её затирать (было: после компакции модель
    // забывала "удали /bicycles, почини стили" и 40+ итераций бесцельно читала файлы).
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : getMessageText(msg.content);
      if (text.trim() && !text.startsWith("<system-summary>") && !text.includes("[Compressed:")) {
        if (looksLikeErrorPaste(text) && (this.lastUserTask || this.sessionMission)) {
          this.lastUserFeedback = text.trim().slice(0, 400);
        } else if (!this.lastUserTask && !this.lastUserFeedback) {
          // Нет новой задачи внутри хода, где уже поймана вставка ошибки/лога:
          // последующие сообщения — продолжения результатов тулов, не свежая
          // инструкция, поэтому на компакции побеждает миссия сессии.
          this.lastUserTask = text.trim();
          if (!this.sessionMission) this.sessionMission = text.trim();
        }
      }
    }
    // Авто-аттач pending-картинок к следующему user-сообщению
    if (msg.role === "user" && this.pendingImageParts.length > 0) {
      const textPart: TextPart = {
        type: "text",
        text: typeof msg.content === "string" ? msg.content : getMessageText(msg.content),
      };
      msg = {
        ...msg,
        content: [textPart, ...this.pendingImageParts],
      };
      this.pendingImageParts = [];
    }
    this.messages.push(this.stampSeq(msg));
    // OO-3/OO-8: адреса-находки пишутся сразу (сырой контент), правка — stale.
    observeToolResult(this.ledger, msg);
    const tokens = this.getEstimatedTokens();
    if (tokens > this.peakTokens) this.peakTokens = tokens;
  }

  /**
   * Кладёт картинку в очередь на аттач к следующему user-сообщению.
   */
  addPendingImage(part: ContentPart): void {
    this.pendingImageParts.push(part);
  }

  /**
   * True, если есть картинки, ждущие аттача.
   */
  hasPendingImages(): boolean {
    return this.pendingImageParts.length > 0;
  }

  /**
   * Возвращает pending-картинки, не очищая очередь.
   */
  getPendingImages(): ContentPart[] {
    return [...this.pendingImageParts];
  }

  /**
   * Очищает pending-картинки (напр., юзер шлёт чисто текстовое сообщение).
   */
  clearPendingImages(): void {
    this.pendingImageParts = [];
  }

  /** Число сообщений в истории. */
  getMessageCount(): number {
    return this.messages.length;
  }

  // Токенный кэш на сообщение. Сообщения считаются иммутабельными после
  // добавления, но защищаемся от in-place мутаций (напр. поздний аттач
  // картинок): кэш хранит сигнатуру контента и пересчитывает при её смене.
  // Это устраняет класс багов «оценка выросла на +44K, добавлено 2 сообщения».
  private tokenCache = new WeakMap<Message, { sig: string; tokens: number }>();

  /** Дешёвая сигнатура контента сообщения (детект мутации без токенизации). */
  private messageSignature(m: Message): string {
    const text = typeof m.content === "string" ? m.content : getMessageText(m.content);
    const parts = Array.isArray(m.content)
      ? m.content
          .map((p) =>
            p.type === "image_url" ? `i:${p.image_url?.url?.length ?? 0}` : "t",
          )
          .join(",")
      : "s";
    const tc = m.tool_calls
      ? m.tool_calls.map((t) => `${t.id}:${t.function.name}:${t.function.arguments.length}`).join("|")
      : "";
    return `${m.role}\u0001${text.length}\u0001${parts}\u0001${tc}`;
  }

  private estimateMessageTokensCached(m: Message): number {
    const sig = this.messageSignature(m);
    const cached = this.tokenCache.get(m);
    if (cached !== undefined && cached.sig === sig) return cached.tokens;
    const tokens = this.estimateMessageTokens(m);
    this.tokenCache.set(m, { sig, tokens });
    return tokens;
  }

  private estimateMessageTokens(m: Message): number {
    const text = getMessageText(m.content);
    if (this.tokenCounter) {
      let t = this.tokenCounter.count(text);
      // Токены картинок: base64 ~130 токенов на тайл 512x512; грубая оценка
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === "image_url" && part.image_url?.url) {
            const b64Len = part.image_url.url.includes(",")
              ? (part.image_url.url.split(",")[1]?.length ?? 0)
              : part.image_url.url.length;
            // ~130 токенов на 512 байт base64
            t += Math.ceil(b64Len / 512) * 130;
          }
        }
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          t += this.tokenCounter.count(tc.id);
          t += this.tokenCounter.count(tc.function.name);
          t += this.tokenCounter.count(tc.function.arguments);
          t += 4;
        }
      }
      return t;
    }
    let t = Math.ceil(text.length / 2);
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "image_url" && part.image_url?.url) {
          const b64Len = part.image_url.url.includes(",")
            ? (part.image_url.url.split(",")[1]?.length ?? 0)
            : part.image_url.url.length;
          t += Math.ceil(b64Len / 512) * 130;
        }
      }
    }
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        t += Math.ceil(tc.id.length / 2);
        t += Math.ceil(tc.function.name.length / 2);
        t += Math.ceil(tc.function.arguments.length / 2);
        t += 4;
      }
    }
    return t;
  }

  /** True, если истории нужна компакция (бюджет превышен или интервал + загрузка). */
  needsCompaction(): boolean {
    // v2: пороги по калиброванной оценке; legacy — по сырой (2.18.2).
    const totalTokens =
      this.policy === "v2"
        ? this.getContextTokens()
        : this.messages.reduce((sum, m) => sum + this.estimateMessageTokensCached(m), 0);
    if (totalTokens > this.budget.history * this.compactionThreshold) return true;

    // Интервал итераций уплотняет только значимо загруженную историю.
    // Уплотнять слабозагруженный контекст — терять рабочее состояние без
    // бюджетной причины (см. `compactionMinLoad`).
    if (this.iterationsSinceCompaction < COMPACTION_INTERVAL) return false;
    const load = this.budget.history > 0 ? totalTokens / this.budget.history : 0;
    return load >= this.compactionMinLoad;
  }

  /**
   * Только интервальный триггер (без порога переполнения): итераций прошло
   * достаточно и история значимо загружена. В v2 порог переполнения живёт в
   * отдельной проверке с cooldown, поэтому здесь только интервал.
   */
  needsIntervalCompaction(): boolean {
    if (this.iterationsSinceCompaction < COMPACTION_INTERVAL) return false;
    const totalTokens =
      this.policy === "v2"
        ? this.getContextTokens()
        : this.messages.reduce((sum, m) => sum + this.estimateMessageTokensCached(m), 0);
    const load = this.budget.history > 0 ? totalTokens / this.budget.history : 0;
    return load >= this.compactionMinLoad;
  }

  /** Уплотняет историю: старые ходы → сводка фактов, свежие — дословно. Null, если уплотнять нечего. */
  compact(opts?: CompactOptions): CompactResult | null {
    const keepLastN = opts?.keepLastN ?? KEEP_LAST_N;
    // Снимаем состояние ДО компакции ПЕРЕД сбросом/ростом счётчиков —
    // qualityBefore обязан отражать контекст, который реально видела модель.
    const tokensBefore = this.getEstimatedTokens();
    const qualityBefore = this.getQuality();
    const messagesBefore = this.messages.length;

    // Сбрасываем счётчик, даже если уплотнять нечего — иначе
    // needsCompaction() вечно true после 15 итераций с малым числом сообщений.
    this.iterationsSinceCompaction = 0;
    if (this.messages.length <= keepLastN * 2) return null;

    const cutoff = this.computeCutoff(keepLastN);
    const oldTurns = this.messages.slice(0, cutoff);
    const recentTurns = this.messages.slice(cutoff);

    this.facts.extract(oldTurns);
    absorbLedgers(
      oldTurns,
      this.ledger,
      this.compactionSummaryMode !== "off",
      this.toolLedger,
      this.toolLedgerKeys,
    );

    this.compactedBlock = this.buildCompactionBlock(oldTurns);
    const summary: Message = this.stampSeq({
      role: "user",
      content: `<system-summary>${this.compactedBlock}</system-summary>`,
    });

    const firstSystem = this.messages.find((m) => m.role === "system");
    // Чистим протухшие system-summary из свежих ходов против вложенности
    const freshRecent = recentTurns.filter((m) => {
      if (m.role !== "user") return true;
      const text = getMessageText(m.content);
      return !text.startsWith("<system-summary>");
    });
    this.messages = [...(firstSystem ? [firstSystem] : []), summary, ...freshRecent];
    this.iterationsSinceCompaction = 0;
    // Компакция переписала историю — baseline калибровки недействителен.
    this.calibrator.invalidate();
    this.lastEstimateRaw = 0;
    this.lastEstimateMessageCount = 0;

    return this.finalizeCompact({
      opts,
      summary,
      oldTurns,
      freshRecent,
      tokensBefore,
      qualityBefore,
      messagesBefore,
    });
  }

  /** Собирает результат компакции, решает значимость и ведёт счётчик/onCompact. */
  private finalizeCompact(ctx: {
    opts?: CompactOptions;
    summary: Message;
    oldTurns: Message[];
    freshRecent: Message[];
    tokensBefore: number;
    qualityBefore: number;
    messagesBefore: number;
  }): CompactResult {
    const tokensAfter = this.getEstimatedTokens();
    const reducedBy = ctx.tokensBefore - tokensAfter;
    // Значимое сокращение: только тогда инкрементим счётчик и зовём onCompact.
    // No-op (reducedBy <= minReduction) не логируется и не искажает качество.
    const significant = ctx.opts?.minReduction === undefined || reducedBy > ctx.opts.minReduction;
    if (significant) {
      this.compactionCount++;
      // INV-15: прогресс-прокси — размер durable-леджера после поглощения адресов.
      this.compactionProgress.note(this.ledger?.totalRecorded() ?? 0);
    }
    const result: CompactResult = {
      removedTurns: ctx.oldTurns.length,
      keptTurns: ctx.freshRecent.length,
      tokensBefore: ctx.tokensBefore,
      tokensAfter,
      qualityBefore: ctx.qualityBefore,
      qualityAfter: this.getQuality(),
      messagesBefore: ctx.messagesBefore,
      messagesAfter: this.messages.length,
      summary: this.compactedBlock ?? "",
      reducedBy,
      strategy:
        ctx.opts?.keepLastN !== undefined && ctx.opts.keepLastN < KEEP_LAST_N
          ? "aggressive"
          : "summarize",
    };
    if (significant && this.onCompact) this.onCompact(ctx.summary);
    return result;
  }

  /**
   * Граница компакции. Не режет группу assistant(tool_calls): сохранённая
   * история не должна начинаться с сиротских role:"tool", а assistant-половина —
   * остаться в уплотняемой части (OpenAI-совместимые бэкенды такие истории отвергают).
   */
  private computeCutoff(keepLastN: number): number {
    let cutoff = this.messages.length - keepLastN * 2;
    while (
      cutoff > 0 &&
      (this.messages[cutoff]?.role === "tool" || this.messages[cutoff - 1]?.tool_calls?.length)
    ) {
      cutoff--;
    }
    return cutoff;
  }

  /**
   * Собирает внутренний блок сводки компакции из фактов и pinning-констант
   * (задача, план, thinking, «пробовали и не вышло»).
   */
  private buildCompactionBlock(oldTurns: Message[]): string {
    const parts: string[] = [];
    parts.push(`[Compressed: ${oldTurns.length} old turns removed]`);

    // Проносим реальную инструкцию юзера — модель не должна терять задачу,
    // над которой работает, лишь потому что уплотнилось 40 ходов. Задача хода
    // фолбэчится на миссию сессии (первую реальную инструкцию), чтобы вставка
    // ошибки/лога в текущем ходе не стирала цель.
    const task = (this.lastUserTask || this.sessionMission).slice(0, 400);
    if (task) parts.push(`[Task: ${task}]`);
    if (this.lastUserFeedback && !task.startsWith(this.lastUserFeedback)) {
      parts.push(`[User feedback: ${this.lastUserFeedback}]`);
    }

    // Ориентируем модель после компакции: активный план нельзя пересоздавать
    // с нуля (см. доку planSummaryProvider).
    const planLine = this.planSummaryProvider?.();
    if (planLine) parts.push(`[Plan: ${planLine}]`);

    for (const line of [
      this.facts.filesLine(),
      this.facts.deletedLine(),
      this.facts.readLine(),
      this.facts.decisionsLine(),
      this.facts.errorsLine(),
    ]) {
      if (line) parts.push(line);
    }

    if (this.thinkingLevel) parts.push(`[Thinking: ${this.thinkingLevel}]`);

    // Леджер: при durable леджере — компактный список адресов-находок (не
    // сырой вывод) + указатель; плюс legacy `[Tool ledger]` для тулов без адреса.
    if (this.compactionSummaryMode !== "off") {
      if (this.ledger) {
        const notes = this.ledger.renderBlock();
        if (notes) parts.push(notes);
      }
      if (this.toolLedger.length > 0) {
        parts.push(`[Tool ledger]\n${this.toolLedger.join("\n")}`);
      }
    }

    const triedAndFailed = extractTriedAndFailed(oldTurns);
    if (triedAndFailed.length > 0) {
      const lines = triedAndFailed.map(
        (t) => `- ${t.tool}(${t.args}): ${t.error} (failed ${t.count}x)`,
      );
      parts.push(`[Already tried & failed — do NOT repeat:]\n${lines.join("\n")}`);
    }

    return parts.join(" ");
  }

  /**
   * Stage A: детерминированная чистка старых tool-результатов (содержимое →
   * короткая заглушка). Никогда не трогает последние `protectLast` сообщений.
   * @returns число очищенных результатов.
   */
  pruneStaleToolResults(toolResultKeep = this.toolResultKeep, protectLast = KEEP_LAST_N): number {
    const toolIdx: number[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === "tool") toolIdx.push(i);
    }
    const protectedFrom = this.messages.length - protectLast;
    const keepFrom = toolIdx.length - toolResultKeep;
    let pruned = 0;
    for (let j = 0; j < toolIdx.length; j++) {
      const i = toolIdx[j];
      if (i >= protectedFrom) continue;
      if (j >= keepFrom) continue;
      const m = this.messages[i];
      const text = getMessageText(m.content);
      if (text.startsWith("[tool result pruned")) continue;
      this.messages[i] = { ...m, content: "[tool result pruned to save context]" };
      pruned++;
    }
    if (pruned > 0) {
      this.calibrator.invalidate();
      this.lastEstimateRaw = 0;
      this.lastEstimateMessageCount = 0;
    }
    return pruned;
  }

  /**
   * v2-компакция с гарантией прогресса: summarize → prune tool results →
   * aggressive keepLastN → hard drop. Возвращает результат первой стадии,
   * давшей значимое сокращение; иначе последний (hard-drop).
   */
  compactAdaptive(opts?: CompactOptions): CompactResult | null {
    const { minReduction, keepLastN, toolResultKeep } = this.resolveCompactOptions(opts);
    // Исходный объём — база для ОБЩЕГО прогресса. Стадии сжимают историю
    // последовательно, поэтому reducedBy отдельной стадии занижен; клиент
    // (CompactionService) должен видеть суммарное сокращение от исходного.
    const originalTokens = this.getEstimatedTokens();

    let result = this.finalizeAdaptive(this.compact({ keepLastN, minReduction }), originalTokens);
    if (this.isReduced(result, minReduction)) return result;

    result = this.finalizeAdaptive(
      this.escalatePrune(result, keepLastN, toolResultKeep, minReduction),
      originalTokens,
    );
    if (this.isReduced(result, minReduction)) return result;

    result = this.finalizeAdaptive(
      this.escalateAggressive(result, keepLastN, minReduction),
      originalTokens,
    );
    if (this.isReduced(result, minReduction)) return result;

    const smaller = Math.max(2, Math.floor(keepLastN / 2));
    return this.finalizeAdaptive(this.hardDropOldest(smaller) ?? result, originalTokens);
  }

  /** Пересчитывает токены результата как ОБЩЕЕ сокращение от исходного объёма. */
  private finalizeAdaptive(
    result: CompactResult | null,
    originalTokens: number,
  ): CompactResult | null {
    if (!result) return null;
    const tokensAfter = this.getEstimatedTokens();
    return {
      ...result,
      tokensBefore: originalTokens,
      tokensAfter,
      reducedBy: originalTokens - tokensAfter,
    };
  }

  /** Резолвит опции компакции с дефолтами менеджера. */
  private resolveCompactOptions(opts?: CompactOptions): {
    minReduction: number;
    keepLastN: number;
    toolResultKeep: number;
  } {
    return {
      minReduction: opts?.minReduction ?? 0,
      keepLastN: opts?.keepLastN ?? KEEP_LAST_N,
      toolResultKeep: opts?.toolResultKeep ?? this.toolResultKeep,
    };
  }

  /** True, если результат дал значимое сокращение. */
  private isReduced(result: CompactResult | null, minReduction: number): boolean {
    return result !== null && result.reducedBy > minReduction;
  }

  /** Стадия A: чистка старых tool-результатов + повторная суммаризация. */
  private escalatePrune(
    prev: CompactResult | null,
    keepLastN: number,
    toolResultKeep: number,
    minReduction: number,
  ): CompactResult | null {
    if (this.pruneStaleToolResults(toolResultKeep, keepLastN) <= 0) return prev;
    const pruned = this.compact({ keepLastN, minReduction });
    return pruned ? { ...pruned, strategy: "prune-tools" } : prev;
  }

  /** Стадия B: агрессивнее оставляем свежих сообщений. */
  private escalateAggressive(
    prev: CompactResult | null,
    keepLastN: number,
    minReduction: number,
  ): CompactResult | null {
    const smaller = Math.max(2, Math.floor(keepLastN / 2));
    if (smaller >= keepLastN) return prev;
    const aggressive = this.compact({ keepLastN: smaller, minReduction });
    return aggressive ? { ...aggressive, strategy: "aggressive" } : prev;
  }

  /**
   * Stage C: жёсткий дроп старейших групп сверх `keep` (system и активный
   * system-summary сохраняются). Пишет диагностику вызывающему.
   */
  private hardDropOldest(keep: number): CompactResult | null {
    const firstSystem = this.messages.find((m) => m.role === "system");
    const nonSystem = this.messages.filter((m) => m.role !== "system");
    if (nonSystem.length <= keep) return null;
    const tokensBefore = this.getEstimatedTokens();
    const qualityBefore = this.getQuality();
    const messagesBefore = this.messages.length;
    const head = nonSystem.slice(0, Math.max(0, nonSystem.length - keep * 2));
    const tail = nonSystem.slice(Math.max(0, nonSystem.length - keep * 2));
    this.facts.extract(head);
    absorbLedgers(
      head,
      this.ledger,
      this.compactionSummaryMode !== "off",
      this.toolLedger,
      this.toolLedgerKeys,
    );
    const summary: Message = this.stampSeq({
      role: "user",
      content: `<system-summary>[Compressed: ${head.length} old turns hard-dropped to fit context]${this.compactedBlock ? ` ${this.compactedBlock}` : ""}</system-summary>`,
    });
    this.messages = [...(firstSystem ? [firstSystem] : []), summary, ...tail];
    this.iterationsSinceCompaction = 0;
    this.calibrator.invalidate();
    this.lastEstimateRaw = 0;
    this.lastEstimateMessageCount = 0;
    this.compactionCount++;
    // INV-15: hard-drop тоже поглотил адреса — учитываем прогресс.
    this.compactionProgress.note(this.ledger?.totalRecorded() ?? 0);
    const tokensAfter = this.getEstimatedTokens();
    if (this.onCompact) this.onCompact(summary);
    return {
      removedTurns: head.length,
      keptTurns: tail.length,
      tokensBefore,
      tokensAfter,
      qualityBefore,
      qualityAfter: this.getQuality(),
      messagesBefore,
      messagesAfter: this.messages.length,
      summary: (this.compactedBlock ?? ""),
      reducedBy: tokensBefore - tokensAfter,
      strategy: "hard-drop",
    };
  }

  /**
   * Снапшот текущего состояния контекста — для лога начальной структуры
   * контекста на старте сессии и per-iteration статистики.
   */
  /** Токены системного сообщения (0, если его нет). */
  private systemTokens(): number {
    const sys = this.messages.find((m) => m.role === "system");
    return sys ? this.estimateMessageTokensCached(sys) : 0;
  }

  /**
   * Сегментная разбивка контекста: system / tools / history / reserve / free.
   * `used` = все сообщения (включая system) + токены тулов, поэтому
   * `system + tools + history === used` — дерево разбивки сходится.
   */
  getBreakdown(): ContextBreakdown {
    const used = this.getEstimatedTokens();
    const system = this.systemTokens();
    const tools = this.toolTokens;
    const history = Math.max(0, used - system - tools);
    const b = this.budget;
    return {
      system,
      tools,
      history,
      used,
      systemBudget: b.systemPrompt,
      historyBudget: b.history,
      reserve: b.responseReserve,
      free: Math.max(0, this.contextWindow - used - b.responseReserve),
      window: this.contextWindow,
    };
  }

  getSnapshot(): ContextSnapshot {
    const diag = this.getEstimateDiagnostics();
    return {
      window: this.contextWindow,
      budget: { ...this.budget },
      tokens: this.getEstimatedTokens(),
      toolTokens: this.toolTokens,
      messageCount: this.messages.length,
      quality: this.getQuality(),
      compactionCount: this.compactionCount,
      iterationsSinceCompaction: this.iterationsSinceCompaction,
      breakdown: this.getBreakdown(),
      estimatedTokensRaw: diag.raw,
      contextTokens: diag.calibrated,
      calibrationRatio: diag.ratio,
      calibrationState: diag.state,
    };
  }

  /**
   * Заменяет системный промпт на месте (остаётся первым) или пренпендит новый.
   * Обновляет динамические блоки промпта (напр. чеклист плана) посреди прогона.
   */
  updateSystemPrompt(content: string): void {
    const idx = this.messages.findIndex((m) => m.role === "system");
    if (idx >= 0) {
      this.messages[idx] = { ...this.messages[idx], content };
    } else {
      this.messages.unshift(this.stampSeq({ role: "system", content }));
    }
    // Baseline калибровки НЕ сбрасываем: схема baseline+delta инвариантна к
    // составу промпта (raw пересчитывается с новым system, дельта корректна).
    // Сброс на каждый плановый чеклист держал бы калибровку вечно в warmup.
  }

  /** Копия активной истории сообщений. */
  getActiveHistory(): Message[] {
    return [...this.messages];
  }

  /**
   * Снимает маркер начала захода для сбора tool-событий (критик/evidence).
   * Возвращает текущее значение счётчика seq: всё, что добавлено позже, имеет
   * `seqOf >= маркера`. Устойчиво к компакции — выжившие сообщения не меняют seq.
   */
  beginTurn(): number {
    return this.nextSeq;
  }

  /** Монотонный seq сообщения (0, если штамп не ставился — напр. system до старта). */
  seqOf(msg: object): number {
    return this.seqByMessage.get(msg) ?? 0;
  }

  /** Ставит монотонный seq в WeakMap и возвращает сообщение. */
  private stampSeq<T extends Message>(msg: T): T {
    this.seqByMessage.set(msg, this.nextSeq++);
    return msg;
  }

  /**
   * Сбрасывает всё, что принадлежит текущему ходу диалога.
   * Списки фактов (FactExtractor) осознанно переживают clear() — это
   * session-scoped состояние компакции, не per-turn.
   */
  clear(): void {
    this.messages = [];
    this.compactedBlock = null;
    this.toolLedger = [];
    this.toolLedgerKeys = new Set();
    this.iterationsSinceCompaction = 0;
    this.compactionCount = 0;
    this.peakTokens = 0;
    this.lastUserTask = "";
    this.lastUserFeedback = "";
    this.sessionMission = "";
    this.calibrator = new ContextCalibrator(this.calibrationOptions);
    this.lastEstimateRaw = 0;
    this.lastEstimateMessageCount = 0;
    this.lastJumpWasImplausible = false;
    this.compactionProgress.reset();
  }

  /** Оценка токенов истории (сообщения + токены тулов). */
  getEstimatedTokens(): number {
    return (
      this.messages.reduce((sum, m) => sum + this.estimateMessageTokensCached(m), 0) + this.toolTokens
    );
  }

  /**
   * Калиброванная оценка — вход для порогов компакции. Сырая оценка остаётся
   * в `getEstimatedTokens()` для бюджета cost-tracking/prefix/critic.
   */
  getContextTokens(): number {
    return this.calibrator.calibrate(this.getEstimatedTokens(), this.messages.length);
  }

  /**
   * Принимает реальный `usage` после LLM-вызова и обновляет калибровку.
   * @param actual реальные `prompt_tokens`; `estimatedAtSend` — сырая оценка
   *   на момент отправки; `messageCount` — число сообщений в тот момент.
   */
  calibrate(actual: number, estimatedAtSend: number, messageCount: number): void {
    this.calibrator.observe(actual, estimatedAtSend, messageCount);
  }

  /** Помечает LLM-вызов без `usage` (провайдер не отдал токены). */
  noteMissingUsage(): void {
    this.calibrator.noteMissingUsage();
  }

  /** Диагностика оценки контекста (аддитивные поля лога/снимка). */
  getEstimateDiagnostics(): ContextEstimateDiagnostics {
    const raw = this.getEstimatedTokens();
    return {
      raw,
      calibrated: this.calibrator.calibrate(raw, this.messages.length),
      ratio: this.calibrator.getRatio(),
      state: this.calibrator.getState(),
    };
  }

  /**
   * Проверка порога overflow с safety-clamp: неправдоподобный скачок сырой
   * оценки не запускает компакцию (warn-диагностика в логе). Вызывается один
   * раз на итерацию, обновляет замеренную точку.
   */
  checkOverflowAllowed(): { allowed: boolean; raw: number; calibrated: number; implausible: boolean } {
    const raw = this.getEstimatedTokens();
    const messageCount = this.messages.length;
    const implausible = isImplausibleJump(
      raw,
      this.lastEstimateRaw,
      messageCount,
      this.lastEstimateMessageCount,
    );
    this.lastEstimateRaw = raw;
    this.lastEstimateMessageCount = messageCount;
    this.lastJumpWasImplausible = implausible;
    const calibrated = this.calibrator.calibrate(raw, messageCount);
    return {
      allowed: !implausible && calibrated > this.budget.history,
      raw,
      calibrated,
      implausible,
    };
  }

  /** True, если последняя проверка overflow была отброшена safety-clamp. */
  wasLastJumpImplausible(): boolean {
    return this.lastJumpWasImplausible;
  }

  /** Задаёт токены определений тулов (прибавляются к оценке). */
  setToolTokens(tokens: number): void {
    this.toolTokens = tokens;
  }

  /** Пересчитывает бюджеты под новое окно контекста (и опционально счётчик). */
  resize(
    contextWindow: number,
    contextBudget?: ConfigContextBudget,
    tokenCounter?: TokenCounter | null,
  ): void {
    this.contextWindow = contextWindow;
    this.budget = this.calculateBudget(contextWindow, contextBudget);
    if (tokenCounter !== undefined) {
      this.tokenCounter = tokenCounter ?? null;
    }
    // Reconfigure/смена окна — калибровка недействительна.
    this.calibrator.invalidate();
  }

  /**
   * Токены истории для порога overflow: `used − system − tools` (калибровано).
   * Эквивалент `getBreakdown().history` в терминах калиброванной оценки.
   */
  getHistoryTokens(): number {
    return Math.max(0, this.getContextTokens() - this.systemTokens() - this.toolTokens);
  }
}
