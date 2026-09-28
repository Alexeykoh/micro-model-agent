import { jsonrepair } from "jsonrepair";
import type { LLMProvider, Message } from "../../llm/provider";
import type { CriticVerdict, EvidencePack, CriticIssue } from "./types";

export const CRITIC_SYSTEM_PROMPT = `You are a strict but fair verifier ("counter-agent") reviewing an AI agent's in-progress work.
Rules:
- Flag ONLY issues that can be verified from the evidence provided. Do not speculate or invent.
- Do not nitpick style, wording, or preferences unless the user's task demanded it.
- If the evidence is insufficient to judge, return status "ok" (prefer silence over noise).
- "critical" = the task's stated result is demonstrably not delivered. "concern" = a concrete, checkable gap. "info" = minor.
- Every issue must reference concrete evidence (file, command, output).
Reply with JSON ONLY:
{"status":"ok|concern|critical","summary":"one line","issues":[{"severity":"info|concern|critical","claim":"...","problem":"...","suggestion":"...","evidence":"..."}]}`;

export interface CriticClientOptions {
  provider: LLMProvider;
  maxTokens?: number;
  timeoutMs?: number;
}

export class CriticClient {
  constructor(private readonly opts: CriticClientOptions) {}

  isEnabled(): boolean {
    return true;
  }

  async verify(pack: EvidencePack, signal?: AbortSignal): Promise<CriticVerdict | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15000);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      const messages: Message[] = [
        { role: "system", content: CRITIC_SYSTEM_PROMPT },
        { role: "user", content: renderPack(pack) },
      ];
      let text = "";
      for await (const chunk of this.opts.provider.chat(messages, undefined, controller.signal, {
        maxTokens: this.opts.maxTokens ?? 512,
        reasoningEffort: "none",
      })) {
        if (chunk.type === "text" && chunk.content) text += chunk.content;
      }
      return parseVerdict(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
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
  const issues: CriticIssue[] = Array.isArray(obj.issues)
    ? (obj.issues as unknown[])
        .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
        .map((i) => ({
          severity: (SEVERITIES.has(String(i.severity)) ? String(i.severity) : "concern") as CriticIssue["severity"],
          claim: String(i.claim ?? ""),
          problem: String(i.problem ?? ""),
          suggestion: i.suggestion ? String(i.suggestion) : undefined,
          evidence: i.evidence ? String(i.evidence) : undefined,
        }))
        .filter((i) => i.claim || i.problem)
    : [];
  return { status, summary: String(obj.summary ?? ""), issues };
}
