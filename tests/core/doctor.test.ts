// `mma doctor` / `/doctor`: сводка окружения, модулей, плагинов, провайдера, LSP, конфига.
import { describe, it, expect } from "vitest";
import { buildDoctorReport, formatDoctorReport } from "../../src/core/doctor";
import { ModuleHost } from "../../src/core/module-host";
import { Logger } from "../../src/logger/app-logger";
import { OutputBus } from "../../src/output";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";

function cfg(): AppConfig {
  return structuredClone(DEFAULTS) as AppConfig;
}

describe("doctor report", () => {
  it("builds all sections and warns (not fails) without collaborators", () => {
    const report = buildDoctorReport({ config: cfg(), configDir: "C:/tmp", baseDir: "C:/work" });
    expect(report.sections.map((s) => s.title)).toEqual([
      "Environment",
      "Provider",
      "Modules",
      "Plugins",
      "LSP",
      "Config",
    ]);
    expect(report.sections.find((s) => s.title === "Modules")?.status).toBe("warn");
    expect(report.sections.find((s) => s.title === "Plugins")?.status).toBe("warn");
    // warnings alone do not fail the report
    expect(report.ok).toBe(true);
    expect(formatDoctorReport(report).at(-1)).toBe("doctor: OK");
  });

  it("surfaces a failed module as a fail and lists health", async () => {
    const bus = new OutputBus();
    const config = cfg();
    const host = new ModuleHost(config, new Logger("warn", "", bus), bus);
    host.register({
      name: "browser",
      critical: false,
      setup: () => {
        throw new Error("no chromium");
      },
    });
    host.register({ name: "lsp" });
    await host.setup();

    const report = buildDoctorReport({
      config,
      configDir: "C:/tmp",
      baseDir: "C:/work",
      moduleHost: host,
    });
    const modules = report.sections.find((s) => s.title === "Modules");
    expect(modules?.status).toBe("fail");
    expect(modules?.lines.join("\n")).toContain("browser: failed — no chromium");
    expect(modules?.lines.join("\n")).toContain("lsp: ok");
    expect(report.ok).toBe(false);
    expect(formatDoctorReport(report).at(-1)).toBe("doctor: problems found");
  });
});
