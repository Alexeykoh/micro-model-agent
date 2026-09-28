import type { CriticVerdict } from "./types";

/**
 * Bounded read-only verification loop (Phase 2, Agent-as-a-Judge).
 *
 * After a concern/critical verdict the critic may request concrete file
 * checks to confirm or refute an issue instead of judging blind. Only
 * read-only tools are reachable — writes, shell, web and memory stay out,
 * so a compromised or confused critic cannot mutate anything. The loop is
 * capped (extra LLM calls + check executions share the verify timeout) and
 * fails open to the first-pass verdict.
 */

/** Read-only tools the critic may use. Writes/shell/web/memory are excluded by design. */
export const CRITIC_READONLY_TOOLS = ["read_file", "grep", "glob", "file_info", "list_dir"] as const;

/** Hard cap on verification checks per verdict (internal default, not config — spec §4.3). */
export const MAX_CRITIC_CHECKS = 3;

/** Output chars per check fed back to the critic (bounded — the verify call has its own budget). */
export const MAX_CHECK_OUTPUT_CHARS = 1500;

export interface CriticCheck {
  tool: string;
  args: Record<string, unknown>;
}

export interface CriticCheckResult {
  tool: string;
  ok: boolean;
  output: string;
}

export function isAllowedCriticTool(tool: string): boolean {
  return (CRITIC_READONLY_TOOLS as readonly string[]).includes(tool);
}

/**
 * Checks requested by the critic verdict (parsed `checks` array, allowlisted
 * and capped). Anything else — unknown tools, non-object args — is dropped
 * silently: the critic only loses verification depth, never correctness.
 */
export function parseChecks(verdict: CriticVerdict | null): CriticCheck[] {
  if (!verdict?.checks || !Array.isArray(verdict.checks)) return [];
  const out: CriticCheck[] = [];
  for (const c of verdict.checks) {
    if (out.length >= MAX_CRITIC_CHECKS) break;
    const check = asCriticCheck(c);
    if (check) out.push(check);
  }
  return out;
}

/** Single raw entry → validated check, or null when unusable/forbidden. */
function asCriticCheck(c: unknown): CriticCheck | null {
  if (!c || typeof c !== "object") return null;
  const rec = c as { tool?: unknown; args?: unknown };
  if (typeof rec.tool !== "string" || !isAllowedCriticTool(rec.tool)) return null;
  if (!rec.args || typeof rec.args !== "object" || Array.isArray(rec.args)) return null;
  return { tool: rec.tool, args: rec.args as Record<string, unknown> };
}

/**
 * Execute validated checks through the injected runner (wired in Agent to
 * ToolExecutor with a read-only allowlist). Sequential — never concurrent
 * with main-loop tool calls. Per-check failures become failure results, so
 * one bad check never aborts the remaining ones.
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

/** Render check results as critic-visible evidence lines. */
export function renderCheckResults(results: CriticCheckResult[]): string {
  return results
    .map((r) => `${r.ok ? "✓" : "✗"} ${r.tool} » ${r.output}`)
    .join("\n");
}
