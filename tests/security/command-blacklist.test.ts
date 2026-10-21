import { describe, it, expect } from "vitest";
import { isCommandAllowed } from "../../src/modules/security/command-validator";
import { DEFAULT_SECURITY_CONFIG } from "../../src/config/security";
import {
  BALANCED_POLICY,
  PERMISSIVE_POLICY,
  STRICT_POLICY,
} from "../../src/modules/security/security-policies";

/**
 * Чёрные списки команд: опасные формы не должны проходить ни в одной
 * политике (аудит §4.10/§4.11, план `2026-10-12-harness-module-audit-fixes`,
 * W3/Task 3.8).
 */

const PRESETS = [STRICT_POLICY, BALANCED_POLICY, PERMISSIVE_POLICY];

const DANGEROUS_COMMANDS = [
  "del /f /s /q C:\\Windows\\Temp",
  "rmdir /s /q E:\\x",
  "git clean -fdx",
  "reg add HKLM\\Software\\Evil",
  "certutil -urlcache -f http://x",
  "attrib +s C:\\x",
  "wscript //E:javascript:x",
  "shred -u secret",
];

describe("чёрные списки команд", () => {
  it.each(DANGEROUS_COMMANDS)("блокирует %s в каждой политике", (cmd) => {
    for (const preset of PRESETS) {
      const res = isCommandAllowed(cmd, preset.config.bash);
      expect(res.allowed).toBe(false);
    }
  });

  it.each(DANGEROUS_COMMANDS)("блокирует %s в дефолтном конфиге", (cmd) => {
    expect(isCommandAllowed(cmd, DEFAULT_SECURITY_CONFIG.bash).allowed).toBe(false);
  });

  it("блокирует find -exec и xargs (произвольный код в обход списка)", () => {
    for (const preset of PRESETS) {
      expect(isCommandAllowed("find . -exec rm {} ;", preset.config.bash).allowed).toBe(false);
      expect(isCommandAllowed("ls | xargs rm", preset.config.bash).allowed).toBe(false);
    }
  });

  it("не блокирует обычные команды", () => {
    // Strict по умолчанию работает с whitelist-командами — там git не в списке,
    // поэтому проверяем пресеты без whitelist.
    for (const preset of [BALANCED_POLICY, PERMISSIVE_POLICY]) {
      expect(isCommandAllowed("git status", preset.config.bash).allowed).toBe(true);
      expect(isCommandAllowed("git clean -n", preset.config.bash).allowed).toBe(true);
      expect(isCommandAllowed("ls -la", preset.config.bash).allowed).toBe(true);
    }
  });
});
