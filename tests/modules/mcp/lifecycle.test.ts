import { describe, it, expect, vi } from "vitest";
import { mcpModuleDef } from "../../../src/modules/mcp/lifecycle";
import { ModuleHost, type ModuleDef } from "../../../src/core/module-host";
import { Logger } from "../../../src/logger/app-logger";
import { OutputBus } from "../../../src/output";
import type { AppConfig } from "../../../src/config/types";
import type { MCPModule } from "../../../src/modules/mcp/module";

function hostWith(def: ModuleDef): ModuleHost {
  const bus = new OutputBus();
  const logger = new Logger("info", "", bus);
  const host = new ModuleHost({} as unknown as AppConfig, logger, bus);
  host.register(def);
  return host;
}

describe("mcp module contract (W1.6)", () => {
  it("declares itself non-critical with setup = initialize()", async () => {
    const initialize = vi.fn(async () => {});
    const def = mcpModuleDef({ initialize } as unknown as MCPModule);
    expect(def.name).toBe("mcp");
    expect(def.critical).toBe(false);
    await hostWith(def).setup();
    expect(initialize).toHaveBeenCalledOnce();
  });

  it("does not fail boot when MCP setup throws (non-critical, INV-5)", async () => {
    const def = mcpModuleDef({
      initialize: async () => {
        throw new Error("server down");
      },
    } as unknown as MCPModule);
    const host = hostWith(def);
    await expect(host.setup()).resolves.toBeUndefined();
    expect(host.health()[0].health).toMatchObject({ status: "failed" });
  });
});
