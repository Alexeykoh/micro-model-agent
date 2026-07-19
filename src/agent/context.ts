import type { ChatMessage } from '../llm/provider.js';
import { countTokens } from '../llm/token-counter.js';
import { getTheme } from '../styling/index.js';
import { logInfo, logDebug } from '../logger.js';

/**
 * Менеджер контекста агента.
 *
 * Отвечает за:
 * - Хранение истории сообщений (пользователь + ассистент)
 * - Автоматическую компактификацию при приближении к лимиту токенов
 * - Инкрементальный подсчёт токенов (только новые сообщения)
 * - Emergency compact при переполнении контекста
 *
 * Стратегия компактификации:
 * - Каждое сообщение получает score (base 50 + role bonus + recency bonus)
 * - Сохраняются топ-6 по score + последние 6 по позиции
 * - Tool-вызовы и их результаты сохраняются в summary
 * - Остальные сообщения суммируются в блок "[Ранее в разговоре (сжато):]"
 *
 * @module agent/context
 */

/** Сообщение с оценкой важности и количеством токенов */
interface ScoredMessage {
  msg: ChatMessage;
  score: number;
  tokens: number;
}

/**
 * Менеджер контекста — управляет историей сообщений и компактификацией.
 * Создаётся один раз на сессию агента.
 */
export class ContextManager {
  private tokenCache = new WeakMap<ChatMessage, number>(); // кэш подсчёта токенов
  private compacted = 0; // количество компактификаций за сессию
  private _totalTokens = 0; // общее количество токенов в истории
  private _history: { role: string; tokens: number }[] = []; // история по ролям
  private _lastCountedIndex = 0; // индекс последнего подсчитанного сообщения (для инкрементального подсчёта)

  /**
   * @param contextWindow - размер контекстного окна модели (в токенах)
   * @param compactThreshold - порог компактификации (по умолчанию 70%)
   * @param responseBuffer - резерв под ответ модели (по умолчанию 4096 токенов)
   */
  constructor(
    private contextWindow: number,
    private compactThreshold: number = 0.70,
    private responseBuffer: number = 4096,
  ) {}

  get totalTokens(): number {
    return this._totalTokens;
  }

  get usagePercent(): number {
    return (this._totalTokens / this.contextWindow) * 100;
  }

  get needsCompact(): boolean {
    return this.usagePercent >= this.compactThreshold * 100;
  }

  /** Контекст переполнен — нет места для ответа модели */
  get isOverflow(): boolean {
    return this._totalTokens + this.responseBuffer >= this.contextWindow;
  }

  /** Количество компактификаций за сессию */
  get compactCount(): number {
    return this.compacted;
  }

  /**
   * Оценивает важность сообщения для компактификации.
   *
   * Алгоритм:
   * - System: 100 (всегда сохраняется отдельно)
   * - Tool с ошибкой: 90 (важно для диагностики)
   * - User с "важно"/"critical": 85
   * - Tool с успехом: 70
   * - Assistant с ошибкой/решением: 70-75
   * - User-вопрос: 65
   * - Обычный user/assistant: 40-60
   * + Recency bonus: (index/total) * 20
   */
  private scoreMessage(msg: ChatMessage, index: number, total: number): number {
    let score = 50; // базовая оценка

    // Оценка по роли сообщения
    if (msg.role === 'system') score = 100;
    else if (msg.role === 'tool') {
      const content = (msg.content || '').toLowerCase();
      if (content.includes('error') || content.includes('fail')) score = 90;
      else if (content.includes('✓') || content.includes('success')) score = 70;
      else score = 60;
    }
    else if (msg.role === 'user') {
      const content = (msg.content || '').toLowerCase();
      if (content.includes('decision') || content.includes('важно') || content.includes('critical')) score = 85;
      else if (content.includes('?')) score = 65;
      else score = 60;
    }
    else if (msg.role === 'assistant') {
      const content = (msg.content || '').toLowerCase();
      if (content.includes('error') || content.includes('ошибка')) score = 75;
      else if (content.includes(' decided ') || content.includes('решено')) score = 70;
      else score = 65;  // reasoning слишком важен для удаления (было 40)
    }

    // Бонус за длину — длинные ответы = более ценные рассуждения
    const lengthBonus = Math.min(15, Math.floor((msg.content?.length || 0) / 500));
    score += lengthBonus;

    // Бонус за свежесть: чем позже сообщение, тем выше бонус
    const recencyBonus = (index / total) * 20;
    score += recencyBonus;

    return score;
  }

