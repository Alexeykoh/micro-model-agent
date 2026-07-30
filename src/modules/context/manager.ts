export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

import type { ContextBudget as ConfigContextBudget } from "../../config/types";

export interface ContextBudget {
  systemPrompt: number;
  responseReserve: number;
  history: number;
}

const COMPACTION_INTERVAL = 15;
const KEEP_LAST_N = 6;

export class ContextManager {
  private contextWindow: number;
  private messages: Message[] = [];
  private compactedBlock: string | null = null;
  private iterationsSinceCompaction = 0;
  private budget: ContextBudget;
  private compactionThreshold: number;
  private fileFacts: string[] = [];
  private decisionFacts: string[] = [];
  private errorFacts: string[] = [];
  onCompact: ((summary: Message) => void) | null = null;

  constructor(contextWindow: number, contextBudget?: ConfigContextBudget) {
    this.contextWindow = contextWindow;
    this.compactionThreshold = contextBudget?.compactionThreshold ?? 0.75;
    this.budget = this.calculateBudget(contextWindow, contextBudget);
  }

  private calculateBudget(
    window: number,
    contextBudget?: ConfigContextBudget,
  ): ContextBudget {
    if (contextBudget) {
      const systemPrompt = Math.floor(window * contextBudget.systemPrompt);
      const responseReserve = Math.floor(
        window * contextBudget.responseReserve,
      );
      const history = Math.max(0, window - systemPrompt - responseReserve);
      return { systemPrompt, responseReserve, history };
    }
    // Fallback for backwards compatibility (tests, subagents without explicit budget)
    return {
      systemPrompt: Math.floor(window * 0.25),
      responseReserve: Math.floor(window * 0.12),
      history: Math.floor(window * 0.63),
    };
  }

  getBudget(): ContextBudget {
    return { ...this.budget };
  }

  addMessage(msg: Message): void {
    this.messages.push(msg);
    this.iterationsSinceCompaction++;
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  needsCompaction(): boolean {
    if (this.iterationsSinceCompaction >= COMPACTION_INTERVAL) return true;
    const totalTokens = this.messages.reduce(
      (sum, m) => sum + m.content.length / 2,
      0,
    );
    return totalTokens > this.budget.history * this.compactionThreshold;
  }

  compact(): void {
    if (this.messages.length <= KEEP_LAST_N * 2) return;

    const cutoff = this.messages.length - KEEP_LAST_N * 2;
    const oldTurns = this.messages.slice(0, cutoff);
    const recentTurns = this.messages.slice(cutoff);

    this.extractFacts(oldTurns);

    const parts: string[] = [];
    parts.push(`[Compressed: ${oldTurns.length} old turns removed]`);

    if (this.fileFacts.length > 0) {
      parts.push(`[Files: ${this.fileFacts.slice(-15).join("; ")}]`);
    }
    if (this.decisionFacts.length > 0) {
      parts.push(`[Decisions: ${this.decisionFacts.slice(-5).join("; ")}]`);
    }
    if (this.errorFacts.length > 0) {
      parts.push(`[Errors: ${this.errorFacts.slice(-3).join("; ")}]`);
    }

    this.compactedBlock = parts.join(" ");
    const summary: Message = { role: "system", content: this.compactedBlock };

    this.messages = [summary, ...recentTurns];
    this.iterationsSinceCompaction = 0;

    if (this.onCompact) {
      this.onCompact(summary);
    }
  }

  private extractFacts(turns: Message[]): void {
    const filePatterns = [
      /(?:Created|Updated|Written|Deleted|Moved) ([\w./\\-]+\.[a-z]+)/gi,
      /Файл (?:создан|обновлён|записан|удалён|перемещён):? ([\w./\\-]+\.[a-z]+)/gi,
      /file (?:created|updated|written|deleted|moved):? ([\w./\\-]+\.[a-z]+)/gi,
    ];

    for (const msg of turns) {
      const content = msg.content;

      if (msg.role === "tool") {
        for (const pattern of filePatterns) {
          for (const match of content.matchAll(pattern)) {
            this.fileFacts.push(match[1]);
          }
        }

        if (content.includes("Plan:") && content.includes("[")) {
          const planLine = content
            .split("\n")
            .find((line) => line.includes("Plan:"));
          if (planLine) this.decisionFacts.push(planLine.trim());
        }
      }

      if (msg.role === "assistant") {
        if (content.includes("decided:") || content.includes("decision:")) {
          const line = content
            .split("\n")
            .find((l) => l.includes("decided:") || l.includes("decision:"));
          if (line) this.decisionFacts.push(line.trim().slice(0, 200));
        }
      }

      if (
        content.includes("Error:") ||
        content.includes("failed") ||
        content.includes("Ошибка:") ||
        content.includes("не удалось")
      ) {
        const line = content
          .split("\n")
          .find(
            (l) =>
              l.includes("Error:") ||
              l.includes("failed") ||
              l.includes("Ошибка:") ||
              l.includes("не удалось"),
          );
        if (line) this.errorFacts.push(line.trim().slice(0, 250));
      }
    }
  }

  getActiveHistory(): Message[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
    this.compactedBlock = null;
    this.iterationsSinceCompaction = 0;
  }

  getEstimatedTokens(): number {
    return this.messages.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 2),
      0,
    );
  }
}
