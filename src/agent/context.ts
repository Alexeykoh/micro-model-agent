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
 * - Оценку важности сообщений (scoring heuristic)
 * - Буфер обновлений для отложенной компактификации
 *
 * Стратегия компактификации:
 * - Каждое сообщение получает score (base 50 + role bonus + recency bonus)
 * - Сохраняются топ-6 по score + последние 6 по позиции
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

  /**
   * @param contextWindow - размер контекстного окна модели (в токенах)
   * @param compactThreshold - порог компактификации (по умолчанию 85%)
   */
  constructor(
    private contextWindow: number,
    private compactThreshold: number = 0.85,
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
      const content = msg.content || '';
      if (content.includes('Error') || content.includes('error') || content.includes('FAIL')) score = 90;
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
      else score = 40;
    }

    // Бонус за свежесть: чем позже сообщение, тем выше бонус
    const recencyBonus = (index / total) * 20;
    score += recencyBonus;

    return score;
  }

  /**
   * Обновляет подсчёт токенов для всех сообщений.
   * Использует WeakMap для кэширования — повторный подсчёт не выполняется.
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
    const elapsed = (performance.now() - start).toFixed(1);
    logDebug('CONTEXT', `updateTokens: ${messages.length} msgs, ${total} tokens, ${elapsed}ms`);
  }

  /**
   * Компактификация истории сообщений.
   *
   * Стратегия:
   * 1. Сохраняем system prompt (всегда первый)
   * 2. Сохраняем первое user-сообщение (контекст задачи)
   * 3. Остальные сообщения оцениваем по score
   * 4. Сохраняем топ-6 по score + последние 6 по позиции
   * 5. Остальные суммируем в "[Ранее в разговоре (сжато):]"
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

    // Формируем краткую сводку из сжатых сообщений
    const compactedPairs: string[] = [];
    let i = 0;
    while (i < toCompact.length) {
      const user = toCompact[i];
      const assistant = i + 1 < toCompact.length ? toCompact[i + 1] : null;

      if (user.role === 'user' && assistant?.role === 'assistant') {
        const preview = assistant.content.slice(0, 200).replace(/\n/g, ' ');
        compactedPairs.push(`User: ${user.content.slice(0, 100)}... → ${preview}...`);
        i += 2;
      } else {
        compactedPairs.push(`[${toCompact[i].role}]: ${toCompact[i].content.slice(0, 100)}...`);
        i++;
      }
    }

    let summary = `[Ранее в разговоре (сжато):\n${compactedPairs.join('\n')}\n]`;
    if (summary.length > 2000) {
      summary = summary.slice(0, 2000) + '\n...]';
    }

    this.compacted++;
    this.tokenCache = new WeakMap<ChatMessage, number>();
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
