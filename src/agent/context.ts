import type { ChatMessage } from '../llm/provider.js';
import { countTokens } from '../llm/token-counter.js';

interface MessageBudget {
  tokens: number;
  priority: number;
}

export class ContextManager {
  private tokenCache = new WeakMap<ChatMessage, number>();
  private compacted = 0;
  private _totalTokens = 0;

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

  async updateTokens(messages: ChatMessage[]): Promise<void> {
    let total = 0;
    for (const msg of messages) {
      let t = this.tokenCache.get(msg);
      if (t === undefined) {
        t = await countTokens(msg.content || '');
        this.tokenCache.set(msg, t);
      }
      total += t;
    }
    this._totalTokens = total;
  }

  compact(messages: ChatMessage[]): ChatMessage[] {
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

    const keepRecent = remaining.slice(-6);
    const toCompact = remaining.slice(0, -6);

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

    return [
      ...system,
      ...keepFirstUser,
      { role: 'system', content: summary },
      ...keepRecent,
    ];
  }

  formatUsage(): string {
    const pct = this.usagePercent;
    const barLen = 20;
    const filled = Math.round((pct / 100) * barLen);
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    return `Context: ${this._totalTokens.toLocaleString()} / ${this.contextWindow.toLocaleString()} tokens (${pct.toFixed(0)}%)\n  ${bar}`;
  }
}
