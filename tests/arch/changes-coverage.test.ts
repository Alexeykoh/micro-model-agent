import { describe, expect, it } from "bun:test";
import {
  EXCLUDED_TOOLS,
  MAX_PENDING,
  OP_BY_TOOL,
} from "../../src/modules/changes/capture";
import { signalForOperation } from "../../src/core/bootstrap/tool-context";
import { DIAGNOSTIC_EVENTS, type Diagnostic } from "../../src/output/types";
import { registerAllTools } from "../../src/tools/index";
import { ToolRegistry } from "../../src/tools/registry";

const registryOf = (): ToolRegistry => {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  return registry;
};
const writersOf = (registry: ToolRegistry) =>
  registry.getAll().filter((tool) =>
    tool.security.pathArgs?.length &&
    tool.security.caps.some((cap) => cap.fs === "write" || cap.fs === "any"),
  );

describe("file-tool snapshot coverage", () => {
  it("covers or explicitly excludes every fs-write tool with pathArgs", () => {
    const writers = writersOf(registryOf());
    expect(writers.length).toBeGreaterThan(0);
    for (const tool of writers) {
      expect(OP_BY_TOOL[tool.name] ?? EXCLUDED_TOOLS[tool.name]).toBeTruthy();
    }
  });

  it("maps every covered tool to arguments the tool actually declares", () => {
    for (const tool of writersOf(registryOf())) {
      const plan = OP_BY_TOOL[tool.name];
      if (!plan) continue;
      expect(tool.security.pathArgs).toContain(plan.pathArg);
      if (plan.toArg) expect(tool.security.pathArgs).toContain(plan.toArg);
    }
  });

  it("has no dead OP_BY_TOOL entries", () => {
    const registry = registryOf();
    for (const [name, plan] of Object.entries(OP_BY_TOOL)) {
      const tool = registry.get(name);
      expect(tool, `OP_BY_TOOL names unregistered tool ${name}`).toBeDefined();
      expect(tool!.security.pathArgs).toContain(plan.pathArg);
      if (plan.toArg) expect(tool!.security.pathArgs).toContain(plan.toArg);
      expect(EXCLUDED_TOOLS[name]).toBeFalsy();
    }
  });

  it("documents exclusions with a reason", () => {
    expect(EXCLUDED_TOOLS.create_dir).toBeTruthy();
    expect(EXCLUDED_TOOLS.bash).toBeTruthy();
    expect(EXCLUDED_TOOLS.restore_file).toBeTruthy();
  });

  it("keeps skipped diagnostics inside the closed signal whitelist", () => {
    for (const op of [
      "changes.capture.before",
      "changes.capture.after",
      "changes.capture.pending",
    ]) {
      expect(DIAGNOSTIC_EVENTS).toContain(signalForOperation(op));
    }
    const skipped: Diagnostic = {
      source: "module:changes",
      operation: "changes.capture.before",
      kind: "skipped",
      cause: "source is a symbolic link",
      recoverable: true,
      detail: { callId: "c", sessionId: "s", path: "a.txt", call: "write_file" },
    };
    expect(skipped.kind).toBe("skipped");
    expect(MAX_PENDING).toBeGreaterThan(0);
  });
});
