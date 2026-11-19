// Проходы 2–3 критика: запрос read-only проверок и финальный вердикт.
// Вынесено из `client.ts` (правило ≤300); клиент передаёт свои chat/parse/stage.
import type { Message } from "../../llm/provider";
import type { CriticRunCheck, CriticStage, CriticVerdict } from "./types";
import {
  parseChecks,
  runCriticChecks,
  renderCheckResults,
  CRITIC_READONLY_TOOLS,
  type CriticCheck,
} from "./tools";
import { extractChecks } from "./verdict";

const CHECK_REQUEST_INSTRUCTION = `If your verdict is concern/critical and a read-only file check could confirm or refute an issue, request up to 3 checks by adding "checks":[{"tool":"...","args":{...}}] to your JSON. Available tools ONLY: ${CRITIC_READONLY_TOOLS.join(", ")} (read-only; no writes, shell, web, or memory exist — do not request anything else). Checks run locally and their outputs return to you for a FINAL verdict. If no check would help, omit "checks".`;

const FINAL_VERDICT_INSTRUCTION = `Check outputs above are ground truth from the workspace. Reply with your FINAL verdict as JSON (same shape, no more "checks"): confirm each issue the checks support, drop the ones they refute, and set status accordingly.`;

/** Что клиент отдаёт циклу проверок (его приватные методы — через callbacks). */
export interface CheckLoopHost {
  chat(messages: Message[], signal?: AbortSignal): Promise<string>;
  parseVerdictChecked(raw: string, stage: string): CriticVerdict | null;
  stage(event: CriticStage): void;
  degrade(reason: string): void;
}

/**
 * Запрашиваем ограниченные read-only проверки (доп. LLM-вызовы только если
 * первый вердикт actionable), выполняем их и заземляем финальный вердикт на
 * выводах. Любой сбой — откат к вердикту прохода 1.
 */
export async function verifyWithChecks(
  host: CheckLoopHost,
  messages: Message[],
  firstRaw: string,
  first: CriticVerdict,
  signal: AbortSignal | undefined,
  runCheck: CriticRunCheck,
): Promise<CriticVerdict> {
  try {
    // Модель могла уже назвать проверки в первом JSON — тогда второй
    // LLM-проход («попроси проверки») не нужен: экономим целый вызов.
    let checks: CriticCheck[] = parseChecks(first);
    let checksPass = 1;
    messages.push({ role: "assistant", content: firstRaw });
    if (checks.length === 0) {
      messages.push({ role: "user", content: CHECK_REQUEST_INSTRUCTION });
      host.stage({ stage: "checks", pass: 2 });
      const checksRaw = await host.chat(messages, signal);
      checksPass = 2;
      // Проверки читаются независимо от `status`: ответ `{"checks":[...]}`
      // без статуса — валидный запрос, а не «неразбираемый вердикт».
      checks = parseChecks(extractChecks(checksRaw));
      if (checks.length === 0) {
        // Проверок не запрошено — вердикт прохода 1 остаётся в силе. Это не
        // деградация: вердикт у нас есть, потерялась только глубина проверки.
        host.degrade("critic_checks_unparsed: no checks requested in pass-2");
        return first;
      }
      messages.push({ role: "assistant", content: checksRaw });
    }
    host.stage({ stage: "checks", pass: checksPass, checks });
    const results = await runCriticChecks(checks, runCheck, signal);
    if (results.length === 0) return first;
    host.stage({ stage: "checks", pass: checksPass, checks, results });

    messages.push({
      role: "user",
      content: `CHECK RESULTS (ground truth):\n${renderCheckResults(results)}\n\n${FINAL_VERDICT_INSTRUCTION}`,
    });
    host.stage({ stage: "final", pass: checksPass + 1 });
    const final = host.parseVerdictChecked(await host.chat(messages, signal), "pass-3");
    host.stage({ stage: "final", pass: checksPass + 1, verdict: final ?? undefined });
    return final ?? first;
  } catch (err) {
    // Отмена пользователем — не сбой.
    if (signal?.aborted) return first;
    // Fail-open к вердикту прохода 1 — но обрыв виден в логе.
    const timeout = (err as Error)?.name === "CriticCallTimeout";
    if (!timeout) host.degrade(`checks_loop_failed: ${String((err as Error)?.message ?? err)}`);
    return first;
  }
}
