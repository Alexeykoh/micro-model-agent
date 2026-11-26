// Субагент без явного скоупа наследует родительский; undefined = без ограничений.
import { describe, it, expect } from "vitest";
import { resolveSubagentScope } from "../../src/tools/subagent-scope";

const restricted = { allowed_files: ["src/**"], read_only_files: [] };

describe("subagent scope inheritance", () => {
  it("inherits an unrestricted parent as undefined, not deny-all", () => {
    expect(resolveSubagentScope(undefined, undefined)).toBeUndefined();
  });

  it("inherits a restricted parent scope", () => {
    expect(resolveSubagentScope(undefined, restricted)).toEqual(restricted);
  });

  it("explicit scope still wins", () => {
    const explicit = { allowed_files: ["docs/**"], read_only_files: [] };
    expect(resolveSubagentScope(explicit, restricted)).toEqual(explicit);
  });
});
