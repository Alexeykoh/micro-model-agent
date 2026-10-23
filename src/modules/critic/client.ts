// Клиент контр-агента: верификация пакета доказательств с опциональным read-only контуром.
import type { LLMProvider, Message } from "../../llm/provider";
import { LLM_REQUEST_TIMEOUT_MS } from "../../config/timeouts";
import type { CriticVerdict, EvidencePack } from "./types";
import { parseChecks, runCriticChecks, renderCheckResults, CRITIC_READONLY_TOOLS } from "./tools";
import { extractChecks, parseVerdictDetailed } from "./verdict";

export { parseVerdict, parseVerdictDetailed, type ParsedVerdict } from "./verdict";

export const CRITIC_SYSTEM_PROMPT = `You are a strict but fair verifier ("counter-agent") reviewing an AI agent's in-progress work.
Rules:
- Flag ONLY issues that can be verified from the evidence provided. Do not speculate or invent.
- Do not nitpick style, wording, or preferences unless the user's task demanded it.
- If the evidence is insufficient to judge, return status "ok" (prefer silence over noise).
- A chat-delivered answer (ANSWER section) can fully satisfy the task without any files or commands; absence of changed files is NOT itself an issue when ANSWER contains the requested result.
- Numeric/price/model claims presented as facts require WEB GROUNDING: verified=true (a web_fetch returned substantive content and the stated figures appear in it). If the work asserts such facts while web grounding is absent, unverified, or lists unverifiedClaims, that is a "concern" (fabricated data).
- "critical" = the task's stated result is demonstrably not delivered. "concern" = a concrete, checkable gap. "info" = minor.
- Every issue must reference concrete evidence (file, command, output).
Reply with JSON ONLY:
{"status":"ok|concern|critical","summary":"one line","issues":[{"severity":"info|concern|critical","claim":"...","problem":"...","suggestion":"...","evidence":"..."}]}`;

/** Опции клиента критика: провайдер, бюджеты, канал диагностики. */
export interface CriticClientOptions {
  provider: LLMProvider;
  /**
   * Минимальный лимит токенов на один LLM-вызов критика. Реальный лимит
   * = max(это значение, `provider.maxCompletionTokens`): критик НЕ режет
   * бюджет провайдера (INV-C5) — иначе reasoning-токены съедали весь лимит,
   * `finish_reason: length` давал пустой вердикт и fail-open.
   */
  maxTokens?: number;
  /**
   * Таймаут **одного** LLM-вызова, мс. Раньше это был общий бюджет на всю
   * цепочку из трёх проходов: на длинном пакете доказательств второй проход
   * успевал выесть остаток первого и ронял вердикт в fail-open.
   */
  timeoutMs?: number;
  /**
   * Канал диагностики деградации (`critic_degraded: <reason>`). Критик
   * fail-open по контракту, но молчаливый pass неотличим от успеха —
   * каждый отказ обязан быть виден в логе (§5.8 аудита).
   */
  onDiagnostic?: (message: string) => void;
}

/**
 * Минимальный лимит токенов вердикта, если провайдер своего не объявил:
 * хватает на JSON с issues на длинном пакете.
 */
const DEFAULT_MAX_TOKENS = 2048;
/** Дефолтный таймаут вызова критика: не короче провайдерского request-дедлайна. */
const DEFAULT_TIMEOUT_MS = LLM_REQUEST_TIMEOUT_MS;

/**
 * Префикс диагностики деградации. Потребитель (г��йт) снимает его, чтобы
 * положить РЕАЛЬНУЮ причину отказа в `critic_error` сессии (INV-C4):
 * «не дождался» и «ответ упёрся в лимит токенов» — разные вещи.
 */
export const CRITIC_DEGRADED_PREFIX = "critic_degraded: ";

/**
 * Таймаут одного вызова критика. Отдельный тип нужен, чтобы вызывающий проход
 * не перекрывал уже записанную причину своим `llm_error`: «не дождался» и
 * «провайдер упал» — разные вещи (INV-C4).
 */
class CriticCallTimeout extends Error {
  constructor(readonly budgetMs: number) {
    super(`critic call exceeded ${budgetMs}ms`);
    this.name = "CriticCallTimeout";
  }
}

/** Раннер одной проверки критика: тул + args → успех и вывод. */
export interface CriticRunCheck {
  (tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }>;
}

const CHECK_REQUEST_INSTRUCTION = `If your verdict is concern/critical and a read-only file check could confirm or refute an issue, request up to 3 checks by adding "checks":[{"tool":"...","args":{...}}] to your JSON. Available tools ONLY: ${CRITIC_READONLY_TOOLS.join(", ")} (read-only; no writes, shell, web, or memory exist — do not request anything else). Checks run locally and their outputs return to you for a FINAL verdict. If no check would help, omit "checks".`;

