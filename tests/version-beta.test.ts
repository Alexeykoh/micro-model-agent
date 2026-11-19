import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("beta version guard", () => {
  it("stays below 1.0.0 while the project is in beta", () => {
    const major = Number(pkg.version.split(".")[0]);
    expect(
      major,
      "MMA is beta: releases stay in 0.x.y and 1.0.0 is reserved for an explicit decision to leave beta (see AGENTS.md → Versioning Rules)",
    ).toBe(0);
  });
});
