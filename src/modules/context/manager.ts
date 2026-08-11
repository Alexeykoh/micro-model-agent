import type { ContentPart, TextPart } from "../../llm/provider";
import { getMessageText } from "../../llm/provider";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  success?: boolean;
  arguments?: Record<string, unknown>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

import type { ContextBudget as ConfigContextBudget } from "../../config/types";
import { TokenCounter } from "../../llm/token-counter";

export interface ContextBudget {
  systemPrompt: number;
  responseReserve: number;
  history: number;
}

const COMPACTION_INTERVAL = 15;
const KEEP_LAST_N = 6;

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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

export function extractTriedAndFailed(messages: Message[]): TriedAndFailed[] {
  const failures: Map<string, TriedAndFailed> = new Map();

  for (const msg of messages) {
    if (msg.role === "tool" && msg.name && msg.success === false) {
      const key = `${msg.name}:${summarizeArgs(msg.arguments)}`;
      const existing = failures.get(key);
      const errorText = truncate(
        typeof msg.content === "string"
          ? msg.content
          : getMessageText(msg.content),
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

export class ContextManager {
  private contextWindow: number;
  private messages: Message[] = [];
  private compactedBlock: string | null = null;
  private iterationsSinceCompaction = 0;
  private compactionCount = 0;
  private peakTokens = 0;
  private budget: ContextBudget;
  private compactionThreshold: number;
  private fileFacts: string[] = [];
  private decisionFacts: string[] = [];
  private errorFacts: string[] = [];
  private static readonly MAX_FACTS = 20;
  private tokenCounter: TokenCounter | null;
  private pendingImageParts: ContentPart[] = [];
  onCompact: ((summary: Message) => void) | null = null;

  constructor(
    contextWindow: number,
    contextBudget?: ConfigContextBudget,
    tokenCounter?: TokenCounter | null,
  ) {
    this.contextWindow = contextWindow;
    this.compactionThreshold = contextBudget?.compactionThreshold ?? 0.75;
    this.budget = this.calculateBudget(contextWindow, contextBudget);
    this.tokenCounter = tokenCounter ?? null;
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

  getCompactionCount(): number {
    return this.compactionCount;
  }

  getIterationsSinceCompaction(): number {
    return this.iterationsSinceCompaction;
  }

  noteIteration(): void {
    this.iterationsSinceCompaction++;
  }

  getQuality(): number {
    const usedTokens = this.getEstimatedTokens();
    const tokenLoad = Math.max(0, 1 - usedTokens / this.budget.history);

    const compactionLoss = Math.max(0, 1 - this.compactionCount * 0.15);

    const msgCount = this.messages.length || 1;
    const errorDensity = Math.max(
      0,
      1 - Math.min(1, this.errorFacts.length / msgCount),
    );

    const freshness = Math.max(
      0,
      1 - this.iterationsSinceCompaction / COMPACTION_INTERVAL,
    );

    const score =
      tokenLoad * 0.4 +
      compactionLoss * 0.25 +
      errorDensity * 0.2 +
      freshness * 0.15;
    return Math.round(Math.min(100, Math.max(0, score * 100)));
  }

  addMessage(msg: Message): void {
    // Auto-attach pending images to the next user message
    if (msg.role === "user" && this.pendingImageParts.length > 0) {
      const textPart: TextPart = {
        type: "text",
        text:
          typeof msg.content === "string"
            ? msg.content
            : getMessageText(msg.content),
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
   * Queue an image part to be attached to the next user message.
   */
  addPendingImage(part: ContentPart): void {
    this.pendingImageParts.push(part);
  }

  /**
   * Check if there are pending images waiting to be attached.
   */
  hasPendingImages(): boolean {
    return this.pendingImageParts.length > 0;
  }

  /**
   * Get pending image parts without clearing them.
   */
  getPendingImages(): ContentPart[] {
    return [...this.pendingImageParts];
  }

  /**
   * Clear pending images (e.g., if user sends a text-only message).
   */
  clearPendingImages(): void {
    this.pendingImageParts = [];
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  private estimateMessageTokens(m: Message): number {
    const text = getMessageText(m.content);
    if (this.tokenCounter) {
      let t = this.tokenCounter.count(text);
      // Image tokens: base64 ~130 tokens per 512x512 tile; rough estimate
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === "image_url" && part.image_url?.url) {
            const b64Len = part.image_url.url.includes(",")
              ? (part.image_url.url.split(",")[1]?.length ?? 0)
              : part.image_url.url.length;
            // ~130 tokens per 512 bytes of base64
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

  needsCompaction(): boolean {
    if (this.iterationsSinceCompaction >= COMPACTION_INTERVAL) return true;
    const totalTokens = this.messages.reduce(
      (sum, m) => sum + this.estimateMessageTokens(m),
      0,
    );
    return totalTokens > this.budget.history * this.compactionThreshold;
  }

  compact(): void {
    // Reset the counter even when nothing to compact — otherwise
    // needsCompaction() returns true forever after 15 iterations with few messages.
    this.iterationsSinceCompaction = 0;
    if (this.messages.length <= KEEP_LAST_N * 2) return;
    this.compactionCount++;

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

    const triedAndFailed = extractTriedAndFailed(oldTurns);
    if (triedAndFailed.length > 0) {
      const lines = triedAndFailed.map(
        (t) => `- ${t.tool}(${t.args}): ${t.error} (failed ${t.count}x)`,
      );
      parts.push(
        `[Already tried & failed — do NOT repeat:]\n${lines.join("\n")}`,
      );
    }

    this.compactedBlock = parts.join(" ");
    const summary: Message = {
      role: "user",
      content: `<system-summary>${this.compactedBlock}</system-summary>`,
    };

    const firstSystem = this.messages.find((m) => m.role === "system");
    // Filter out stale system-summary messages from recent turns to prevent nesting
    const freshRecent = recentTurns.filter((m) => {
      if (m.role !== "user") return true;
      const text = getMessageText(m.content);
      return !text.startsWith("<system-summary>");
    });
    this.messages = [
      ...(firstSystem ? [firstSystem] : []),
      summary,
      ...freshRecent,
    ];
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

    const newFiles: string[] = [];
    const newDecisions: string[] = [];
    const newErrors: string[] = [];

    for (const msg of turns) {
      const content = getMessageText(msg.content);

      if (msg.role === "tool") {
        for (const pattern of filePatterns) {
          for (const match of content.matchAll(pattern)) {
            newFiles.push(match[1]);
          }
        }

        if (content.includes("Plan:") && content.includes("[")) {
          const planLine = content
            .split("\n")
            .find((line) => line.includes("Plan:"));
          if (planLine) newDecisions.push(planLine.trim());
        }
      }

      if (msg.role === "assistant") {
        if (content.includes("decided:") || content.includes("decision:")) {
          const line = content
            .split("\n")
            .find((l) => l.includes("decided:") || l.includes("decision:"));
          if (line) newDecisions.push(line.trim().slice(0, 200));
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
        if (line) newErrors.push(line.trim().slice(0, 250));
      }
    }

    // Deduplicate and cap facts to prevent unbounded growth
    const dedup = (arr: string[]): string[] => [...new Set(arr)];
    this.fileFacts = dedup([...this.fileFacts, ...newFiles]).slice(
      -ContextManager.MAX_FACTS,
    );
    this.decisionFacts = dedup([...this.decisionFacts, ...newDecisions]).slice(
      -ContextManager.MAX_FACTS,
    );
    this.errorFacts = dedup([...this.errorFacts, ...newErrors]).slice(
      -ContextManager.MAX_FACTS,
    );
  }

  /**
   * Replace the system prompt in place (keeps it first) or prepend a new one.
   * Used to refresh dynamic prompt blocks (e.g. the plan checklist) mid-run.
   */
  updateSystemPrompt(content: string): void {
    const idx = this.messages.findIndex((m) => m.role === "system");
    if (idx >= 0) {
      this.messages[idx] = { ...this.messages[idx], content };
    } else {
      this.messages.unshift({ role: "system", content });
    }
  }

  getActiveHistory(): Message[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
    this.compactedBlock = null;
    this.iterationsSinceCompaction = 0;
    this.compactionCount = 0;
    this.peakTokens = 0;
  }

  getEstimatedTokens(): number {
    return this.messages.reduce(
      (sum, m) => sum + this.estimateMessageTokens(m),
      0,
    );
  }

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