const FINAL_VERDICT_INSTRUCTION = `Check outputs above are ground truth from the workspace. Reply with your FINAL verdict as JSON (same shape, no more "checks"): confirm each issue the checks support, drop the ones they refute, and set status accordingly.`;

/** Клиент критика: судит пакет доказательств, при concern/critical — до 3 read-only проверок. */
export class CriticClient {
  constructor(private readonly opts: CriticClientOptions) {}

  isEnabled(): boolean {
    return true;
  }

  /**
   * Верифицирует пакет доказательств (Phase 2: опциональный ограниченный тул-контур).
   *
   * Проход 1 судит пакет как есть (поведение v1). При concern/critical с
   * раннером `runCheck` проход 2 даёт критику до 3 read-only проверок,
   * проход 3 выносит финальный вердикт по их выводам. Вся цепочка делит
   * один таймаут-бюджет и откатывается к вердикту прохода 1
   * (или null, если упал сам проход 1) — глубина верификации best-effort,
   * никогда не блокирует.
   */
  async verify(
    pack: EvidencePack,
    signal?: AbortSignal,
    opts?: { runCheck?: CriticRunCheck },
  ): Promise<CriticVerdict | null> {
    try {
      const messages: Message[] = [
        { role: "system", content: CRITIC_SYSTEM_PROMPT },
        { role: "user", content: renderPack(pack) },
      ];
      const firstRaw = await this.chat(messages, signal);
      const first = this.parseVerdictChecked(firstRaw, "pass-1");
      if (!first || first.status === "ok" || !opts?.runCheck) return first;
      return await this.verifyWithChecks(messages, firstRaw, first, signal, opts.runCheck);
    } catch (err) {
      // Причину таймаута уже записал `chat`; перекрывать её `llm_error` нельзя.
      if (!(err instanceof CriticCallTimeout)) this.degrade(`llm_error: ${describe(err)}`);
      return null;
    }
  }

  /**
   * Разбор вердикта с обязательным отчётом о деградации: нечитаемый ответ —
   * это `critic_degraded`, а «вердикта нет» молчать не должен.
   */
  private parseVerdictChecked(raw: string, stage: string): CriticVerdict | null {
    const parsed = parseVerdictDetailed(raw);
    if (!parsed.verdict) {
      this.degrade(`unparseable_verdict (${stage}): ${truncate(raw, 120)}`);
      return null;
    }
    if (parsed.repaired) {
      // jsonrepair спас обрезанный по maxTokens вердикт — получен валидный
      // JSON, но не тот, что сказала модель. Для «ok» это ложный pass.
      this.degrade(`repaired_verdict (${stage}): ${truncate(raw, 120)}`);
    }
    return parsed.verdict;
  }

  private degrade(reason: string): void {
    // DEBT(critic-degrade-not-in-feed): отказ виден в session.jsonl, но не в ленте web.
    this.opts.onDiagnostic?.(`${CRITIC_DEGRADED_PREFIX}${reason}`);
  }

  /**
   * Проходы 2–3: запрашиваем ограниченные read-only проверки (доп. LLM-вызовы
   * только если первый вердикт actionable), выполняем их и заземляем финальный
   * вердикт на выводах. История сохраняется, чтобы "твой вердикт" резолвился в проход 1.
   * Любой сбой — откат к вердикту прохода 1.
   */
  private async verifyWithChecks(
    messages: Message[],
    firstRaw: string,
    first: CriticVerdict,
    signal: AbortSignal | undefined,
    runCheck: CriticRunCheck,
  ): Promise<CriticVerdict> {
    try {
      messages.push({ role: "assistant", content: firstRaw });
      messages.push({ role: "user", content: CHECK_REQUEST_INSTRUCTION });
      const checksRaw = await this.chat(messages, signal);
      // Проверки читаются независимо от `status`: ответ `{"checks":[...]}`
      // без статуса — валидный запрос, а не «неразбираемый вердикт».
      const checks = parseChecks(extractChecks(checksRaw));
      if (checks.length === 0) {
        // Проверок не запрошено — вердикт прохода 1 остаётся в силе. Это не
        // деградация: вердикт у нас есть, потерялась только глубина проверки.
        this.opts.onDiagnostic?.("critic_checks_unparsed: no checks requested in pass-2");
        return first;
      }
      const results = await runCriticChecks(checks, runCheck);
      if (results.length === 0) return first;

      messages.push({ role: "assistant", content: checksRaw });
      messages.push({
        role: "user",
        content: `CHECK RESULTS (ground truth):\n${renderCheckResults(results)}\n\n${FINAL_VERDICT_INSTRUCTION}`,
      });
      const final = this.parseVerdictChecked(await this.chat(messages, signal), "pass-3");
      return final ?? first;
    } catch (err) {
      // Fail-open к вердикту прохода 1 — но обрыв виден в логе.
      if (!(err instanceof CriticCallTimeout)) {
        this.degrade(`checks_loop_failed: ${describe(err)}`);
      }
      return first;
    }
  }

