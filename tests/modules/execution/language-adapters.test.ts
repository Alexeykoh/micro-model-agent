import { describe, it, expect } from "vitest";
import { adapterForExt } from "../../../src/modules/execution/language-adapters";

describe("language adapters", () => {
  it("maps non-TS languages to a real syntax check", () => {
    expect(adapterForExt(".py")).toMatchObject({ kind: "command" });
    expect(adapterForExt(".rb")?.kind).toBe("command");
    expect(adapterForExt(".php")?.kind).toBe("command");
    expect(adapterForExt(".sh")?.kind).toBe("command");
    expect(adapterForExt(".json")?.kind).toBe("json");
  });

  it("does not claim TS/JS or unknown extensions", () => {
    expect(adapterForExt(".ts")).toBeNull();
    expect(adapterForExt(".tsx")).toBeNull();
    expect(adapterForExt(".js")).toBeNull();
    expect(adapterForExt(".md")).toBeNull();
  });

  it("builds a quoted file argument", () => {
    const a = adapterForExt(".py");
    expect(a?.kind).toBe("command");
    if (a?.kind === "command") expect(a.command("src/a b.py")).toContain('"src/a b.py"');
  });
});
