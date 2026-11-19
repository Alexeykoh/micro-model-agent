import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setLocale } from "../../src/i18n/index";
import {
  classifySpawnError,
  shellUnavailableOutput,
} from "../../src/tools/bash-spawn-error";
import { runBashCommand } from "../../src/tools/bash-process";
import {
  SHELL_STOP_THRESHOLD,
  resetBashFailureTracking,
  shellUnavailableStreak,
} from "../../src/tools/bash-failures";
import { processRegistry, type ManagedProcess } from "../../src/modules/processes";
import { DEFAULT_SECURITY_CONFIG } from "../../src/config/security";
import { SHELL_UNAVAILABLE_ERROR_CODE } from "../../src/tools/bash-spawn-error";
import type { ToolContext } from "../../src/tools/types";

const SHELL_MSG = "ENOENT: no such file or directory, uv_spawn 'C:\\Windows\\system32\\cmd.exe'";

beforeEach(() => setLocale("en"));

describe("classifySpawnError", () => {
  it("classifies a missing shell as shell when the workdir exists", () => {
    expect(classifySpawnError(SHELL_MSG, "win32", process.cwd())).toBe("shell");
  });

  it("classifies a missing workdir as workdir even though the message names cmd.exe", () => {
    // Node/Bun сообщают путь шелла, а не cwd — текст сам причину не различает.
    expect(classifySpawnError(SHELL_MSG, "win32", "Z:\\no\\such\\dir")).toBe("workdir");
  });

  it("classifies a message naming the workdir as workdir", () => {
    expect(
      classifySpawnError("EACCES: permission denied, open 'E:/proj/secret'", "win32", "E:/proj/secret"),
    ).toBe("workdir");
  });

  it("classifies unrelated output as unknown", () => {
    expect(classifySpawnError("Command failed with exit code 1", "win32", process.cwd())).toBe(
      "unknown",
    );
  });

  it("names a POSIX shell without needing the workdir", () => {
    expect(classifySpawnError("spawn bash ENOENT", "linux")).toBe("shell");
  });
});

describe("shellUnavailableOutput", () => {
  it("never blames the workdir", () => {
    const text = shellUnavailableOutput(SHELL_MSG);
    expect(text).toContain("[process error]");
    expect(text).not.toContain('check the "workdir"');
  });
});

describe("bash: shell-unavailable streak (S1)", () => {
  const realStart = processRegistry.start;
  let starts = 0;
  let spawnError: string | undefined = SHELL_MSG;
  let exitCode: number | null = null;
  let log: string[] = [`[process error] ${SHELL_MSG}`];

  function makeCtx(): ToolContext {
    return {
      baseDir: process.cwd(),
      config: {},
      logger: { info: () => {}, error: () => {} },
      sessionId: "ses-streak",
    } as unknown as ToolContext;
  }

  function run(ctx: ToolContext) {
    return runBashCommand({
      ctx,
      command: "echo hi",
      originalCommand: "echo hi",
      workdir: process.cwd(),
      explicitBackground: false,
      force: false,
      securityConfig: DEFAULT_SECURITY_CONFIG.bash,
      memoizable: false,
      memoKey: { command: "echo hi", workdir: process.cwd() },
    });
  }

  beforeEach(() => {
    resetBashFailureTracking();
    starts = 0;
    spawnError = SHELL_MSG;
    exitCode = null;
    log = [`[process error] ${SHELL_MSG}`];
    processRegistry.start = ((
      command: string,
      cwd: string,
      _sessionId?: string,
      _opts?: { force?: boolean },
    ): ManagedProcess => {
      starts++;
      return {
        id: `proc_stub_${starts}`,
        pid: 0,
        command,
        cwd,
        status: spawnError ? "killed" : "exited",
        exitCode,
        startedAt: new Date().toISOString(),
        log,
        spawnError,
      };
    }) as typeof processRegistry.start;
  });

  afterEach(() => {
    processRegistry.start = realStart;
    resetBashFailureTracking();
  });

  it("reports the shell as unavailable instead of blaming the workdir", async () => {
    const ctx = makeCtx();
    const result = await run(ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("shell is unavailable");
    expect(result.output).not.toContain('check the "workdir"');
    // Машиночитаемый сигнал для смежных модулей (stuck-детектор, S2).
    expect(result.errorMeta?.code).toBe(SHELL_UNAVAILABLE_ERROR_CODE);
    expect(shellUnavailableStreak(ctx)).toBe(1);
  });

  it(`does not spawn from the ${SHELL_STOP_THRESHOLD}rd consecutive shell failure`, async () => {
    const ctx = makeCtx();
    await run(ctx);
    await run(ctx);
    expect(starts).toBe(2);

    const third = await run(ctx);
    expect(starts).toBe(2); // спавн не вызывался
    expect(third.success).toBe(false);
    expect(third.output).toContain("shell is unavailable");
  });

  it("resets the streak on a successful bash", async () => {
    const ctx = makeCtx();
    await run(ctx); // одно «шелл недоступен» → streak 1
    expect(shellUnavailableStreak(ctx)).toBe(1);

    spawnError = undefined;
    exitCode = 0;
    log = ["ok"];
    const ok = await run(ctx); // успех — шелл снова работает
    expect(ok.success).toBe(true);
    expect(shellUnavailableStreak(ctx)).toBe(0);

    // Следующая серия спавнит снова, а не упирается в стоп.
    spawnError = SHELL_MSG;
    exitCode = null;
    log = [`[process error] ${SHELL_MSG}`];
    const after = await run(ctx);
    expect(after.success).toBe(false);
    expect(starts).toBe(3);
  });
});
