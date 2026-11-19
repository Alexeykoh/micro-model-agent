/**
 * Context snapshot + conversation-history text rendering for the side panel.
 *
 * The rendered text uses only the duck-typed `getActiveHistory()` (optional),
 * so contexts without it degrade gracefully to an empty panel.
 */
import { state, broadcast } from "./state";
import { scrub } from "./util";
import type { ContextBudgetLike, ContextSnapshot, SessionMetaLike } from "./state";

/** Duck-typed against src/modules/context/manager.ts ContextManager. */
export interface ContextManagerLike {
  getBudget(): ContextBudgetLike;
  getEstimatedTokens(): number;
  getQuality(): number;
  getCompactionCount(): number;
  getIterationsSinceCompaction(): number;
  getMessageCount(): number;
  /** Full message history — renders the current context as text. */
  getActiveHistory?(): ContextMessageLike[];
}

/** Duck-typed against src/modules/context/manager.ts Message. */
export interface ContextMessageLike {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  name?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/** Duck-typed against OutputEvent in src/output/types.ts. */
export interface OutputEventLike {
  kind?: string;
  level?: string;
  source?: string;
  text?: string;
}

/** Duck-typed against HostBridge in src/modules/types.ts. */
export interface HostBridgeLike {
  subscribeOutput?(fn: (ev: OutputEventLike) => void): () => void;
}

export interface PluginContext {
  iteration?: number;
  lastUserMessage?: string;
  logger?: {
    info(...a: unknown[]): void;
    warn(...a: unknown[]): void;
    debug(...a: unknown[]): void;
  };
  sessionManager?: SessionMetaLike;
  contextManager?: ContextManagerLike;
  hostBridge?: HostBridgeLike;
}

export function snapshotContext(ctx: PluginContext): ContextSnapshot | null {
  const cm = ctx.contextManager;
  if (!cm) return null;
  try {
    return {
      tokens: cm.getEstimatedTokens(),
      budget: cm.getBudget(),
      quality: cm.getQuality(),
      compactionCount: cm.getCompactionCount(),
      iterationsSinceCompaction: cm.getIterationsSinceCompaction(),
      messageCount: cm.getMessageCount(),
    };
  } catch {
    return null;
  }
}

/** Emit a context snapshot + a compaction event when the count increased. */
export function emitContext(ctx: PluginContext): void {
  const snap = snapshotContext(ctx);
  if (!snap) return;
  if (snap.compactionCount > state.lastCompactionCount && state.lastContext) {
    const before = state.lastContext;
    broadcast({
      type: "compaction",
      ts: Date.now(),
      iteration: ctx.iteration,
      compactionCount: snap.compactionCount,
      tokensBefore: before.tokens,
      tokensAfter: snap.tokens,
      qualityBefore: before.quality,
      qualityAfter: snap.quality,
      budgetHistory: snap.budget.history,
    });
  }
  state.lastCompactionCount = snap.compactionCount;
  // Dedupe: both global + project plugin instances call emitContext on the
  // same tick with an identical snapshot — skip the second broadcast.
  if (
    state.lastContext &&
    state.lastContext.tokens === snap.tokens &&
    state.lastContext.quality === snap.quality &&
    state.lastContext.compactionCount === snap.compactionCount &&
    state.lastContext.messageCount === snap.messageCount
  ) {
    state.lastContext = snap;
    return;
  }
  state.lastContext = snap;
  broadcast({
    type: "context",
    ts: Date.now(),
    iteration: ctx.iteration,
    tokens: snap.tokens,
    budget: snap.budget,
    quality: snap.quality,
    compactionCount: snap.compactionCount,
    iterationsSinceCompaction: snap.iterationsSinceCompaction,
    messageCount: snap.messageCount,
  });
}

/** Render the live conversation history as plain text for the side panel. */
export function renderContextText(ctx: PluginContext): string {
  const cm = ctx.contextManager as
    (ContextManagerLike & { getActiveHistory?: () => ContextMessageLike[] }) | undefined;
  if (!cm || typeof cm.getActiveHistory !== "function") return "";
  try {
    const history = cm.getActiveHistory();
    if (!Array.isArray(history) || history.length === 0) return "";
    const parts: string[] = [];
    for (const m of history) {
      const role = m.role || "?";
      const name = m.name ? ` (${m.name})` : "";
      const content = Array.isArray(m.content)
        ? m.content
            .map((p) => (p && typeof p === "object" && "text" in p ? String(p.text ?? "") : ""))
            .join("\n")
        : typeof m.content === "string"
          ? m.content
          : "";
      const calls = (m.tool_calls || [])
        .map((tc) => {
          const fn = tc.function;
          const argText = fn?.arguments ? fn.arguments.slice(0, 200) : "";
          return `→ ${fn?.name ?? "?"}(${argText})`;
        })
        .join("\n");
      const body = [content, calls].filter((s) => s).join("\n");
      parts.push(`<${role}${name}>\n${body}`);
    }
    return scrub(parts.join("\n\n"));
  } catch {
    return "";
  }
}

/** Emit the full context as text, throttled + deduped. */
export function emitContextText(ctx: PluginContext): void {
  const text = renderContextText(ctx);
  if (!text || text === state.lastTextBody) return;
  const now = Date.now();
  if (now - state.lastTextTs < 1000) return;
  state.lastTextTs = now;
  state.lastTextBody = text;
  state.contextText = text;
  broadcast({
    type: "context_text",
    ts: now,
    iteration: ctx.iteration,
    tokens: state.lastContext?.tokens ?? 0,
    quality: state.lastContext?.quality ?? 0,
    messageCount: state.lastContext?.messageCount ?? 0,
    text,
  });
}
