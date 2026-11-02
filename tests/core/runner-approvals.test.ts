/**
 * Per-session раннер (`mma web`) обязан иметь `ApprovalStore`: иначе `approve`
 * молча не выдаёт разрешение, и запись в защищённый путь блокируется даже после
 * «Да» (найдено живым прогоном: grant не потреблялся, `security_approval` не писался).
 */
import { describe, expect, it } from "vitest";
import { buildRunnerToolCtx } from "../../src/core/bootstrap/session-runner-scope";
import { ApprovalStore } from "../../src/core/approvals";
import type { AppConfig } from "../../src/config/types";
import type { Logger } from "../../src/logger/app-logger";
import type { ContextManager } from "../../src/core/context/manager";
import type { SessionManager } from "../../src/modules/session/index";

function build(): ReturnType<typeof buildRunnerToolCtx> {
  return buildRunnerToolCtx({
    configRef: { current: { model: "m" } as AppConfig },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger,
    baseDir: "C:\\work\\proj",
    contextManager: {} as ContextManager,
    sessionManager: {
      appendMessage: () => {},
      appendLog: () => {},
      getActiveMeta: () => ({ id: "s1" }),
    } as unknown as SessionManager,
    sessionId: "s1",
    activeToolTags: [],
    capabilitiesProbeRef: {},
  });
}

describe("runner ToolContext: разрешения approve", () => {
  it("содержит ApprovalStore и потребляет выданный grant", () => {
    const { toolCtx } = build();
    expect(toolCtx.approvals).toBeInstanceOf(ApprovalStore);
    toolCtx.approvals?.grant("C:\\work\\proj\\.env", "write .env");
    const grant = toolCtx.approvals?.consume("C:\\work\\proj\\.env", "call-1");
    expect(grant).toBeDefined();
    // Второй другой вызов уже не получает разрешение (одноразовое).
    expect(toolCtx.approvals?.consume("C:\\work\\proj\\.env", "call-2")).toBeUndefined();
  });
});
