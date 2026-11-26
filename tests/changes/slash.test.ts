// tests/changes/slash.test.ts
import { describe, expect, it } from "bun:test";
import { buildCommandCatalog } from "../../src/core/commands/spec";

const CATALOG = buildCommandCatalog();

describe("/undo", () => {
  it("exists in the command catalog and is terminal-only", () => {
    const cmd = CATALOG.find((c) => c.name === "undo");
    expect(cmd).toBeDefined();
    expect(cmd!.surfaces).toBeUndefined();
    expect(cmd!.group).toBe("session");
  });
});
