/**
 * High-risk artifacts (P2 compliance, EU AI Act Art.9/15):
 * per-session risk file (what the agent did, tools used, approvals),
 * lineage (model+prompt+tools snapshot per turn), adversarial log
 * (denied/bypass attempts). Stored under `<baseDir>/compliance/`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export interface RiskFile {
  sessionId: string;
  createdAt: string;
  toolsUsed: string[];
  approvals: number;
  denied: number;
}

export function complianceDir(baseDir: string): string {
  return join(baseDir, "compliance");
}

export function riskPath(baseDir: string, sessionId: string): string {
  return join(complianceDir(baseDir), `${sessionId}.risk.json`);
}

export function recordRisk(baseDir: string, sessionId: string, tool: string, approved: boolean, denied: boolean): RiskFile {
  const path = riskPath(baseDir, sessionId);
  mkdirSync(complianceDir(baseDir), { recursive: true, mode: 0o700 });
  let risk: RiskFile;
  if (existsSync(path)) {
    try {
      risk = JSON.parse(readFileSync(path, "utf-8")) as RiskFile;
    } catch {
      risk = { sessionId, createdAt: new Date().toISOString(), toolsUsed: [], approvals: 0, denied: 0 };
    }
  } else {
    risk = { sessionId, createdAt: new Date().toISOString(), toolsUsed: [], approvals: 0, denied: 0 };
  }
  if (!risk.toolsUsed.includes(tool)) risk.toolsUsed.push(tool);
  if (approved) risk.approvals++;
  if (denied) risk.denied++;
  writeFileSync(path, JSON.stringify(risk, null, 2), "utf-8");
  return risk;
}

/** Adversarial log: one line per denied/bypass attempt (Art.15). */
export function recordAdversarial(baseDir: string, sessionId: string, detail: string): void {
  const dir = complianceDir(baseDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, "adversarial.log"), `${new Date().toISOString()} ${sessionId} ${detail}\n`, "utf-8");
}

/** Lineage: model+prompt hash snapshot for a turn (reproducibility). */
export function recordLineage(baseDir: string, sessionId: string, model: string, promptHash: string): void {
  const dir = complianceDir(baseDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, "lineage.log"), `${new Date().toISOString()} ${sessionId} ${model} ${promptHash}\n`, "utf-8");
}
