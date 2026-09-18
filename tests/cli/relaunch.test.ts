import { describe, it, expect } from "vitest";
import { relaunchArgs } from "../../src/cli/relaunch";

describe("relaunchArgs", () => {
  it("drops the runtime binary and keeps the entry plus user args", () => {
    expect(relaunchArgs(["bun", "src/cli/main.ts", "-d", "proj"])).toEqual([
      "src/cli/main.ts",
      "-d",
      "proj",
    ]);
  });

  it("keeps only the entry script when there are no user args", () => {
    expect(relaunchArgs(["node", "bin/mma.mjs"])).toEqual(["bin/mma.mjs"]);
  });
});
