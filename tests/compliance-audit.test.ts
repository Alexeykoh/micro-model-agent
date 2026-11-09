import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { appendAudit, verifyAudit } from "../src/modules/compliance/audit-log";
import { recordRisk, recordAdversarial, recordLineage } from "../src/modules/compliance/risk";

describe("tamper-evident audit log", () => {
  it("chains and verifies", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-audit-"));
    const log = join(dir, "audit.jsonl");
    appendAudit(log, dir, "turn", { x: 1 }, "ses_1");
    appendAudit(log, dir, "tool", { y: 2 }, "ses_1");
    const res = verifyAudit(log, dir);
    expect(res.valid).toBe(true);
    expect(res.entries).toBe(2);
  });

  it("detects tampering", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-audit-"));
    const log = join(dir, "audit.jsonl");
    appendAudit(log, dir, "turn", { x: 1 }, "ses_1");
    const raw = readFileSync(log, "utf-8");
    writeFileSync(log, raw.replace('"x":1', '"x":9'), "utf-8");
    const res = verifyAudit(log, dir);
    expect(res.valid).toBe(false);
    expect(res.brokenAt).toBe(0);
  });

  it("risk/adversarial/lineage writers create artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-risk-"));
    const risk = recordRisk(dir, "ses_1", "write_file", true, false);
    expect(risk.toolsUsed).toContain("write_file");
    expect(risk.approvals).toBe(1);
    recordAdversarial(dir, "ses_1", "denied bash rm -rf");
    recordLineage(dir, "ses_1", "deepseek-v4.1-flash", "abc123");
  });
});
