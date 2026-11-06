import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logAudit, setGlobalAuditDir } from "../../src/modules/security/audit-log";
import {
  emitSecurityEvent,
  resetSecurityEvents,
  securityEventFromAudit,
  securityEventsFor,
  SECURITY_EVENT_CAP,
  subscribeSecurityEvents,
  type SecurityEvent,
} from "../../src/modules/security/security-events";
import { mergeSecurityEvents } from "../../src/modules/webui/session/security-api";
import { globalLogsDir } from "../../src/config/paths";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-sec-"));
  setGlobalAuditDir(dir);
  resetSecurityEvents();
});

afterEach(() => {
  resetSecurityEvents();
  setGlobalAuditDir(globalLogsDir());
  rmSync(dir, { recursive: true, force: true });
});

describe("security-события из аудита (U22)", () => {
  it("блок пути — block, блок с URL — ssrf", () => {
    const base = {
      timestamp: "2026-11-02T10:00:00.000Z",
      action: "security_block",
      success: false,
    };
    expect(securityEventFromAudit({ ...base, path: "C:\\x\\.env" })?.class).toBe("block");
    const ssrf = securityEventFromAudit({ ...base, url: "http://169.254.169.254/" });
    expect(ssrf?.class).toBe("ssrf");
    expect(ssrf?.severity).toBe("high");
  });

  it("approval попадает в журнал, обычный вызов тула и сбой сети — нет", () => {
    expect(
      securityEventFromAudit({
        timestamp: "t",
        action: "security_approval",
        success: true,
      })?.class,
    ).toBe("approval");
    // Сбой сети — не перехват защиты: журнал не затопляем.
    expect(
      securityEventFromAudit({
        timestamp: "t",
        action: "network_request",
        success: false,
        url: "https://x",
      }),
    ).toBeNull();
    expect(
      securityEventFromAudit({ timestamp: "t", action: "tool_call", success: true }),
    ).toBeNull();
  });

  it("DLP-редакция попадает в класс dlp и несёт сводку без значений", () => {
    const ev = securityEventFromAudit({
      timestamp: "2026-11-02T10:00:00.000Z",
      action: "dlp_redaction",
      success: true,
      tool: "sanitizeChat",
      details: "path×2, pii×1 (провайдер: api.example, внешний)",
    });
    expect(ev?.class).toBe("dlp");
    expect(ev?.severity).toBe("medium");
    expect(ev?.summary).toContain("path×2");
    expect(ev?.summary).toContain("провайдер");
    expect(ev?.summary).not.toContain("sk-");
  });

  it("DLP-редакция из audit.jsonl переживает бэкфилл (класс dlp)", () => {
    logAudit({
      timestamp: new Date().toISOString(),
      sessionId: "s1",
      action: "dlp_redaction",
      success: true,
      tool: "sanitizeChat",
      details: "path×1",
    });
    const merged = mergeSecurityEvents("s1", 100, dir);
    expect(merged.some((ev) => ev.class === "dlp")).toBe(true);
  });

  it("logAudit отдаёт событие подписчику и не несёт секретов", () => {
    const got: SecurityEvent[] = [];
    const off = subscribeSecurityEvents((ev) => got.push(ev));
    logAudit({
      timestamp: new Date().toISOString(),
      sessionId: "s1",
      action: "security_block",
      tool: "bash",
      path: "C:\\work\\secret\\.env",
      success: false,
      reason: "protected path",
    });
    off();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ class: "block", tool: "bash", sessionId: "s1" });
    // В событии нет значений файла, только путь-цель и причина.
    expect(JSON.stringify(got[0])).not.toContain("sk-");
  });

  it("буфер держит кап и отдаёт хвост", () => {
    for (let i = 0; i < SECURITY_EVENT_CAP + 20; i++) {
      emitSecurityEvent({
        ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        class: "dlp",
        severity: "medium",
        summary: `event ${i}`,
        action: "egress_redacted",
        success: true,
        sessionId: "s1",
      });
    }
    expect(securityEventsFor("s1")).toHaveLength(SECURITY_EVENT_CAP);
    expect(securityEventsFor("s1")[SECURITY_EVENT_CAP - 1].summary).toBe(
      `event ${SECURITY_EVENT_CAP + 19}`,
    );
  });

  it("бэкфилл сливает буфер и audit.jsonl без дублей", () => {
    logAudit({
      timestamp: "2026-11-02T10:00:00.000Z",
      sessionId: "s1",
      action: "security_block",
      tool: "bash",
      path: "C:\\x",
      success: false,
    });
    emitSecurityEvent({
      ts: "2026-11-02T10:00:05.000Z",
      class: "dlp",
      severity: "medium",
      summary: "DLP: секретов 1",
      action: "egress_redacted",
      success: true,
      sessionId: "s1",
    });
    // История читается только из каталога сессии: глобальный лог не мешаем.
    const merged = mergeSecurityEvents("s1", 100, dir);
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.class)).toEqual(["block", "dlp"]);
  });

  it("без каталога сессии история не читается (чужой лог не подмешивается)", () => {
    logAudit({
      timestamp: "2026-11-02T10:00:00.000Z",
      sessionId: "s1",
      action: "security_block",
      tool: "bash",
      path: "C:\\x",
      success: false,
    });
    // Буфер процесса очищен: история читается только из каталога сессии.
    resetSecurityEvents();
    expect(mergeSecurityEvents("s1", 100)).toHaveLength(0);
    expect(mergeSecurityEvents("s1", 100, dir)).toHaveLength(1);
  });
});
