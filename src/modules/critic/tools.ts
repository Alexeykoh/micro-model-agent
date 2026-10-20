// Ограниченный read-only контур проверок критика (Phase 2, Agent-as-a-Judge).
import type { CriticVerdict, RawCriticChecks } from "./types";

/**
 * Ограниченный read-only контур верификации (Phase 2, Agent-as-a-Judge).
 *
 * После вердикта concern/critical критик может запросить конкретные файловые
 * проверки, чтобы подтвердить/опровергнуть проблему, а не судить вслепую.
 * Доступны только read-only тулы — записи, shell, web и память исключены,
 * так что скомпрометированный/запутавшийся критик ничего не мутирует. Цикл
 * ограничен (доп. LLM-вызовы + проверки делят verify-таймаут), при сбое —
 * откат к вердикту первого прохода.
 */

/** Read-only тулы, доступные критику. Записи/shell/web/память исключены by design. */
export const CRITIC_READONLY_TOOLS = ["read_file", "grep", "glob", "file_info", "list_dir"] as const;

/** Жёсткий кап проверок на вердикт (внутренний дефолт, не конфиг — спек §4.3). */
export const MAX_CRITIC_CHECKS = 3;

/** Символов вывода на проверку, возвращаемых критику (ограничено — у verify-вызова свой бюджет). */
export const MAX_CHECK_OUTPUT_CHARS = 1500;

/** Одна валидированная проверка критика: тул + аргументы. */
export interface CriticCheck {
  tool: string;
  args: Record<string, unknown>;
}

/** Результат одной проверки: тул, успех, обрезанный вывод. */
export interface CriticCheckResult {
  tool: string;
  ok: boolean;
  output: string;
}

/** True, если тул разрешён критику (входит в read-only allowlist). */
export function isAllowedCriticTool(tool: string): boolean {
  return (CRITIC_READONLY_TOOLS as readonly string[]).includes(tool);
}

/**
 * Проверки из вердикта критика (сырой массив `checks`, allowlist + кап).
 * Принимает и сам вердикт, и «голый» массив проверок: проход 2 читает
 * проверки независимо от `status` (ответ `{"checks":[...]}` без статуса —
 * валидный запрос, а не мусор).
 * Чужое — неизвестные тулы, не-объектные args — молча дропается:
 * критик теряет только глубину верификации, не корректность.
 */
export function parseChecks(source: CriticVerdict | RawCriticChecks | null | undefined): CriticCheck[] {
  const raw = Array.isArray(source) ? source : source?.checks;
  if (!raw || !Array.isArray(raw)) return [];
  const out: CriticCheck[] = [];
  for (const c of raw) {
    if (out.length >= MAX_CRITIC_CHECKS) break;
    const check = asCriticCheck(c);
    if (check) out.push(check);
  }
  return out;
}

/** Одна сырая запись → валидированная проверка, или null, если непригодна/запрещена. */
function asCriticCheck(c: unknown): CriticCheck | null {
  if (!c || typeof c !== "object") return null;
  const rec = c as { tool?: unknown; args?: unknown };
  if (typeof rec.tool !== "string" || !isAllowedCriticTool(rec.tool)) return null;
  if (!rec.args || typeof rec.args !== "object" || Array.isArray(rec.args)) return null;
  return { tool: rec.tool, args: rec.args as Record<string, unknown> };
}

/**
 * Выполняет валидированные проверки через инжектированный раннер (в Agent —
 * ToolExecutor с read-only allowlist). Последовательно, никогда параллельно
 * с вызовами тулов главного цикла. Сбой одной проверки даёт failure-результат,
 * остальные проверки не прерываются.
 */
export async function runCriticChecks(
  checks: CriticCheck[],
  runCheck: (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>,
): Promise<CriticCheckResult[]> {
  const out: CriticCheckResult[] = [];
  for (const c of checks.slice(0, MAX_CRITIC_CHECKS)) {
    try {
      const r = await runCheck(c.tool, c.args);
      out.push({ tool: c.tool, ok: r.ok, output: (r.output ?? "").slice(0, MAX_CHECK_OUTPUT_CHARS) });
    } catch (err) {
      out.push({
        tool: c.tool,
        ok: false,
        output: `check failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
      });
    }
  }
  return out;
}

/** Рендерит результаты проверок строками доказательств, видимых критику. */
export function renderCheckResults(results: CriticCheckResult[]): string {
  return results
    .map((r) => `${r.ok ? "✓" : "✗"} ${r.tool} » ${r.output}`)
    .join("\n");
}
