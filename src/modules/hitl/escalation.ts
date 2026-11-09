/**
 * HITL escalation policy (P1 HITL): impact → approval requirement.
 * `low` — auto-approvable when `hitl.autoApproveLow` (default off);
 * `medium` — always asks; `high`/`critical` — always asks AND records
 * an adversarial/compliance entry (oversight trail).
 */
export type Impact = "low" | "medium" | "high" | "critical";

export interface EscalationConfig {
  autoApproveLow?: boolean;
}

export function shouldEscalate(impact: Impact | undefined, config?: EscalationConfig): boolean {
  const level = impact ?? "medium";
  if (level === "low") return !(config?.autoApproveLow ?? false);
  return true;
}

export function isHighImpact(impact: Impact | undefined): boolean {
  return impact === "high" || impact === "critical";
}
