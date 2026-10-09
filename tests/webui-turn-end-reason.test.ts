import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("turn_end stop reason", () => {
  it("forwards result.error and stopReason through run-agent", () => {
    const src = readFileSync("src/modules/webui/session/run-agent.ts", "utf8");
    expect(src).toMatch(/stopReason:\s*result\.stopReason/);
    expect(src).toMatch(/error:\s*result\.error/);
  });
  it("feed onTurnEnd renders the real reason", () => {
    const src = readFileSync("src/modules/webui/assets/js/feed/turn.ts", "utf8");
    // new onTurnEnd failure branch: data.error preferred over the generic strings
    expect(src).toMatch(/data\.error \|\| \(data\.interrupted \? t\("web\.turn\.stopped"\)/);
    // successful forced finalize surfaces the reason too
    expect(src).toMatch(/data\.stopReason && data\.error/);
  });
});
