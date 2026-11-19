import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { agentsMdPaths, nestedAgentsMdPaths, loadAgentsMdBlocks } from "../src/core/bootstrap/state";

function ws(): string {
  const d = mkdtempSync(join(tmpdir(), "mma-agents-"));
  return d;
}

describe("nested AGENTS.md (F-01)", () => {
  it("находит вложенный site/AGENTS.md после корневых", () => {
    const base = ws();
    writeFileSync(join(base, "AGENTS.md"), "root rules");
    mkdirSync(join(base, "site"));
    writeFileSync(join(base, "site", "AGENTS.md"), "next rules");
    const paths = agentsMdPaths(base, "/nonexistent-config");
    expect(paths[0]).toBe(join(base, "AGENTS.md"));
    expect(paths).toContain(join(base, "site", "AGENTS.md"));
    expect(paths.indexOf(join(base, "site", "AGENTS.md"))).toBeLessThan(
      paths.indexOf(join("/nonexistent-config", "AGENTS.md")),
    );
  });

  it("корневой AGENTS.md не дублируется через nested-обход", () => {
    const base = ws();
    writeFileSync(join(base, "AGENTS.md"), "root rules");
    mkdirSync(join(base, "site"));
    writeFileSync(join(base, "site", "AGENTS.md"), "next rules");
    const paths = agentsMdPaths(base, "/nonexistent-config");
    expect(paths.filter((p) => p === join(base, "AGENTS.md"))).toHaveLength(1);
    expect(new Set(paths).size).toBe(paths.length);
    const blocks = loadAgentsMdBlocks(base, "/nonexistent-config", false);
    expect(blocks.filter((b) => b.content === "root rules")).toHaveLength(1);
  });

  it("скипает node_modules и .git", () => {
    const base = ws();
    mkdirSync(join(base, "node_modules", "x"), { recursive: true });
    writeFileSync(join(base, "node_modules", "x", "AGENTS.md"), "noise");
    mkdirSync(join(base, ".git"));
    writeFileSync(join(base, ".git", "AGENTS.md"), "noise");
    mkdirSync(join(base, "site"));
    writeFileSync(join(base, "site", "AGENTS.md"), "real");
    const found = nestedAgentsMdPaths(base);
    expect(found).toEqual([join(base, "site", "AGENTS.md")]);
  });

  it("кап 5 вложенных", () => {
    const base = ws();
    for (let i = 0; i < 8; i++) {
      mkdirSync(join(base, `d${i}`));
      writeFileSync(join(base, `d${i}`, "AGENTS.md"), `rules ${i}`);
    }
    expect(nestedAgentsMdPaths(base)).toHaveLength(5);
  });

  it("loadAgentsMdBlocks помечает вложенный относительным путём", () => {
    const base = ws();
    writeFileSync(join(base, "AGENTS.md"), "root rules");
    mkdirSync(join(base, "site"));
    writeFileSync(join(base, "site", "AGENTS.md"), "next rules");
    const blocks = loadAgentsMdBlocks(base, "/nonexistent-config", false);
    const nested = blocks.find((b) => b.content === "next rules");
    expect(nested?.label).toBe("instructions (site/)");
  });

  it("skip=true даёт пусто", () => {
    const base = ws();
    writeFileSync(join(base, "AGENTS.md"), "root rules");
    expect(loadAgentsMdBlocks(base, "/nonexistent-config", true)).toEqual([]);
  });
});
