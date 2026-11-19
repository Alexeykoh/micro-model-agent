// INV-21 (W3.5): модуль объявляет свои ключи конфига — хост собирает,
// реестр регистрирует. Ключ доступен resolve/get/set и виден в списке.
import { afterEach, describe, expect, it } from "vitest";
import { ModuleHost } from "../../src/core/module-host";
import { Logger } from "../../src/logger/app-logger";
import { OutputBus } from "../../src/output";
import type { AppConfig } from "../../src/config/types";
import type { ConfigKeyDef } from "../../src/config/registry";
import {
  configDefs,
  getConfigValue,
  resolveConfigKey,
  setConfigValue,
} from "../../src/config/registry";
import {
  __clearRegisteredConfigKeys,
  registerConfigKeys,
} from "../../src/config/module-keys";
import { executionModuleDef } from "../../src/modules/execution/lifecycle";
import type { ExecutionModule } from "../../src/modules/execution/module";

interface ProbeConfig {
  probeFlag?: boolean;
}

function makeHost(): ModuleHost {
  const bus = new OutputBus();
  const logger = new Logger("warn", "", bus);
  return new ModuleHost({} as unknown as AppConfig, logger, bus);
}

/** Деф ключа `probe.flag` (bool), объявленный «модулем». */
function probeKey(alias = "probeFlag"): ConfigKeyDef {
  return {
    key: "probe.flag",
    aliases: [alias],
    domain: "agent",
    valueType: "bool",
    effects: [],
    get: (c) => (c as unknown as ProbeConfig).probeFlag ?? false,
    set: (c, v) => {
      (c as unknown as ProbeConfig).probeFlag = v as boolean;
    },
  };
}

afterEach(() => __clearRegisteredConfigKeys());

describe("module-declared config keys (INV-21)", () => {
  it("collects keys from modules in init order", () => {
    const host = makeHost();
    host.register({ name: "b", requires: ["a"], configKeys: () => [probeKey()] });
    host.register({
      name: "a",
      configKeys: () => [{ ...probeKey(), key: "probe.other", aliases: [] }],
    });
    expect(host.collectConfigKeys().map((d) => d.key)).toEqual(["probe.other", "probe.flag"]);
  });

  it("a module key resolves, lists and round-trips get/set (W3 spec §7)", () => {
    registerConfigKeys([probeKey()]);
    expect(resolveConfigKey("probe.flag")).toBeTruthy();
    expect(resolveConfigKey("probeFlag")).toBeTruthy(); // alias
    expect(configDefs().some((d) => d.key === "probe.flag")).toBe(true);

    const config = {} as unknown as AppConfig;
    const set = setConfigValue(config, "probe.flag", "on");
    expect(set.ok).toBe(true);
    if (set.ok) expect(set.effects).toEqual([]);

    const get = getConfigValue(config, "probeFlag");
    expect(get.ok).toBe(true);
    if (get.ok) expect(get.value).toBe(true);
  });

  it("registers module keys on setup (bootstrap path)", async () => {
    const host = makeHost();
    host.register({ name: "m", configKeys: () => [probeKey()] });
    await host.setup();
    expect(resolveConfigKey("probe.flag")).toBeTruthy();
  });

  it("a built-in key wins over a module collision", () => {
    registerConfigKeys([{ ...probeKey(), key: "model", aliases: [] }]);
    // Встроенный `model` не переопределён модульной декларацией.
    expect(resolveConfigKey("model")?.domain).not.toBe("probe");
    expect(resolveConfigKey("probe.flag")).toBeNull();
  });

  it("registration is idempotent across repeated bootstraps", () => {
    registerConfigKeys([probeKey()]);
    registerConfigKeys([probeKey()]);
    expect(configDefs().filter((d) => d.key === "probe.flag")).toHaveLength(1);
  });

  it("the execution module declares its real key (INV-21 migration)", () => {
    const keys = executionModuleDef({} as ExecutionModule).configKeys?.() ?? [];
    expect(keys.map((k) => k.key)).toContain("execution.autoAdvance");
  });
});
