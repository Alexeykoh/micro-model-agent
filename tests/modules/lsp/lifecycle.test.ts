import { describe, it, expect, vi } from "vitest";
import { lspModuleDef } from "../../../src/modules/lsp/lifecycle";
import { ModuleHost, type ModuleDef } from "../../../src/core/module-host";
import { Logger } from "../../../src/logger/app-logger";
import { OutputBus } from "../../../src/output";
import type { AppConfig } from "../../../src/config/types";
import type { LspModule } from "../../../src/modules/lsp/module";

function hostWith(def: ModuleDef): ModuleHost {
  const bus = new OutputBus();
  const logger = new Logger("info", "", bus);
  const host = new ModuleHost({} as unknown as AppConfig, logger, bus);
  host.register(def);
  return host;
}

describe("lsp module contract (W1.6)", () => {
  it("declares itself non-critical with teardown = close()", async () => {
    const close = vi.fn(async () => {});
    const def = lspModuleDef({ close } as unknown as LspModule);
    expect(def.name).toBe("lsp");
    expect(def.critical).toBe(false);
    const host = hostWith(def);
    await host.setup(); // no setup() — no-op
    await host.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the server pool on dispose (INV-7: no leaked pids)", async () => {
    let closed = false;
    const def = lspModuleDef({
      close: async () => {
        closed = true;
      },
    } as unknown as LspModule);
    const host = hostWith(def);
    await host.setup();
    expect(closed).toBe(false);
    await host.dispose();
    expect(closed).toBe(true);
  });
});
