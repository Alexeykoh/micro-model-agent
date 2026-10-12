import { describe, it, expect } from "vitest";
import { browserModuleDef } from "../../../src/modules/browser/lifecycle";
import { ModuleHost } from "../../../src/core/module-host";
import { Logger } from "../../../src/logger/app-logger";
import { OutputBus } from "../../../src/output";
import type { AppConfig } from "../../../src/config/types";

function hostWith(def: ReturnType<typeof browserModuleDef>): ModuleHost {
  const bus = new OutputBus();
  const logger = new Logger("info", "", bus);
  const host = new ModuleHost({} as unknown as AppConfig, logger, bus);
  host.register(def);
  return host;
}

describe("browser module contract (W1.6)", () => {
  it("declares itself non-critical with a teardown", () => {
    const def = browserModuleDef();
    expect(def.name).toBe("browser");
    expect(def.critical).toBe(false);
    expect(typeof def.teardown).toBe("function");
  });

  it("dispose closes the (possibly absent) browser session without throwing", async () => {
    const host = hostWith(browserModuleDef());
    await host.setup();
    await expect(host.dispose()).resolves.toBeUndefined();
  });
});
