/**
 * `GET /v1/oversight` — HITL oversight panel (P1 HITL): kill-switch state,
 * paused sessions, pending approvals/questions, compliance trail.
 * Auth: bearer (not an open path).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sendJson } from "../http/respond";
import { verifyAudit } from "../../compliance/audit-log";
import type { AgentServiceState } from "../state";

export function handleOversight(_req: IncomingMessage, res: ServerResponse, s: AgentServiceState): void {
  const baseDir = s.deps.baseDir ?? process.cwd();
  const auditPath = join(baseDir, "compliance", "audit.jsonl");
  const keyDir = join(baseDir, "compliance");
  const audit = existsSync(auditPath) ? verifyAudit(auditPath, keyDir) : { valid: true, entries: 0 };

  let adversarialTail: string[] = [];
  const advPath = join(baseDir, "compliance", "adversarial.log");
  if (existsSync(advPath)) {
    adversarialTail = readFileSync(advPath, "utf-8").trim().split("\n").filter(Boolean).slice(-20);
  }

  sendJson(res, 200, {
    killSwitch: Boolean(s.config.hitl?.killSwitch),
    tenant: s.tenant.tenantId,
    pendingQuestions: s.pendingQuestions.size,
    compliance: {
      enabled: Boolean(s.config.compliance?.enabled),
      retentionDays: s.config.compliance?.retentionDays ?? 180,
      auditValid: audit.valid,
      auditEntries: audit.entries,
      adversarialTail,
    },
  });
}