  /**
   * Инкрементальный подсчёт токенов — считает только новые сообщения.
   * Используется в основном цикле для производительности.
   * После компактинга вызывать полный updateTokens().
   */
  async updateTokensIncremental(messages: ChatMessage[]): Promise<void> {
    const start = performance.now();
    const prevIndex = this._lastCountedIndex;
    for (let i = this._lastCountedIndex; i < messages.length; i++) {
      let t = this.tokenCache.get(messages[i]);
      if (t === undefined) {
        t = await countTokens(messages[i].content || '');
        this.tokenCache.set(messages[i], t);
      }
      this._totalTokens += t;
      this._history.push({ role: messages[i].role, tokens: t });
    }
    this._lastCountedIndex = messages.length;
    const elapsed = (performance.now() - start).toFixed(1);
    logDebug('CONTEXT', `updateTokensIncremental: +${messages.length - prevIndex} msgs, total ${this._totalTokens} tokens, ${elapsed}ms`);
  }

  /**
   * Полный подсчёт токенов для всех сообщений.
   * Используется после компактификации (когда сообщения заменены).
   */
  async updateTokens(messages: ChatMessage[]): Promise<void> {
    const start = performance.now();
    let total = 0;
    this._history = [];
    for (const msg of messages) {
      let t = this.tokenCache.get(msg);
      if (t === undefined) {
        t = await countTokens(msg.content || '');
        this.tokenCache.set(msg, t);
      }
      total += t;
      this._history.push({ role: msg.role, tokens: t });
    }
    this._totalTokens = total;
    this._lastCountedIndex = messages.length;
    const elapsed = (performance.now() - start).toFixed(1);
    logDebug('CONTEXT', `updateTokens: ${messages.length} msgs, ${total} tokens, ${elapsed}ms`);
  }

  /**
   * Emergency compact — агрессивное сжатие при переполнении контекста.
   * Оставляет system prompt + последние 4 сообщения.
   */
  emergencyCompact(messages: ChatMessage[]): ChatMessage[] {
    const start = performance.now();
    const system = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const recent = nonSystem.slice(-4);

    if (recent.length >= nonSystem.length) return messages;

    const summary = `[Emergency compact: ${nonSystem.length - recent.length} messages compressed to free context space. Continue from the most recent messages.]`;

    this.compacted++;
    this.tokenCache = new WeakMap<ChatMessage, number>();
    this._lastCountedIndex = 0;

    const result: ChatMessage[] = [
      ...system,
      { role: 'system' as const, content: summary },
      ...recent,
    ];
    const elapsed = (performance.now() - start).toFixed(1);
    logInfo('CONTEXT', `emergencyCompact: ${messages.length} → ${result.length} msgs in ${elapsed}ms`);
    return result;
  }

  /**
   * Компактификация истории сообщений.
   *
   * Стратегия:
   * 1. Сохраняем system prompt (всегда первый)
   * 2. Сохраняем первое user-сообщение (контекст задачи)
   * 3. Остальные сообщения оцениваем по score
   * 4. Сохраняем топ-6 по score + последние 6 по позиции
   * 5. Tool-вызовы и результаты сохраняются в summary
   * 6. Остальные суммируем в "[Ранее в разговоре (сжато):]"
   *
   * @param messages - полная история сообщений
   * @returns Сжатая история
   */
  compact(messages: ChatMessage[]): ChatMessage[] {
    const start = performance.now();
    logInfo('CONTEXT', `compact: ${messages.length} messages before`);
    if (messages.length <= 4) return messages;

    // Извлекаем system prompt и первое user-сообщение
    const systemIdx = messages.findIndex(m => m.role === 'system');
    const system = systemIdx >= 0 ? [messages[systemIdx]] : [];

    const keepFirstUser: ChatMessage[] = [];
    const remaining: ChatMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      if (systemIdx === i) continue;
      if (keepFirstUser.length === 0 && messages[i].role === 'user') {
        keepFirstUser.push(messages[i]);
      } else {
        remaining.push(messages[i]);
      }
    }

