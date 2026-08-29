import { t } from "../../i18n/index";
import type { Message } from "../../llm/provider";
import type { LLMProvider } from "../../llm/provider";
import type { HallucinationCheckResult } from "./detector";
import type { ConsistencyCheck } from "./consistency";

const JUDGE_TIMEOUT_MS = 15000;
const MAX_DECISIONS_SHOWN = 6;
const MAX_RESPONSE_CHARS = 2000;

interface Verdict {
  contradicts: boolean;
  reason?: string;
}

/**
 * LLM-as-judge consistency check. Asks a model whether the agent's latest
 * response contradicts any of its earlier decisions — replacing the fragile
 * word-matching heuristic that only caught exact substring reversals.
 *
 * Fast path: when no decisions are tracked, returns pass without any LLM call.
 * Any judge failure (timeout, provider error, unparseable verdict) degrades to
 * pass so the agent loop is never blocked by the judge.
 */
export class LLMJudge {
  private provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async validate(
    response: string,
    consistency: ConsistencyCheck,
  ): Promise<HallucinationCheckResult> {
    const decisions = consistency.getDecisions();
    if (decisions.length === 0) {
      return { status: "pass" };
    }

    const shown = decisions.slice(-MAX_DECISIONS_SHOWN);
    const decisionLines = shown
      .map((d, i) => `${i + 1}. [${d.location || "agent"}] "${d.decision}"`)
      .join("\n");

    const system = `You are a consistency checker for an AI coding agent. The agent previously made these decisions:

${decisionLines}

Decide whether the agent's NEW response contradicts any of these decisions. A contradiction means reversing or abandoning a previously stated approach (e.g. switching to a different framework, changing a chosen strategy, or undoing a decision that was explicitly made).

Reply with ONLY valid JSON, no other text:
- {"contradicts": false}
- {"contradicts": true, "reason": "short explanation"}`;

    const user = `Agent's new response:\n\n${response.slice(0, MAX_RESPONSE_CHARS)}`;

    try {
      const verdictText = await this.askJudge([
        { role: "system", content: system },
        { role: "user", content: user },
      ]);
      const verdict = this.parseVerdict(verdictText);

      if (verdict.contradicts) {
        const reason = verdict.reason?.trim() ? ` — ${verdict.reason.trim()}` : "";
        return {
          status: "warn",
          reason: t("hall.contradiction_llm", { reason }),
        };
      }
      return { status: "pass" };
    } catch {
      return { status: "pass" };
    }
  }

  private async askJudge(messages: Message[]): Promise<string> {
    let text = "";
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const consume = (async () => {
      for await (const chunk of this.provider.chat(messages, [], controller.signal)) {
        if (chunk.type === "text" && chunk.content) {
          text += chunk.content;
        }
      }
      return text;
    })();
    // The timeout can settle the race while the background stream is still
    // running; its later rejection must not surface as an unhandled rejection.
    consume.catch(() => {});

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("LLM judge timed out"));
      }, JUDGE_TIMEOUT_MS);
    });

    try {
      return await Promise.race([consume, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      // Abort the background stream on the success path too, so a judge that
      // resolved early never keeps streaming in the background.
      controller.abort();
    }
  }

  private parseVerdict(text: string): Verdict {
    const block = text.match(/\{[\s\S]*\}/);
    if (block) {
      try {
        const obj = JSON.parse(block[0]);
        if (typeof obj.contradicts === "boolean") {
          return {
            contradicts: obj.contradicts,
            reason: typeof obj.reason === "string" ? obj.reason : undefined,
          };
        }
      } catch {
        // fall through to lenient parsing
      }
    }
    const lower = text.toLowerCase();
    if (lower.includes('"contradicts": true') || /^yes\b/.test(lower.trim())) {
      return { contradicts: true, reason: text.slice(0, 200) };
    }
    return { contradicts: false };
  }
}
