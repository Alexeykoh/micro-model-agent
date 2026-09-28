// Клиент контр-агента: верификация пакета доказательств с опциональным read-only контуром.
import { jsonrepair } from "jsonrepair";
import type { LLMProvider, Message } from "../../llm/provider";
import type { CriticVerdict, EvidencePack, CriticIssue } from "./types";
import { parseChecks, runCriticChecks, renderCheckResults, CRITIC_READONLY_TOOLS } from "./tools";

export const CRITIC_SYSTEM_PROMPT = `You are a strict but fair verifier ("counter-agent") reviewing an AI agent's in-progress work.
Rules:
- Flag ONLY issues that can be verified from the evidence provided. Do not speculate or invent.
- Do not nitpick style, wording, or preferences unless the user's task demanded it.
- If the evidence is insufficient to judge, return status "ok" (prefer silence over noise).
- "critical" = the task's stated result is demonstrably not delivered. "concern" = a concrete, checkable gap. "info" = minor.
- Every issue must reference concrete evidence (file, command, output).
Reply with JSON ONLY:
{"status":"ok|concern|critical","summary":"one line","issues":[{"severity":"info|concern|critical","claim":"...","problem":"...","suggestion":"...","evidence":"..."}]}`;

/** Опции клиента критика: провайдер, лимит токенов, таймаут. */
export interface CriticClientOptions {
  provider: LLMProvider;
  maxTokens?: number;
  timeoutMs?: number;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15000);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      const messages: Message[] = [
        { role: "system", content: CRITIC_SYSTEM_PROMPT },
        { role: "user", content: renderPack(pack) },
      ];
      const firstRaw = await this.chat(messages, controller.signal);
      const first = parseVerdict(firstRaw);
      if (!first || first.status === "ok" || !opts?.runCheck) return first;
      return await this.verifyWithChecks(messages, firstRaw, first, controller.signal, opts.runCheck);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
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
    signal: AbortSignal,
    runCheck: CriticRunCheck,
  ): Promise<CriticVerdict> {
    try {
      messages.push({ role: "assistant", content: firstRaw });
      messages.push({ role: "user", content: CHECK_REQUEST_INSTRUCTION });
      const checksRaw = await this.chat(messages, signal);
      const checks = parseChecks(parseVerdict(checksRaw));
      if (checks.length === 0) return first;
      const results = await runCriticChecks(checks, runCheck);
      if (results.length === 0) return first;

      messages.push({ role: "assistant", content: checksRaw });
      messages.push({
        role: "user",
        content: `CHECK RESULTS (ground truth):\n${renderCheckResults(results)}\n\n${FINAL_VERDICT_INSTRUCTION}`,
      });
      return parseVerdict(await this.chat(messages, signal)) ?? first;
    } catch {
      return first;
    }
  }

  private async chat(messages: Message[], signal: AbortSignal): Promise<string> {
    let text = "";
    for await (const chunk of this.opts.provider.chat(messages, undefined, signal, {
      maxTokens: this.opts.maxTokens ?? 512,
      reasoningEffort: "none",
    })) {
      if (chunk.type === "text" && chunk.content) text += chunk.content;
    }
    return text;
  }
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
    "TOOL TRAIL:",
    pack.toolDigest || "(empty)",
    files.length > 0 ? `FILE CONTENTS:\n${files.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const SEVERITIES = new Set(["info", "concern", "critical"]);

/** Парсит вердикт критика из сырого текста (строгий JSON → jsonrepair → вырезание блока). Null, если не вердикт. */
export function parseVerdict(text: string): CriticVerdict | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(text));
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        parsed = JSON.parse(jsonrepair(match[0]));
      } catch {
        return null;
      }
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const status = obj.status;
  if (status !== "ok" && status !== "concern" && status !== "critical") return null;
  const issues = parseIssuesList(obj.issues);
  // Запрошенные проверки верификации (Phase 2): несём сырыми, кап здесь;
  // форма + allowlist enforced в parseChecks, вслепую не доверяем.
  const checks = parseRawChecks(obj.checks);
  return { status, summary: String(obj.summary ?? ""), issues, ...(checks ? { checks } : {}) };
}

/** Проблемы вердикта с санитизированными severity; записи без claim+problem дропаются. */
function parseIssuesList(raw: unknown): CriticIssue[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((i) => ({
      severity: (SEVERITIES.has(String(i.severity)) ? String(i.severity) : "concern") as CriticIssue["severity"],
      claim: String(i.claim ?? ""),
      problem: String(i.problem ?? ""),
      suggestion: i.suggestion ? String(i.suggestion) : undefined,
      evidence: i.evidence ? String(i.evidence) : undefined,
    }))
    .filter((i) => i.claim || i.problem);
}

/** Сырые запрошенные проверки (с капом); форма + allowlist enforced в parseChecks. */
function parseRawChecks(raw: unknown): Array<{ tool: string; args?: Record<string, unknown> }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = (raw as unknown[])
    .filter(
      (c): c is { tool: string; args?: unknown } =>
        !!c &&
        typeof c === "object" &&
        typeof (c as { tool?: unknown }).tool === "string",
    )
    .map((c) => ({ tool: c.tool, args: c.args as Record<string, unknown> | undefined }));
  return out.length > 0 ? out : undefined;
}
