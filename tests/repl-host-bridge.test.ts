import { describe, it, expect } from "vitest";
import { createHostBridge } from "../src/cli/repl";

describe("repl re-export", () => {
  it("still exports createHostBridge (compat)", () => {
    expect(typeof createHostBridge).toBe("function");
  });
});
