import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Logger } from "../src/logger/app-logger";
import { OutputBus } from "../src/output/bus";
import {
  setAuditSessionDir,
  clearAuditSessionDir,
  logToolCall,
} from "../src/modules/security/audit-log";
import { auditLogFile } from "../src/config/paths";

function read(p: string): string {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  } catch {
    return "";
  }
}

describe("session-scope isolation", () => {
  it("Logger.forSession gives each session its own .log (no clobber)", () => {
    const root = mkdtempSync(join(tmpdir(), "scope-log-"));
    try {
      const logs = join(root, "logs");
      const base = new Logger("debug", "test");
      base.setLogDir(logs);

      const a = base.forSession("A", join(root, "sesA"));
      const b = base.forSession("B", join(root, "sesB"));
      a.warn("from-A-1");
      b.warn("from-B-1");
      a.warn("from-A-2");

      const logA = read(join(logs, "A.log"));
      const logB = read(join(logs, "B.log"));
      expect(logA).toContain("from-A-1");
      expect(logA).toContain("from-A-2");
      expect(logB).toContain("from-B-1");
      expect(logB).not.toContain("from-A");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Logger.forSession tags its output events with the sessionId", () => {
    const bus = new OutputBus();
    const seen: Array<string | undefined> = [];
    bus.subscribe((ev) => seen.push(ev.sessionId));
    const base = new Logger("debug", "test", bus);
    base.warn("global");
    base.forSession("A").warn("scoped");
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe("A");
  });

  it("audit entries route to their own session dir, not the last bound", () => {
    const root = mkdtempSync(join(tmpdir(), "scope-audit-"));
    try {
      const dirA = join(root, "sesA");
      const dirB = join(root, "sesB");
      setAuditSessionDir(dirA, "A");
      setAuditSessionDir(dirB, "B");

      logToolCall("A", "read_file", true);
      logToolCall("B", "write_file", true);
      logToolCall("A", "grep", false);

      expect(read(auditLogFile(dirA))).toContain("read_file");
      expect(read(auditLogFile(dirA))).toContain("grep");
      expect(read(auditLogFile(dirA))).not.toContain("write_file");
      expect(read(auditLogFile(dirB))).toContain("write_file");
      expect(read(auditLogFile(dirB))).not.toContain("read_file");
    } finally {
      clearAuditSessionDir("A");
      clearAuditSessionDir("B");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