    // Оцениваем все оставшиеся сообщения
    const scored: ScoredMessage[] = remaining.map((msg, i) => ({
      msg,
      score: this.scoreMessage(msg, i, remaining.length),
      tokens: this.tokenCache.get(msg) || 0,
    }));

    // Сортируем по убыванию score
    scored.sort((a, b) => b.score - a.score);

    // Сохраняем топ-6 по score + последние 6 по позиции
    const recentMsgs = remaining.slice(-6);
    const recentIds = new Set(recentMsgs.map(m => m));

    const importantByScore = scored
      .filter(s => !recentIds.has(s.msg))
      .slice(0, 6)
      .map(s => s.msg);

    // Сообщения, которые будут сжаты в summary
    const toCompact = remaining.filter(m => !recentMsgs.includes(m) && !importantByScore.includes(m));

    if (toCompact.length === 0) return messages;

    // Формируем структурированную сводку с сохранением tool-контекста
    const compactedPairs: string[] = [];
    const toolOps: string[] = []; // уникальные tool-операции
    const filesTouched: string[] = []; // затронутые файлы

    let i = 0;
    while (i < toCompact.length) {
      const msg = toCompact[i];

      if (msg.role === 'user') {
        const assistant = i + 1 < toCompact.length ? toCompact[i + 1] : null;
        if (assistant?.role === 'assistant') {
          // Извлекаем tool-вызовы из ответа ассистента
          const toolMatches = assistant.content.matchAll(
            /<tool_call>\{"name":"(\w+)"/g,
          );
          for (const match of toolMatches) {
            toolOps.push(match[1]);
          }
          // Извлекаем затронутые файлы из tool-вызовов
          const fileMatches = assistant.content.matchAll(
            /"path"\s*:\s*"([^"]+)"/g,
          );
          for (const match of fileMatches) {
            filesTouched.push(match[1]);
          }
          const preview = assistant.content.slice(0, 200).replace(/\n/g, ' ');
          compactedPairs.push(`User: ${msg.content.slice(0, 150)}... → ${preview}...`);
          i += 2;
        } else {
          compactedPairs.push(`[user]: ${msg.content.slice(0, 150)}...`);
          i++;
        }
      } else if (msg.role === 'tool') {
        // Tool-результаты: сохраняем краткую сводку
        const toolPreview = (msg.content || '').slice(0, 200).replace(/\n/g, ' ');
        compactedPairs.push(`[tool result]: ${toolPreview}...`);
        i++;
      } else {
        compactedPairs.push(`[${msg.role}]: ${(msg.content || '').slice(0, 150)}...`);
        i++;
      }
    }

    // Добавляем сводку tool-операций и затронутых файлов
    const toolSummary = toolOps.length > 0
      ? `\nTools used: ${[...new Set(toolOps)].join(', ')}${filesTouched.length > 0 ? '\nFiles touched: ' + [...new Set(filesTouched)].join(', ') : ''}`
      : '';

    let summary = `[Ранее в разговоре (сжато):\n${compactedPairs.join('\n')}${toolSummary}\n]`;
    if (summary.length > 3000) {
      summary = summary.slice(0, 3000) + '\n...]';
    }

    this.compacted++;
    this.tokenCache = new WeakMap<ChatMessage, number>();
    this._lastCountedIndex = 0;

    const result: ChatMessage[] = [
      ...system,
      ...keepFirstUser,
      { role: 'system' as const, content: summary },
      ...importantByScore,
      ...recentMsgs,
    ];
    const elapsed = (performance.now() - start).toFixed(1);
    logInfo('CONTEXT', `compact: ${messages.length} → ${result.length} msgs in ${elapsed}ms`);
    return result;
  }

  /** Форматирует строку использования контекста для отображения в UI */
  formatUsage(): string {
    const theme = getTheme();
    const pct = this.usagePercent;
    const barLen = 10;
    const bar = theme.contextBar(pct, barLen);

    const roleTokens: Record<string, number> = {};
    for (const h of this._history) {
      roleTokens[h.role] = (roleTokens[h.role] || 0) + h.tokens;
    }

    const breakdown = Object.entries(roleTokens)
      .map(([role, tokens]) => `${role}:${tokens}`)
      .join(' ');

    return `Context: ${this._totalTokens.toLocaleString()} / ${this.contextWindow.toLocaleString()} (${pct.toFixed(0)}%) ${bar} compacted:${this.compacted} ${breakdown}`;
  }
}
