// src/core/prompt-overflow.ts
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { PromptBuilder } from "./prompt-builder";
import type { PromptBlock, PromptBlockKind } from "./types";
import type { LLMProvider } from "../llm/provider";
import type { Logger } from "../logger/app-logger";
import type { AppConfig } from "../config/types";
import { estimateTokens } from "../llm/token-counter";
import { t } from "../i18n/index";

/** How many tokens the model-facing hint block costs (upper bound for allocation). */
export const HINT_BLOCK_TOKENS = 60;

export interface OverflowWarning {
  kind: PromptBlockKind;
  label: string;
  originalTokens: number;
  resolvedTokens: number;
  mode: "summary" | "truncate";
}

export interface OverflowResolution {
  /** Replacement blocks (kind preserved) for the excluded originals. */
  replacements: PromptBlock[];
  /** Small block telling the model the instructions were compressed and how
   *  to read the full file. Null when nothing was resolved. */
  hintBlock: PromptBlock | null;
  warnings: OverflowWarning[];
}

export interface OverflowDryRun {
  includedTokens: number;
  /** Excluded blocks that carry a kind (instructions / project-map). */
  overflow: PromptBlock[];
}

/** Rough chars-per-token factor used for hard truncation fallback. */
const CHARS_PER_TOKEN = 4;

const KIND_ORDER: PromptBlockKind[] = ["instructions", "project-map"];

const KIND_LABEL: Record<PromptBlockKind, string> = {
  instructions: "project instructions (AGENTS.md)",
  "project-map": "project map",
};

const KIND_SOURCE_FILE: Record<PromptBlockKind, string> = {
  instructions: "AGENTS.md",
  "project-map": "",
};

/**
 * Static dry-run of the system-prompt budget: which kind-carrying blocks do
 * not fit. Used by bootstrap for the startup banner and by Agent before the
 * first LLM call (the real resolution).
 */
export function dryRunOverflow(allBlocks: PromptBlock[], systemBudget: number): OverflowDryRun {
  const builder = new PromptBuilder(systemBudget);
  builder.addBlocks(allBlocks);
  const result = builder.build();
  const includedTokens = result.blocks
    .filter((b) => b.included)
    .reduce((sum, b) => sum + b.tokens, 0);
  const overflow = result.excludedBlocks.filter((b): b is PromptBlock & { kind: PromptBlockKind } =>
    Boolean(b.kind),
  );
  return { includedTokens, overflow };
}

function cacheKey(kind: PromptBlockKind, content: string, maxTokens: number): string {
  return createHash("sha256").update(`${kind}|${maxTokens}|${content}`).digest("hex").slice(0, 24);
}

function readCache(cacheDir: string, key: string): { mode: OverflowWarning["mode"]; text: string } | null {
  try {
    const path = join(cacheDir, `${key}.md`);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { mode: OverflowWarning["mode"]; text: string };
      if ((parsed.mode === "summary" || parsed.mode === "truncate") && typeof parsed.text === "string" && parsed.text) {
        return parsed;
      }
    } catch {
      // Legacy plain-text entry — treat as a summary hit
      return { mode: "summary", text: raw };
    }
    return null;
  } catch {
    // Corrupted cache — fall through to re-summarize
  }
  return null;
}

