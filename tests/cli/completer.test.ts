import { describe, expect, it } from "bun:test";
import { Completer, SlashCommandProvider } from "../../src/cli/completer";

describe("Completer descriptions", () => {
  it("returns value + description for slash commands", () => {
    const c = new Completer();
    c.registerProvider(
      new SlashCommandProvider([
        { name: "help", description: "Show help" },
        { name: "model", description: "Model commands" },
      ]),
    );
    const [items] = c.complete("/he");
    expect(items).toEqual([{ value: "/help", description: "Show help" }]);
  });
});
