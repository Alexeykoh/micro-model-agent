import { describe, expect, it } from "bun:test";
import {
  Completer,
  ConfigKeyProvider,
  ConfigValueProvider,
  FlagProvider,
  CommandArgProvider,
} from "../../src/cli/completer";

describe("config key/value completion", () => {
  it("completes the next dotted segment", () => {
    const c = new Completer();
    c.registerProvider(new ConfigKeyProvider());
    const [items] = c.complete("/config contextBudget.");
    expect(items.map((i) => i.value)).toEqual([
      "contextBudget.systemPrompt",
      "contextBudget.responseReserve",
      "contextBudget.compactionThreshold",
      "contextBudget.compactionMinLoad",
      "contextBudget.policy",
      "contextBudget.compactionSummary",
      "contextBudget.overflowCooldown",
      "contextBudget.toolResultKeep",
      "contextBudget.calibrationWarmup",
      "contextBudget.ratioFloor",
    ]);
  });

  it("completes top-level keys and groups", () => {
    const c = new Completer();
    c.registerProvider(new ConfigKeyProvider());
    const [items] = c.complete("/config reasoning");
    const values = items.map((i) => i.value);
    expect(values).toContain("reasoning.mode");
    expect(values).toContain("reasoning.show");
  });

  it("completes enum values", () => {
    const c = new Completer();
    c.registerProvider(new ConfigValueProvider());
    const [items] = c.complete("/config reasoning.mode ");
    expect(items.map((i) => i.value)).toEqual([
      "auto",
      "default",
      "none",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });
});

describe("provider add flag completion", () => {
  it("completes flags", () => {
    const c = new Completer();
    c.registerProvider(new FlagProvider());
    const [items] = c.complete("/provider add --");
    expect(items.map((i) => i.value)).toContain("--url");
    expect(items.map((i) => i.value)).toContain("--context-window");
  });
});

describe("help command completion", () => {
  it("completes command names", () => {
    const c = new Completer();
    c.registerProvider(new CommandArgProvider(() => ["config", "context", "help"]));
    const [items] = c.complete("/help con");
    expect(items.map((i) => i.value)).toEqual(["config", "context"]);
  });
});
