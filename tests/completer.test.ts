import { describe, it, expect } from "vitest";
import { Completer, SlashCommandProvider, SubcommandProvider } from "../src/cli/completer";

describe("Completer", () => {
  it("should complete slash commands", () => {
    const completer = new Completer();
    completer.registerProvider(
      new SlashCommandProvider([{ name: "help" }, { name: "model" }, { name: "config" }, { name: "exit" }]),
    );
    const [results] = completer.complete("/");
    const values = results.map((r) => r.value);
    expect(values).toContain("/help");
    expect(values).toContain("/model");
  });

  it("should filter by partial input", () => {
    const completer = new Completer();
    completer.registerProvider(
      new SlashCommandProvider([{ name: "help" }, { name: "model" }, { name: "config" }, { name: "exit" }]),
    );
    const [results] = completer.complete("/mo");
    const values = results.map((r) => r.value);
    expect(values).toContain("/model");
    expect(values).not.toContain("/help");
  });

  it("should complete subcommands", () => {
    const completer = new Completer();
    const subProvider = new SubcommandProvider("model", ["list", "use", "info"]);
    completer.registerProvider(subProvider);
    const [results] = completer.complete("/model ");
    const values = results.map((r) => r.value);
    expect(values).toContain("list");
    expect(values).toContain("use");
  });

  it("should return empty array for no match", () => {
    const completer = new Completer();
    const [results] = completer.complete("/nonexistent");
    expect(results).toEqual([]);
  });

  it("should handle empty line", () => {
    const completer = new Completer();
    const [results] = completer.complete("");
    expect(results).toEqual([]);
  });
});
