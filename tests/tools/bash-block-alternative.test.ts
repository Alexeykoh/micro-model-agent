// Guard: заблокированная bash-команда обязана говорить модели, ЧЕМ её заменить.
// Сессия ses_mwmeoln9: 25 блокировок (> && | curl -c), общий Hint игнорировался.
import { describe, it, expect } from "vitest";
import { isCommandAllowed } from "../../src/modules/security/command-validator";
import { DEFAULT_SECURITY_CONFIG } from "../../src/config/security";
import { blockAlternativeHint, blockReasonKind } from "../../src/modules/security/block-alternatives";

const bash = DEFAULT_SECURITY_CONFIG.bash;

describe("альтернатива при блокировке bash", () => {
  it("каждый ожидаемый вид отказа даёт actionable-замену", () => {
    const cases: Array<[string, string]> = [
      ['Operator ">" is not allowed', "write_file"],
      ["Command chaining to a dangerous command is blocked", "separate tool calls"],
      ["Interpreter -c/-e invocation is blocked", "write_file"],
      ["Multi-line commands are blocked", "one-line calls"],
      ['Command "curl" is blacklisted', "web_fetch"],
      ['Dangerous flag "--insecure" is not allowed', "plain command"],
    ];
    for (const [reason, expected] of cases) {
      const hint = blockAlternativeHint(reason);
      expect(hint, reason).toContain(expected);
    }
  });

  it("причины реальных блокировок валидатора имеют известный вид", () => {
    const commands = [
      "echo a > b.txt",
      "echo a && echo b",
      "curl http://127.0.0.1:5173/",
      "python -c print(1)",
      "echo a\necho b",
    ];
    for (const command of commands) {
      const res = isCommandAllowed(command, bash);
      expect(res.allowed, command).toBe(false);
      expect(blockReasonKind(res.reason ?? ""), `${command} → ${res.reason}`).not.toBe("unknown");
    }
  });

  it("неизвестная причина не показывает выдуманную замену", () => {
    expect(blockAlternativeHint("unexpected policy failure")).toBe("");
  });
});
