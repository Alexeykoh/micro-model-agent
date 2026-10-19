import { describe, expect, it } from "vitest";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import {
  createProviderEgressFactory,
  isLoopbackHost,
  isTrustedHost,
  providerHost,
} from "../../src/modules/security/data-policy/egress-provider";

const ctx: PolicyContext = { baseDir: "C:\\work\\proj", hostname: "DESKTOP-ABC123" };

describe("provider host/trust verdict (§6.2)", () => {
  it("парсит хост из baseUrl со схемой, без схемы и IPv6", () => {
    expect(providerHost("http://localhost:1234/v1")).toBe("localhost");
    expect(providerHost("127.0.0.1:11434")).toBe("127.0.0.1");
    expect(providerHost("https://api.openai.com/v1")).toBe("api.openai.com");
    expect(providerHost("http://[::1]:8080/v1")).toBe("::1");
    expect(providerHost(undefined)).toBeUndefined();
  });

  it("loopback доверенный, внешний — нет; allowlist добавляет доверие", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("api.openai.com")).toBe(false);
    expect(isTrustedHost("127.0.0.1", [])).toBe(true);
    expect(isTrustedHost("api.openai.com", [])).toBe(false);
    expect(isTrustedHost("ollama.corp", ["ollama.corp"])).toBe(true);
    expect(isTrustedHost("ollama.corp", ["http://ollama.corp:11434"])).toBe(true);
    expect(isTrustedHost("evil.corp", ["ollama.corp"])).toBe(false);
  });
});

describe("createProviderEgressFactory", () => {
  const deps = (dataPolicy = DEFAULT_DATA_POLICY) => ({
    getConfig: () => ({ security: { dataPolicy } }) as never,
    ctx,
  });

  it("loopback-запись получает доверенный guard, внешняя — нет", () => {
    const factory = createProviderEgressFactory(deps());
    expect(factory({ type: "openai-compat", baseUrl: "http://localhost:1234/v1" })?.target.trusted).toBe(
      true,
    );
    expect(
      factory({ type: "openai-compat", baseUrl: "https://api.openai.com/v1" })?.target.trusted,
    ).toBe(false);
  });

  it("непарсимый baseUrl считается внешним (fail-closed)", () => {
    const factory = createProviderEgressFactory(deps());
    const guard = factory({ type: "openai-compat", baseUrl: "" });
    expect(guard?.target.trusted).toBe(false);
  });

  it("политика выключена — guard не создаётся (kill-switch)", () => {
    const factory = createProviderEgressFactory(deps({ ...DEFAULT_DATA_POLICY, enabled: false }));
    expect(factory({ type: "openai-compat", baseUrl: "http://localhost:1234/v1" })).toBeUndefined();
  });

  it("фабрика читает живой конфиг (правка подхватывается)", () => {
    let enabled = true;
    const factory = createProviderEgressFactory({
      getConfig: () => ({ security: { dataPolicy: { ...DEFAULT_DATA_POLICY, enabled } } }) as never,
      ctx,
    });
    expect(factory({ type: "openai-compat", baseUrl: "http://localhost:1234/v1" })).toBeDefined();
    enabled = false;
    expect(factory({ type: "openai-compat", baseUrl: "http://localhost:1234/v1" })).toBeUndefined();
  });
});
