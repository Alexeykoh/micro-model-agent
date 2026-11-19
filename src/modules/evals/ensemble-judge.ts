/**
 * Ensemble-судья (Evals 2/2): несколько LLM-судей голосуют, вердикт —
 * большинством; сомнения — degraded. Fail-open: все упали → degraded.
 */
import type { LLMProvider } from "../../llm/provider";

export type EnsembleVerdict = "pass" | "fail" | "degraded";

export interface EnsembleResult {
  verdict: EnsembleVerdict;
  votes: Array<boolean | null>;
  agreement: number;
  reasons: string[];
}

const MAX_CHARS = 2000;

function parseVote(text: string): boolean | null {
  const block = text.match(/\{[\s\S]*\}/);
  if (block) {
    try {
      const obj = JSON.parse(block[0]) as { contradicts?: unknown };
      if (typeof obj.contradicts === "boolean") return obj.contradicts;
    } catch {
      /* терпимый разбор ниже */
    }
  }
  const lower = text.toLowerCase();
  if (lower.includes('"contradicts": true') || /^yes\b/.test(lower.trim())) return true;
  if (lower.includes('"contradicts": false') || /^no\b/.test(lower.trim())) return false;
  return null;
}

/** Посылает вопрос каждому судье параллельно, вердикт — большинством. */
export class EnsembleJudge {
  constructor(private readonly voters: LLMProvider[]) {}

  async judge(response: string, decisions: Array<{ location?: string; decision: string }>): Promise<EnsembleResult> {
    const system = `You are a consistency checker. These decisions were made earlier:\n\n${decisions
      .map((d) => `- [${d.location ?? "agent"}] "${d.decision}"`)
      .join("\n")}\n\nDoes the agent's new response contradict any of them?\nReply ONLY {"contradicts": true|false}.`;
    const user = `New response:\n\n${response.slice(0, MAX_CHARS)}`;

    const votes: Array<boolean | null> = await Promise.all(
      this.voters.map(async (provider) => {
        try {
          let text = "";
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15_000);
          try {
            for await (const chunk of provider.chat(
              [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              [],
              controller.signal,
            )) {
              if (chunk.type === "text" && chunk.content) text += chunk.content;
            }
          } finally {
            clearTimeout(timer);
            controller.abort();
          }
          return parseVote(text);
        } catch {
          return null;
        }
      }),
    );

    const valid = votes.filter((v): v is boolean => v !== null);
    if (valid.length === 0) {
      return { verdict: "degraded", votes, agreement: 0, reasons: ["all judges unavailable"] };
    }
    const yes = valid.filter((v) => v).length;
    const no = valid.length - yes;
    const agreement = Math.max(yes, no) / valid.length;
    const contradicts = yes > no;
    return {
      verdict: contradicts ? "fail" : "pass",
      votes,
      agreement,
      reasons: contradicts ? [`majority (${yes}/${valid.length}) judges say contradiction`] : [],
    };
  }
}
