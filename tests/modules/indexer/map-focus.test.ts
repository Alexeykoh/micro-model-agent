import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { focusRanks, FOCUS_RANK_NONE } from "../../../src/modules/indexer/rank";
import { IndexerModule } from "../../../src/modules/indexer";
import { t } from "../../../src/i18n/index";
import type { IndexedFile } from "../../../src/modules/indexer/walker";

function file(path: string, exports: string[] = []): IndexedFile {
  return { path, language: "typescript", exports, symbols: [], size: 10, mtimeMs: 1 } as IndexedFile;
}

describe("focus ranks", () => {
  it("соседи по папке первые, чужой файл последний, порядок детерминирован", () => {
    const files = [
      file("src/core/agent.ts", ["Agent"]),
      file("src/core/sibling.ts", ["sibling"]),
      file("src/core/agent/loop.ts", ["loop"]),
      file("src/diff/other.ts", ["other"]),
    ];
    const ranks = focusRanks(files, "src/core/agent.ts");
    expect(ranks.get("src/core/agent.ts")).toBe(0);
    expect(ranks.get("src/core/sibling.ts")).toBe(1);
    expect(ranks.get("src/core/agent/loop.ts")).toBe(2);
    expect(ranks.get("src/diff/other.ts")).toBe(FOCUS_RANK_NONE);
    const again = focusRanks([...files].reverse(), "src/core/agent.ts");
    expect([...ranks.entries()].sort()).toEqual([...again.entries()].sort());
  });

  it("несуществующий focus не даёт релевантных файлов", () => {
    const ranks = focusRanks([file("src/a.ts")], "src/missing.ts");
    expect(ranks.get("src/a.ts")).toBe(FOCUS_RANK_NONE);
  });

  it("несуществующий focus без расширения не возвышает одноимённую папку", () => {
    const ranks = focusRanks([file("src/missing/child.ts")], "src/missing");
    expect(ranks.get("src/missing/child.ts")).toBe(FOCUS_RANK_NONE);
  });

  it("общий экспорт даёт ранг 3 после соседей и потомков", () => {
    const files = [
      file("src/a/a.ts", ["shared"]),
      file("src/b/b.ts", ["shared"]),
      file("src/c/c.ts", ["c"]),
    ];
    const ranks = focusRanks(files, "src/a/a.ts");
    expect(ranks.get("src/b/b.ts")).toBe(3);
    expect(ranks.get("src/c/c.ts")).toBe(FOCUS_RANK_NONE);
  });
});

describe("project_map action=map", () => {
  it("показывает файл focus и его соседей раньше чужих и отвергает несуществующий путь", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-mapfocus-"));
    try {
      mkdirSync(join(dir, "src/core/agent"), { recursive: true });
      mkdirSync(join(dir, "src/diff"), { recursive: true });
      writeFileSync(join(dir, "src/core/agent.ts"), "export const Agent = 1;");
      writeFileSync(join(dir, "src/core/sibling.ts"), "export const sibling = 1;");
      writeFileSync(join(dir, "src/core/agent/loop.ts"), "export const loop = 1;");
      writeFileSync(join(dir, "src/diff/other.ts"), "export const other = 1;");
      const mod = new IndexerModule({
        baseDir: dir,
        cacheDir: join(dir, ".mma"),
        promptMapMode: "stub",
      });
      await mod.buildIndex();
      const tool = mod.getToolDefinitions()[0];
      const schema = tool.parameters as {
        properties: Record<string, { type?: string; description?: string }>;
      };
      expect(schema.properties.focus).toMatchObject({ type: "string" });
      expect(schema.properties.focus.description).toBeTruthy();

      const res = await tool.handler({} as never, { action: "map", focus: "src/core/agent.ts" });
      expect(res.success).toBe(true);
      for (const path of [
        "src/core/agent.ts",
        "src/core/sibling.ts",
        "src/core/agent/loop.ts",
        "src/diff/other.ts",
      ]) {
        expect(res.output).toContain(path);
      }
      expect(res.output.indexOf("src/core/sibling.ts")).toBeLessThan(
        res.output.indexOf("src/diff/other.ts"),
      );
      expect(res.output.indexOf("src/core/agent/loop.ts")).toBeLessThan(
        res.output.indexOf("src/diff/other.ts"),
      );
      const legacy = await tool.handler({} as never, { action: "map", query: "src/core/agent.ts" });
      expect(legacy.output).toBe(res.output);
      const emptyFocus = await tool.handler({} as never, {
        action: "map",
        query: "src/core/agent.ts",
        focus: "",
      });
      expect(emptyFocus.output).toBe(res.output);

      const found = await tool.handler({} as never, { action: "find", query: "sibling" });
      const foundWithFocus = await tool.handler({} as never, {
        action: "find",
        query: "sibling",
        focus: "",
      });
      expect(found.success).toBe(true);
      expect(foundWithFocus.success).toBe(true);
      expect(foundWithFocus.output).toBe(found.output);

      const bad = await tool.handler({} as never, { action: "map", focus: "src/missing.ts" });
      expect(bad.success).toBe(false);
      expect(bad.output).toBe(t("indexer.focus_unknown", { path: "src/missing.ts" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
