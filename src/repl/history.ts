import type { LLMProvider } from '../llm/provider.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { OutputRenderer } from '../ui/renderer.js';
import { runAgentLoop, type AgentLoopResult } from '../agent/loop.js';

export class ConversationHistory {
  private messages: { role: 'user' | 'assistant'; content: string }[] = [];

  get length(): number {
    return this.messages.length;
  }

  get all(): { role: 'user' | 'assistant'; content: string }[] {
    return this.messages;
  }

  push(role: 'user' | 'assistant', content: string): void {
    this.messages.push({ role, content });
  }

  pushFromResult(result: AgentLoopResult): void {
    for (const msg of result.messages) {
      if (msg.role !== 'system') {
        this.messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      }
    }
  }

  clear(): void {
    this.messages.length = 0;
  }

  async send(
    prompt: string,
    provider: LLMProvider,
    registry: ToolRegistry,
    renderer: OutputRenderer,
    providerName?: string,
  ): Promise<AgentLoopResult> {
    const result = await runAgentLoop(
      provider,
      registry,
      prompt,
      undefined,
      this.messages,
      renderer,
      providerName,
    );
    this.pushFromResult(result);
    return result;
  }
}
