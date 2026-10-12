// LLM-судья консистентности: противоречит ли новый ответ ранним решениям.
import { t } from "../../i18n/index";
import type { Message } from "../../llm/provider";
import type { LLMProvider } from "../../llm/provider";
import type { HallucinationCheckResult } from "./detector";
import type { ConsistencyCheck } from "./consistency";
import { HALLUCINATION_JUDGE_TIMEOUT_MS as JUDGE_TIMEOUT_MS } from "../../config/timeouts";

const MAX_DECISIONS_SHOWN = 6;
const MAX_RESPONSE_CHARS = 2000;

interface Verdict {
  contradicts: boolean;
  reason?: string;
}

/**
 * Консистентность через LLM-судью. Спрашивает модель, противоречит ли свежий
 * ответ агента его ранним решениям — вместо хрупкой эвристики совпадения слов,
 * ловившей только дословные развороты.
 *
 * Быстрый путь: нет отслеживаемых решений — pass без LLM-вызова.
 * Любой сбой судьи (таймаут, ошибка провайдера, непарсящийся вердикт) —
 * деградация в pass, чтобы цикл агента не блокировался судьёй.
 */
/** LLM-судья: проверяет новый ответ на противоречие ранним решениям. */
export class LLMJudge {
  private provider: LLMProvider;
  private sessionId?: string;

  constructor(provider: LLMProvider, sessionId?: string) {
    this.provider = provider;
    this.sessionId = sessionId;
  }

  /** Валидирует ответ против решений: warn при противоречии, иначе pass (сбои — тоже pass). */
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

  /** Один запрос к судье со сбором текстовых чанков. */
  private async askJudge(messages: Message[]): Promise<string> {
    let text = "";
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const consume = (async () => {
      for await (const chunk of this.provider.chat(messages, [], controller.signal, {
        sessionId: this.sessionId,
      })) {
        if (chunk.type === "text" && chunk.content) {
          text += chunk.content;
        }
      }
      return text;
    })();
    // Таймаут может завершить гонку, пока фоновый стрим ещё идёт;
    // его позднее rejection не должно всплыть как unhandled rejection.
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
      // Абортим фоновый стрим и на успешном пути, чтобы рано завершившийся
      // судья не продолжал стримить в фоне.
      controller.abort();
    }
  }

  /** Парсит вердикт: строгий JSON → терпимый разбор, иначе "не противоречит". */
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
        // Не парсится строго — ниже терпимый разбор
      }
    }
    const lower = text.toLowerCase();
    if (lower.includes('"contradicts": true') || /^yes\b/.test(lower.trim())) {
      return { contradicts: true, reason: text.slice(0, 200) };
    }
    return { contradicts: false };
  }
}
