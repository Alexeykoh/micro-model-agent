import type { ContentPart, TextPart } from "../../llm/provider";
import { getMessageText } from "../../llm/provider";
import { FactExtractor } from "./fact-extractor";

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

export interface CompactResult {
  /** Turns removed by the compaction (oldTurns). */
  removedTurns: number;
  /** Turns kept verbatim (recent, minus stale <system-summary>). */
  keptTurns: number;
  tokensBefore: number;
  tokensAfter: number;
  qualityBefore: number;
  qualityAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  /** The inner [Compressed: ...] block (without the <system-summary> wrapper). */
  summary: string;
}

export interface ContextSnapshot {
  window: number;
  budget: ContextBudget;
  /** Estimated tokens currently in history (messages + tool defs). */
  tokens: number;
  toolTokens: number;
  messageCount: number;
  quality: number;
  compactionCount: number;
  iterationsSinceCompaction: number;
}

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

function looksLikeErrorPaste(text: string): boolean {
  // Error markers.
  if (/(?:^|\s)ERROR|Error:|error TS\d+|Transform failed|\[plugin:|SyntaxError|Cannot find|Uncaught|exception/i.test(text)) {
    return true;
  }
  // Structural signals of pasted compiler/runtime output: source frames
  // ("270|  }_s(...)"), path:line:col references, and stack-trace lines.
  if (/(?:^|\n)\s*\d+\s*\|/.test(text)) return true;
  if (/[\w./\\-]+\.[a-z]{1,6}:\d+:\d+/.test(text)) return true;
  if (/(?:^|\n)\s*at\s+\S+/.test(text)) return true;
  return false;
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
  private facts = new FactExtractor();
  /** Latest real user instruction (skips <system-summary> blocks). */
  private lastUserTask = "";
  /** First real user instruction of the session — survives resetUserTurn(). */
  private sessionMission = "";
  /** Latest user message that looks like a pasted error/log (never a task). */
  private lastUserFeedback = "";
  private tokenCounter: TokenCounter | null;
  private pendingImageParts: ContentPart[] = [];
  private toolTokens = 0;
  onCompact: ((summary: Message) => void) | null = null;
  /**
   * Optional short line appended to the compaction summary so the model knows
   * an active plan exists with progress. Wired from bootstrap to the execution
   * module — without it, a 9B model re-creates a plan from scratch right after
   * compaction (observed: ses_msvuao0h — plan_e07pb2 (1/6) was discarded for a
   * fresh plan_xzq9xe the same iteration the old plan was still visible).
   */
  private planSummaryProvider: (() => string | null) | null = null;

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

  /**
   * Provide a short "current plan" line for the compaction summary, or null
   * when no plan is active. Injected once at bootstrap (not per-turn state).
   */
  setPlanSummaryProvider(fn: (() => string | null) | null): void {
    this.planSummaryProvider = fn;
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

  /**
   * Start a fresh user turn. The 15-iteration compaction interval must not
   * leak across user messages — otherwise a turn that ends at iteration 14
   * forces a compaction on the very first iteration of the next user message
   * (observed: compaction fired on iteration 8 of a new turn, deleting the
   * user's freshly-sent task alongside 40+ old turns). Facts are kept.
   */
  resetUserTurn(): void {
    this.iterationsSinceCompaction = 0;
    // A new user message begins a new turn — drop the previous turn's task
    // so the fresh instruction becomes the one preserved at compaction. The
    // session mission survives: an error/log paste in the new turn must not
    // erase the original goal.
    this.lastUserTask = "";
    this.lastUserFeedback = "";
  }

  getQuality(): number {
    const usedTokens = this.getEstimatedTokens();
    const tokenLoad = Math.max(0, 1 - usedTokens / this.budget.history);

    // Recoverable penalty: each compaction loses some information, but the
    // penalty is CAPPED so cumulative compactions can never permanently pin
    // quality below the forced-compaction trigger (40%). Before this cap, a
    // session with ~7+ compactions clamped the term to 0 forever; combined
    // with heavy token load + error density, quality stuck below 40 and a
    // compaction fired on EVERY iteration (observed: 56 compactions in 28 min).
    const COMPACTION_PENALTY_FLOOR = 0.5;
    const compactionLoss = Math.max(
      COMPACTION_PENALTY_FLOOR,
      1 - this.compactionCount * 0.15,
    );

    const msgCount = this.messages.length || 1;
    const errorDensity = Math.max(
      0,
      1 - Math.min(1, this.facts.errorCount / msgCount),
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
    // Track the task the agent is working on so it survives compaction. The
    // user's real instruction is the FIRST non-system-summary user message of
    // the turn; everything after it (tool results, retry nudges) are injected
    // `user` envelopes that must not overwrite it (observed: after compaction
    // the model had forgotten "удали /bicycles, почини стили" and re-read
    // files aimlessly for 40+ iterations).
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string" ? msg.content : getMessageText(msg.content);
      if (
        text.trim() &&
        !text.startsWith("<system-summary>") &&
        !text.includes("[Compressed:")
      ) {
        if (looksLikeErrorPaste(text) && (this.lastUserTask || this.sessionMission)) {
          this.lastUserFeedback = text.trim().slice(0, 400);
        } else if (!this.lastUserTask && !this.lastUserFeedback) {
          // No new task inside a turn that already captured an error/log paste:
          // the paste's follow-up messages are tool-result continuations, not a
          // fresh instruction, so the session mission must win at compaction.
          this.lastUserTask = text.trim();
          if (!this.sessionMission) this.sessionMission = text.trim();
        }
      }
    }
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

  compact(): CompactResult | null {
    // Capture the pre-compaction state BEFORE any counters reset or rise —
    // qualityBefore must reflect the context the model actually saw.
    const tokensBefore = this.getEstimatedTokens();
    const qualityBefore = this.getQuality();
    const messagesBefore = this.messages.length;

    // Reset the counter even when nothing to compact — otherwise
    // needsCompaction() returns true forever after 15 iterations with few messages.
    this.iterationsSinceCompaction = 0;
    if (this.messages.length <= KEEP_LAST_N * 2) return null;

    this.compactionCount++;

    const cutoff = this.messages.length - KEEP_LAST_N * 2;
    const oldTurns = this.messages.slice(0, cutoff);
    const recentTurns = this.messages.slice(cutoff);

    this.facts.extract(oldTurns);

    const parts: string[] = [];
    parts.push(`[Compressed: ${oldTurns.length} old turns removed]`);

    // Carry the user's actual instruction forward — the model must never lose
    // the task it is working on just because 40 turns got compacted away. The
    // per-turn task falls back to the session mission (first real instruction)
    // so a pasted error/log in the current turn cannot erase the goal.
    const task = (this.lastUserTask || this.sessionMission).slice(0, 400);
    if (task) parts.push(`[Task: ${task}]`);
    if (this.lastUserFeedback && !task.startsWith(this.lastUserFeedback)) {
      parts.push(`[User feedback: ${this.lastUserFeedback}]`);
    }

    // Orient the model after compaction: an active plan must not be re-created
    // from scratch (see planSummaryProvider doc).
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
   * Snapshot of the current context state — used to log the initial context
   * structure at session start and per-iteration context stats.
   */
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
    };
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

  /**
   * Reset everything that belongs to the current conversation turn.
   * Fact lists (FactExtractor) intentionally survive clear() — they are
   * session-scoped compaction state, not per-turn.
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

  getEstimatedTokens(): number {
    return (
      this.messages.reduce((sum, m) => sum + this.estimateMessageTokens(m), 0) +
      this.toolTokens
    );
  }

  setToolTokens(tokens: number): void {
    this.toolTokens = tokens;
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
