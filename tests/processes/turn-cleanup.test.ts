// AQC-8: фоновые процессы, запущенные внутри хода, завершаются в его конце;
// процессы, поднятые раньше (например, dev-сервер пользователя), не трогаются.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { processRegistry } from "../../src/modules/processes/registry";
import { stopTurnProcesses } from "../../src/core/agent/turn-process-cleanup";

describe("AQC-8: cleanup процессов в конце хода", () => {
  it("убивает только процессы текущего хода", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-turn-proc-"));
    const sessionId = `aqc8-${Date.now()}`;
    const turnStartedAt = Date.now() - 60_000;
    const current = processRegistry.start("node -e \"setTimeout(()=>{},30000)\"", dir, sessionId, {
      force: true,
    });
    const older = processRegistry.start("node -e \"setTimeout(()=>{},30000)\"", dir, sessionId, {
      force: true,
    });
    older.startedAt = new Date(turnStartedAt - 60_000).toISOString();
    try {
      const diagnostics: string[] = [];
      stopTurnProcesses(
        { getActiveMeta: () => ({ id: sessionId }) } as never,
        { onDiagnostic: (e: { cause: string }) => diagnostics.push(e.cause) } as never,
        turnStartedAt,
      );
      expect(current.status).toBe("killed");
      expect(older.status).toBe("running");
      expect(diagnostics.join(" ")).toContain("stopped 1");
    } finally {
      processRegistry.killAll(sessionId);
      // Каталог может ещё держаться живым дочерним процессом Windows —
      // тест не обязан его удалять, временная папка уйдёт вместе с ОС.
    }
  });
});
