import { describe, expect, it } from "bun:test";
import { buildSlashCompletions } from "../../src/cli/completer";

describe("buildSlashCompletions", () => {
  it("includes alias keys with the command description", () => {
    const cmd = { name: "quit", description: "Exit the REPL" };
    const commands = new Map([
      ["quit", cmd],
      ["q", cmd],
      ["exit", cmd],
      ["help", { name: "help", description: "Show help" }],
    ]);
    const items = buildSlashCompletions(commands);
    const names = items.map((i) => i.name);
    expect(names).toContain("quit");
    expect(names).toContain("q");
    expect(names).toContain("exit");
    expect(items.find((i) => i.name === "q")?.description).toBe("Exit the REPL");
  });
});