  /**
   * Эффективный лимит completion-токенов для вызова критика.
   *
   * Правило (INV-C5): критик не перекрывает лимит провайдера вниз. Модель с
   * reasoning съедает токены ДО ответа, и обрезанный по `max_tokens` вердикт
   * приходит пустым (finish_reason "length" → LlmError → fail-open). Если у
   * провайдера лимит не задан — берём свой `maxTokens`.
   */
  private effectiveMaxTokens(): number | undefined {
    const own = this.opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const providerCap = this.opts.provider.maxCompletionTokens;
    if (providerCap === undefined) return own;
    return Math.max(own, providerCap);
  }

  /** Один LLM-вызов под собственным таймаутом + внешней отменой. */
  private async chat(messages: Message[], signal?: AbortSignal): Promise<string> {
    const budget = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Дедлайн — отдельный промис, а не только abort: провайдер, который не
    // слушает signal (живой случай аудита — поток LM Studio «terminated» через
    // 83–120 с при timeoutMs=15000), иначе удерживает вызов сколько захочет.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new CriticCallTimeout(budget));
      }, budget);
    });
    deadline.catch(() => {}); // проигравший гонку reject не должен стать unhandled
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) controller.abort();
    const iterator = this.opts
      .provider.chat(messages, undefined, controller.signal, {
        maxTokens: this.effectiveMaxTokens(),
        reasoningEffort: "none",
      })
      [Symbol.asyncIterator]();
    try {
      let text = "";
      for (;;) {
        const step = iterator.next();
        step.catch(() => {}); // после таймаута этот промис уже никому не нужен
        const next = await Promise.race([step, deadline]);
        if (next.done) break;
        const chunk = next.value;
        if (chunk.type === "text" && chunk.content) text += chunk.content;
      }
      return text;
    } catch (err) {
      // Причину снимаем здесь: abort роняет for-await, а пост-цикловый check
      // был недостижим, и таймаут маскировался под llm_error.
      if (timedOut && !signal?.aborted) {
        this.degrade(`call_timeout (${budget}ms)`);
        throw err instanceof CriticCallTimeout ? err : new CriticCallTimeout(budget);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Погасить поток, оставшийся висеть после таймаута/отмены.
      const closed = iterator.return?.();
      if (closed) closed.catch(() => {});
    }
  }
}

/** Строка веб-обоснования для пакета критика (attempted/verified + unverified claims). */
function renderWebGrounding(g: EvidencePack["webGrounding"]): string {
  if (!g) return "WEB GROUNDING: (none)";
  const claims = g.unverifiedClaims ? `, unverifiedClaims=[${g.unverifiedClaims.join(", ")}]` : "";
  return `WEB GROUNDING: attempted=${g.attempted}, verified=${g.verified}${claims}`;
}

function renderPack(pack: EvidencePack): string {
  const cmdLines = pack.commands.map((c) => {
    const base = `${c.command} (exit ${c.exitCode ?? "?"})`;
    return c.output ? `${base}\n  output: ${c.output}` : base;
  });
  const files = (pack.fileExcerpts ?? []).map((f) => `--- ${f.path} ---\n${f.excerpt}`);
  return [
    `TASK: ${pack.task}`,
    pack.planSummary ? `PLAN: ${pack.planSummary}` : "",
    `CHANGED FILES: ${pack.changedFiles.join(", ") || "(none)"}`,
    `COMMANDS: ${cmdLines.join("; ") || "(none)"}`,
    renderWebGrounding(pack.webGrounding),
    "TOOL TRAIL:",
    pack.toolDigest || "(empty)",
    files.length > 0 ? `FILE CONTENTS:\n${files.join("\n")}` : "",
    pack.answerExcerpt ? `ANSWER (the agent's chat delivery — may satisfy the task without files):\n${pack.answerExcerpt}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Текст ошибки/исключения одной строкой. */
function describe(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

/** Обрезка для диагностики — логи не должны расти от сырого ответа модели. */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
