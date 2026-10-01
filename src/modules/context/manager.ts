// Менеджер контекста: история, бюджеты, компакция, качество, факты сессии.
import type { ContentPart, TextPart } from "../../llm/provider";
import { getMessageText } from "../../llm/provider";
import { FactExtractor } from "./fact-extractor";
import { truncate } from "../../utils/truncate";
import type { ContextBreakdown } from "../../core/types";
export type { ContextBreakdown };

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
import type { TokenCounter } from "../../llm/token-counter";

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
}

/** Запись "пробовали и не вышло": тул, args, ошибка, счётчик повторов. */
export interface TriedAndFailed {
  tool: string;
  args: string;
  error: string;
  count: number;
}

function summarizeArgs(args: unknown): string {
  if (!args) return "";
  if (typeof args === "string") return args.slice(0, 80);
  try {
    const keys = Object.keys(args as Record<string, unknown>);
    return keys.slice(0, 3).join(", ");
  } catch {
    return String(args).slice(0, 80);
  }
}

function looksLikeErrorPaste(text: string): boolean {
  // Маркеры ошибок.
  if (
    /(?:^|\s)ERROR|Error:|error TS\d+|Transform failed|\[plugin:|SyntaxError|Cannot find|Uncaught|exception/i.test(
      text,
    )
  ) {
    return true;
  }
  // Структурные сигналы вставленного вывода компилятора/рантайма: фреймы
  // исходников ("270|  }_s(...)"), ссылки path:line:col и строки стектрейсов.
  if (/(?:^|\n)\s*\d+\s*\|/.test(text)) return true;
  if (/[\w./\\-]+\.[a-z]{1,6}:\d+:\d+/.test(text)) return true;
  if (/(?:^|\n)\s*at\s+\S+/.test(text)) return true;
  return false;
}

/** Извлекает повторы "пробовали и не вышло" (≥2 фейлов одного тула+args). */
export function extractTriedAndFailed(messages: Message[]): TriedAndFailed[] {
  const failures: Map<string, TriedAndFailed> = new Map();

  for (const msg of messages) {
    if (msg.role === "tool" && msg.name && msg.success === false) {
      // Заблокированные плагином вызовы — решения гардов, не попытки: транзиентный
      // гард (или его баг) нельзя запоминать как "пробовали и не вышло — НЕ повторять"
      // (было: ложный plan-alignment блок заставил модель отказываться переписывать
      // файл собственного шага).
      if (msg.blocked) continue;
      const key = `${msg.name}:${summarizeArgs(msg.arguments)}`;
      const existing = failures.get(key);
      const errorText = truncate(
        typeof msg.content === "string" ? msg.content : getMessageText(msg.content),
        100,
      );
      if (existing) {
        existing.count++;
      } else {
        failures.set(key, {
          tool: msg.name,
          args: summarizeArgs(msg.arguments),
          error: errorText,
          count: 1,
        });
      }
    }
  }

  return Array.from(failures.values()).filter((f) => f.count >= 2);
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
    this.compactionThreshold = contextBudget?.compactionThreshold ?? 0.75;
    this.compactionMinLoad = contextBudget?.compactionMinLoad ?? 0.5;
    this.budget = this.calculateBudget(contextWindow, contextBudget);
    this.tokenCounter = tokenCounter ?? null;
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
    const usedTokens = this.getEstimatedTokens();
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
    this.messages.push(msg);
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

  // Токенный кэш на сообщение: сообщения считаются иммутабельными после добавления
  // (компакция/updateSystemPrompt создают новые объекты), поэтому WeakMap безопасен
  // и превращает повторную оценку всей истории из O(n) кодирований в O(1).
  private tokenCache = new WeakMap<Message, number>();

  private estimateMessageTokensCached(m: Message): number {
    let t = this.tokenCache.get(m);
    if (t === undefined) {
      t = this.estimateMessageTokens(m);
      this.tokenCache.set(m, t);
    }
    return t;
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
    const totalTokens = this.messages.reduce((sum, m) => sum + this.estimateMessageTokensCached(m), 0);
    if (totalTokens > this.budget.history * this.compactionThreshold) return true;

    // Интервал итераций уплотняет только значимо загруженную историю.
    // Уплотнять слабозагруженный контекст — терять рабочее состояние без
    // бюджетной причины (см. `compactionMinLoad`).
    if (this.iterationsSinceCompaction < COMPACTION_INTERVAL) return false;
    const load = this.budget.history > 0 ? totalTokens / this.budget.history : 0;
    return load >= this.compactionMinLoad;
  }

  /** Уплотняет историю: старые ходы → сводка фактов, свежие — дословно. Null, если уплотнять нечего. */
  compact(): CompactResult | null {
    // Снимаем состояние ДО компакции ПЕРЕД сбросом/ростом счётчиков —
    // qualityBefore обязан отражать контекст, который реально видела модель.
    const tokensBefore = this.getEstimatedTokens();
    const qualityBefore = this.getQuality();
    const messagesBefore = this.messages.length;

    // Сбрасываем счётчик, даже если уплотнять нечего — иначе
    // needsCompaction() вечно true после 15 итераций с малым числом сообщений.
    this.iterationsSinceCompaction = 0;
    if (this.messages.length <= KEEP_LAST_N * 2) return null;

    this.compactionCount++;

    let cutoff = this.messages.length - KEEP_LAST_N * 2;
    // Не режем группу assistant(tool_calls) по cutoff: сохранённая история не
    // должна начинаться с сиротских role:"tool", а assistant-половина — остаться
    // в уплотняемой части (OpenAI-совместимые бэкенды такие истории отвергают).
    while (
      cutoff > 0 &&
      (this.messages[cutoff]?.role === "tool" || this.messages[cutoff - 1]?.tool_calls?.length)
    ) {
      cutoff--;
    }
    const oldTurns = this.messages.slice(0, cutoff);
    const recentTurns = this.messages.slice(cutoff);

    this.facts.extract(oldTurns);

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

    const filesLine = this.facts.filesLine();
    if (filesLine) parts.push(filesLine);
    const deletedLine = this.facts.deletedLine();
    if (deletedLine) parts.push(deletedLine);
    const readLine = this.facts.readLine();
    if (readLine) parts.push(readLine);
    const decisionsLine = this.facts.decisionsLine();
    if (decisionsLine) parts.push(decisionsLine);
    const errorsLine = this.facts.errorsLine();
    if (errorsLine) parts.push(errorsLine);

    if (this.thinkingLevel) parts.push(`[Thinking: ${this.thinkingLevel}]`);

    const triedAndFailed = extractTriedAndFailed(oldTurns);
    if (triedAndFailed.length > 0) {
      const lines = triedAndFailed.map(
        (t) => `- ${t.tool}(${t.args}): ${t.error} (failed ${t.count}x)`,
      );
      parts.push(`[Already tried & failed — do NOT repeat:]\n${lines.join("\n")}`);
    }

    this.compactedBlock = parts.join(" ");
    const summary: Message = {
      role: "user",
      content: `<system-summary>${this.compactedBlock}</system-summary>`,
    };

    const firstSystem = this.messages.find((m) => m.role === "system");
    // Чистим протухшие system-summary из свежих ходов против вложенности
    const freshRecent = recentTurns.filter((m) => {
      if (m.role !== "user") return true;
      const text = getMessageText(m.content);
      return !text.startsWith("<system-summary>");
    });
    this.messages = [...(firstSystem ? [firstSystem] : []), summary, ...freshRecent];
    this.iterationsSinceCompaction = 0;

    if (this.onCompact) {
      this.onCompact(summary);
    }

    return {
      removedTurns: oldTurns.length,
      keptTurns: freshRecent.length,
      tokensBefore,
      tokensAfter: this.getEstimatedTokens(),
      qualityBefore,
      qualityAfter: this.getQuality(),
      messagesBefore,
      messagesAfter: this.messages.length,
      summary: this.compactedBlock ?? "",
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
      this.messages.unshift({ role: "system", content });
    }
  }

  /** Копия активной истории сообщений. */
  getActiveHistory(): Message[] {
    return [...this.messages];
  }

  /**
   * Сбрасывает всё, что принадлежит текущему ходу диалога.
   * Списки фактов (FactExtractor) осознанно переживают clear() — это
   * session-scoped состояние компакции, не per-turn.
   */
  clear(): void {
    this.messages = [];
    this.compactedBlock = null;
    this.iterationsSinceCompaction = 0;
    this.compactionCount = 0;
    this.peakTokens = 0;
    this.lastUserTask = "";
    this.lastUserFeedback = "";
    this.sessionMission = "";
  }

  /** Оценка токенов истории (сообщения + токены тулов). */
  getEstimatedTokens(): number {
    return (
      this.messages.reduce((sum, m) => sum + this.estimateMessageTokensCached(m), 0) + this.toolTokens
    );
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
  }
}