function writeCache(cacheDir: string, key: string, entry: { mode: OverflowWarning["mode"]; text: string }): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${key}.md`), JSON.stringify(entry), "utf-8");
  } catch {
    // Best-effort — cache failure must not crash the agent
  }
}

/** Collect a full text response from the streaming provider API. */
async function collectText(
  provider: LLMProvider,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  let text = "";
  // Reasoning must be off: a thinking model would burn the completion cap on
  // <think> before emitting any summary content (observed on qwen3.5-9b).
  // 2x headroom over the target: token estimates are heuristics, and the
  // clamp below enforces the real cap no matter what the model returns.
  for await (const chunk of provider.chat([{ role: "user", content: prompt }], undefined, undefined, {
    maxTokens: maxTokens * 2,
    reasoningEffort: "none",
  })) {
    if (chunk.type === "text" && chunk.content) text += chunk.content;
  }
  return text.trim();
}

function truncateToTokens(content: string, maxTokens: number): string {
  const maxChars = Math.max(200, maxTokens * CHARS_PER_TOKEN);
  if (content.length <= maxChars) return content;
  let cut = content.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n");
  if (lastBreak > maxChars * 0.5) cut = cut.slice(0, lastBreak);
  return `${cut.trimEnd()}\n\n[...truncated — read the full file for details...]`;
}

/** One-line first-line label for warnings/logs. */
function blockLabel(content: string): string {
  const first = content.split("\n")[0].trim();
  return first.length > 60 ? `${first.slice(0, 57)}...` : first;
}

/**
 * Summarize (or, failing that, truncate) prompt blocks that exceeded the
 * system-prompt budget so the project instructions / project map still reach
 * the model. Summaries are cached on disk keyed by kind + content + budget.
 * Blocks are resolved in KIND_ORDER priority; the first gets the full
 * remaining budget, later blocks get whatever is left.
 */
export async function resolvePromptOverflow(opts: {
  overflow: PromptBlock[];
  includedTokens: number;
  systemBudget: number;
  provider: LLMProvider | null;
  cacheDir: string;
  logger?: Logger;
}): Promise<OverflowResolution> {
  const { overflow, includedTokens, systemBudget, provider, cacheDir, logger } = opts;

  const sorted = [...overflow].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind as PromptBlockKind) - KIND_ORDER.indexOf(b.kind as PromptBlockKind),
  );

  const replacements: PromptBlock[] = [];
  const warnings: OverflowWarning[] = [];
  let used = includedTokens;
  let unresolved: PromptBlockKind[] = [];

  // The bootstrap dry-run only warns that blocks "will be summarized before the
  // first run". Without a notice here the first prompt appears to hang while
  // the model rewrites AGENTS.md / the project map — surface it.
  if (sorted.length > 0) {
    logger?.warn(t("prompt.overflow.compressing", { count: String(sorted.length) }));
  }

  for (const block of sorted) {
    const kind = block.kind as PromptBlockKind;
    const maxTokens = systemBudget - used - HINT_BLOCK_TOKENS;
    if (maxTokens < 100) {
      unresolved.push(kind);
      continue;
    }

    let mode: OverflowWarning["mode"] = "summary";
    let text = "";

    const key = cacheKey(kind, block.content, maxTokens);
    const cached = readCache(cacheDir, key);
    if (cached) {
      text = cached.text;
      mode = cached.mode;
      logger?.debug(`Prompt overflow: cache hit for ${kind} (${key}, ${mode})`);
    } else if (provider) {
      const targetChars = Math.floor(maxTokens * (CHARS_PER_TOKEN - 1));
      logger?.warn(
        t("prompt.overflow.summarizing", {
          label: blockLabel(block.content),
          original: String(block.estimatedTokens),
          budget: String(maxTokens),
        }),
      );
      try {
        const prompt = [
          `Summarize the following ${KIND_LABEL[kind]} document.`,
          // 3 chars/token (not 4): non-Latin text (Cyrillic etc.) is ~2-3 chars
          // per token, so a 4x target lands the summary over the clamp.
          `Target length: at most ${targetChars} characters (~${maxTokens} tokens). Be strict about it.`,
          `Preserve concrete facts: file paths, commands, rules, naming conventions, workflow steps.`,
          `Keep the structure (headings / bullet lists). Output ONLY the summary text.`,
          ``,
          `--- DOCUMENT START ---`,
          block.content,
          `--- DOCUMENT END ---`,
        ].join("\n");
        text = await collectText(provider, prompt, maxTokens);
        // Small models routinely ignore length instructions (observed: the 9B
        // model produced ~4700 chars against a 3170-char target). One
        // self-compression retry on the overshoot — the shorter input makes
        // compliance much likelier — before falling back to the hard clamp.
        let retries = 0;
        while (text && estimateTokens(text) > maxTokens && retries < 1) {
          retries++;
          logger?.debug(`Prompt overflow: ${kind} summary overshot (${estimateTokens(text)} > ${maxTokens} tok), compressing (retry ${retries})`);
          text = await collectText(
            provider,
            [
              `Compress the following text to at most ${targetChars} characters.`,
              `Keep the structure (headings / bullet lists) and all concrete facts: file paths, commands, rules.`,
              `Output ONLY the compressed text.`,
              ``,
              `--- TEXT START ---`,
              text,
              `--- TEXT END ---`,
            ].join("\n"),
            maxTokens,
          );
        }
      } catch (err: any) {
        logger?.warn(
          t("prompt.overflow.summarize_failed", {
            label: blockLabel(block.content),
            error: String(err?.message ?? err),
          }),
        );
        text = "";
      }
    }

    if (!text) {
      // No provider or summarization failed — hard truncation fallback.
      mode = "truncate";
      logger?.warn(
        t("prompt.overflow.truncating", {
          label: blockLabel(block.content),
          original: String(block.estimatedTokens),
        }),
      );
      text = truncateToTokens(block.content, maxTokens);
    }

    // LLMs overshoot: enforce the cap no matter what produced the text.
    if (estimateTokens(text) > maxTokens) {
      if (mode === "summary") {
        mode = "truncate";
      }
      text = truncateToTokens(text, maxTokens);
    }
    const resolvedTokens = estimateTokens(text);
    used += resolvedTokens;
    writeCache(cacheDir, key, { mode, text });
    replacements.push({
      content: text,
      priority: "high",
      essential: false,
      estimatedTokens: resolvedTokens,
      kind,
    });
    warnings.push({
      kind,
      label: blockLabel(block.content),
      originalTokens: block.estimatedTokens,
      resolvedTokens,
      mode,
    });
  }

  const hintBlock: PromptBlock | null =
    replacements.length > 0
      ? {
          content: [
            `[Instructions note] Some project blocks exceeded the system-prompt budget and were compressed:`,
            ...warnings.map(
              (w) =>
                `- ${KIND_LABEL[w.kind]}: ${w.originalTokens} tokens → ${w.resolvedTokens} tokens (${w.mode})`,
            ),
            ...(unresolved.length > 0
              ? unresolved.map((k) => `- ${KIND_LABEL[k]}: did not fit at all — read it yourself if needed`)
              : []),
            ...warnings
              .filter((w) => KIND_SOURCE_FILE[w.kind])
              .map((w) => `Read the full ${KIND_SOURCE_FILE[w.kind]} with read_file if details are missing.`),
          ].join("\n"),
          priority: "high",
          essential: true,
          estimatedTokens: HINT_BLOCK_TOKENS,
        }
      : null;

  return { replacements, hintBlock, warnings };
}

/** Where the active context window is configured: global or provider entry. */
export interface ContextWindowSource {
  source: "global" | "entry";
  /** For "entry": the label of the entry that sets contextWindow. */
  label?: string;
  value: number;
}

export function resolveContextWindowSource(config: AppConfig): ContextWindowSource {
  const entries = config.provider.entries ?? [];
  const activeLabel = config.provider.active;
  const activeEntry =
    entries.find((e) => e.label && e.label === activeLabel) ??
    (entries.length === 1 ? entries[0] : undefined);
  if (activeEntry?.contextWindow) {
    return { source: "entry", label: activeEntry.label, value: activeEntry.contextWindow };
  }
  return { source: "global", value: config.contextWindow };
}

/**
 * Human-facing hint on how to raise the context window, aware of whether the
 * active value comes from the global config (`mma context <N>`) or from a
 * provider entry override (must be edited in the provider domain file).
 */
export function contextWindowHint(config: AppConfig, configDir: string, recommended: number): string {
  const src = resolveContextWindowSource(config);
  if (src.source === "global") {
    return `run "mma context ${recommended}"`;
  }
  return `edit "${join(configDir, "config", "provider.json")}" → provider.entries[label="${src.label}"].contextWindow = ${recommended}`;
}

/**
 * Recommend the next standard context size whose system budget (10%)
 * accommodates `neededSystemTokens`. Falls back to the largest known size.
 */
export function recommendContextSize(neededSystemTokens: number): number {
  const sizes = [8192, 16384, 32768, 65536, 131072, 262144];
  return (
    sizes.find((s) => Math.floor(s * 0.1) >= neededSystemTokens) ?? sizes[sizes.length - 1]
  );
}
