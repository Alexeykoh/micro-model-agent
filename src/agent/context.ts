import type { ChatMessage } from '../llm/provider.js';
import { countTokens } from '../llm/token-counter.js';
import { getTheme } from '../styling/index.js';
import { logInfo, logDebug } from '../logger.js';

interface ScoredMessage {
  msg: ChatMessage;
  score: number;
  tokens: number;
}

export class ContextManager {
  private tokenCache = new WeakMap<ChatMessage, number>();
  private compacted = 0;
  private _totalTokens = 0;
  private _history: { role: string; tokens: number }[] = [];

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

  private scoreMessage(msg: ChatMessage, index: number, total: number): number {
    let score = 50; // base

    // Role-based scoring
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

    // Recency bonus (more recent = higher)
    const recencyBonus = (index / total) * 20;
    score += recencyBonus;

    return score;
  }

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

  compact(messages: ChatMessage[]): ChatMessage[] {
    const start = performance.now();
    logInfo('CONTEXT', `compact: ${messages.length} messages before`);
    if (messages.length <= 4) return messages;

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

    // Score all messages
    const scored: ScoredMessage[] = remaining.map((msg, i) => ({
      msg,
      score: this.scoreMessage(msg, i, remaining.length),
      tokens: this.tokenCache.get(msg) || 0,
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Keep top 6 by score + last 6 by position
    const recentMsgs = remaining.slice(-6);
    const recentIds = new Set(recentMsgs.map(m => m));

    const importantByScore = scored
      .filter(s => !recentIds.has(s.msg))
      .slice(0, 6)
      .map(s => s.msg);

    const toCompact = remaining.filter(m => !recentMsgs.includes(m) && !importantByScore.includes(m));

    if (toCompact.length === 0) return messages;

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
