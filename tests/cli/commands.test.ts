import { describe, it, expect } from "vitest";
import type { Command } from "commander";
import { createProgram } from "../../src/cli/commands";

/** Number of `postAction` lifecycle hooks attached to a command. */
function postActionHookCount(cmd: Command): number {
  const hooks = (cmd as unknown as { _lifeCycleHooks?: { postAction?: unknown[] } })._lifeCycleHooks;
  return hooks?.postAction?.length ?? 0;
}

describe("CLI commands", () => {
  it("creates program with all commands", () => {
    const program = createProgram();
    expect(program.name()).toBe("mma");
    const cmds = program.commands.map((c) => c.name());
    expect(cmds).toContain("init");
    expect(cmds).toContain("config");
    expect(cmds).toContain("model");
    expect(cmds).toContain("provider");
  });

  it("registers onboarding commands setup/meet/init", () => {
    const program = createProgram();
    const cmds = program.commands.map((c) => c.name());
    expect(cmds).toContain("setup");
    expect(cmds).toContain("meet");
    expect(cmds).toContain("init");
  });

  it("meet/init have no one-shot exit hook; setup does", () => {
    const program = createProgram();
    const find = (name: string) => program.commands.find((c) => c.name() === name);
    expect(find("meet")).toBeDefined();
    expect(find("init")).toBeDefined();
    expect(find("setup")).toBeDefined();

    expect(postActionHookCount(find("meet")!)).toBe(0);
    expect(postActionHookCount(find("init")!)).toBe(0);
    expect(postActionHookCount(find("setup")!)).toBeGreaterThan(0);
  });

  it("config has set and show subcommands", () => {
    const program = createProgram();
    const config = program.commands.find((c) => c.name() === "config");
    expect(config).toBeDefined();
    const subCmds = config!.commands.map((c) => c.name());
    expect(subCmds).toContain("set");
    expect(subCmds).toContain("show");
  });
});
