// LM-3: local-trusted не блокирует mundane-команды, явная конфигурация уважается.
import { describe, it, expect } from "vitest";
import { applyLocalTrustedBashPolicy, DEFAULT_SECURITY_CONFIG } from "../../src/config/security";
import { DEFAULTS } from "../../src/config/defaults";

function config(profile: "local-trusted" | "sandbox" | undefined) {
  const c = structuredClone(DEFAULTS);
  c.execution = { ...c.execution, profile };
  c.security = structuredClone(DEFAULT_SECURITY_CONFIG);
  return c;
}

describe("local-trusted bash policy", () => {
  it("relaxes untouched defaults on local-trusted", () => {
    const c = config("local-trusted");
    applyLocalTrustedBashPolicy(c);
    expect(c.security!.bash.dangerousOperators).toEqual([]);
    expect(c.security!.bash.blacklist).not.toContain("node");
    expect(c.security!.bash.blacklist).not.toContain("python");
    expect(c.security!.bash.blacklist).toContain("sudo");
  });

  it("keeps strict defaults in sandbox", () => {
    const c = config("sandbox");
    applyLocalTrustedBashPolicy(c);
    expect(c.security!.bash.dangerousOperators).toEqual(DEFAULT_SECURITY_CONFIG.bash.dangerousOperators);
  });

  it("respects an explicit user list", () => {
    const c = config("local-trusted");
    c.security!.bash.dangerousOperators = [">"];
    applyLocalTrustedBashPolicy(c);
    expect(c.security!.bash.dangerousOperators).toEqual([">"]);
  });
});
