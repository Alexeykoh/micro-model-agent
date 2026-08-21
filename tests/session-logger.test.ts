import { describe, it, expect } from "vitest";
import { SessionLogger } from "../src/core/session-logger";

describe("session-logger sanitization", () => {
  const makeLogger = () => {
    const logs: any[] = [];
    const messages: any[] = [];
    const session = {
      getActiveMeta: () => ({ id: "ses_1" }),
      getSessionDirectory: () => "/tmp/nonexistent-mma-ses",
      appendLog: (e: any) => logs.push(e),
      appendMessage: (m: any) => messages.push(m),
    } as any;
    return { logger: new SessionLogger(session), logs, messages };
  };

  it("redacts api keys from logUser", () => {
    const { logger, logs, messages } = makeLogger();
    logger.logUser("my key sk-ABCDEF12345678901234 and token ghp_abcdefghijklmnopqrstuvwxyz1234");
    const all = JSON.stringify({ logs, messages });
    expect(all).not.toContain("sk-ABCDEF12345678901234");
    expect(all).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234");
  });

  it("redacts secrets from logToolCall args and logToolResult output", () => {
    const { logger, logs, messages } = makeLogger();
    logger.logToolCall(
      {
        id: "t1",
        name: "bash",
        arguments: { command: "curl -H 'Authorization: Bearer sk-ABCDEF12345678901234'" },
      },
      1,
    );
    logger.logToolResult(
      { id: "t1", name: "bash", arguments: {} },
      { success: true, output: "token ghp_abcdefghijklmnopqrstuvwxyz1234 leaked" },
      10,
      1,
    );
    const all = JSON.stringify({ logs, messages });
    expect(all).not.toContain("sk-ABCDEF12345678901234");
    expect(all).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234");
  });
});
