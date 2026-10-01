import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FactualCheck } from "../src/modules/hallucination/factual";

describe("FactualCheck", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-factual-"));
    writeFileSync(join(dir, "config.json"), "{}");
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "src", "utils"), { recursive: true });
    mkdirSync(join(dir, "src", "data"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export const x = 1");
    writeFileSync(join(dir, "src", "utils", "helper.ts"), "export const y = 2");
    writeFileSync(join(dir, "src", "data", "bikes.json"), "{}");
    writeFileSync(join(dir, "SECURITY.md"), "# Security");
    writeFileSync(join(dir, "report 1.txt"), "ok");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes when a bare file name exists in a subdirectory", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("Bike data lives in bikes.json");
    expect(result.status).toBe("pass");
  });

  it("passes when a bare file name exists only in a nested subdirectory", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("See helper.ts for details");
    expect(result.status).toBe("pass");
  });

  it("passes when absolute Windows path matches an existing file", () => {
    const check = new FactualCheck(dir);
    const win = `${dir.replace(/\//g, "\\")}\\config.json`;
    const result = check.validate(`Created ${win} and SECURITY.md`);
    expect(result.status).toBe("pass");
  });

  it("warns for a fake absolute Windows path", () => {
    const check = new FactualCheck(dir);
    const fake = `${dir.replace(/\//g, "\\")}\\ghost.ts`;
    const result = check.validate(`Wrote ${fake}`);
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("ghost.ts");
  });

  it("does not flag technology names like Node.js", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("Used Node.js runtime for the build");
    expect(result.status).toBe("pass");
  });

  it("does not flag JS method calls like prev.map or todos.map", () => {
    const check = new FactualCheck(dir);
    const result = check.validate(
      "setTodos((prev) => [...prev, x]); todos.map((t) => t.text); prev.map((t) => t)",
    );
    expect(result.status).toBe("pass");
  });

  it("still warns on a past-tense claim about a missing file", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("Создал src/NopeComponent.tsx и обновил импорты");
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("NopeComponent.tsx");
  });

  it("does not warn when a filename contains a space", () => {
    // «report 1.txt» извлекается токеном «1.txt» — файл существует.
    const check = new FactualCheck(dir);
    const result = check.validate("Created report 1.txt successfully");
    expect(result.status).toBe("pass");
  });

  it("does not flag country-TLD domain names like Gismeteo.by as files", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("For weather, try Gismeteo.by or weather.com.");
    expect(result.status).toBe("pass");
  });

  it("passes for existing relative paths", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("See src/index.ts and src/utils/helper.ts");
    expect(result.status).toBe("pass");
  });

  it("warns for a missing relative path", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("Created src/ghost.ts");
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("src/ghost.ts");
  });

  it("warns for a bare file name that exists nowhere", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("Updated phantom.json");
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("phantom.json");
  });

  it("passes on a response with no file paths", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("Everything is done, no issues.");
    expect(result.status).toBe("pass");
  });

  it("does not flag JS member access like process.env / console.log", () => {
    const check = new FactualCheck(dir);
    const result = check.validate(
      "The script reads process.env.NODE_ENV, logs via console.log and exits with process.exit(1).",
    );
    expect(result.status).toBe("pass");
  });

  it("passes when a dotfile is mentioned without its leading dot", () => {
    writeFileSync(join(dir, ".prettierrc.json"), "{}");
    const check = new FactualCheck(dir);
    // The token regex cannot anchor a leading dot, so ".prettierrc.json"
    // is extracted as "prettierrc.json" — must not be flagged as missing.
    const result = check.validate("Settings live in .prettierrc.json");
    expect(result.status).toBe("pass");
  });

  it("still warns for a genuine bare missing file", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("Data is stored in ghost.json");
    expect(result.status).toBe("warn");
  });

  it("passes for bare names added via addKnownFiles (compaction summary)", () => {
    const check = new FactualCheck(dir);
    // Component16.tsx is NOT on disk — only in a compaction summary
    check.addKnownFiles(["Component16.tsx", "Component17.tsx"]);
    const result = check.validate("Updated Component16.tsx and Component17.tsx");
    expect(result.status).toBe("pass");
  });

  it("still warns for a bare name not in known files and not on disk", () => {
    const check = new FactualCheck(dir);
    check.addKnownFiles(["Component16.tsx"]);
    const result = check.validate("Updated ghost.tsx");
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("ghost.tsx");
  });

  it("passes for paths from known files even when directory is ignored", () => {
    const check = new FactualCheck(dir);
    // _testing/ is in IGNORED_DIRS — bare name scan won't find it
    check.addKnownFiles(["_testing/compaction-test/Component16.tsx"]);
    const result = check.validate("Updated Component16.tsx");
    expect(result.status).toBe("pass");
  });

  it("passes when a dot-prefixed directory component is mentioned without the dot", () => {
    mkdirSync(join(dir, ".mma"), { recursive: true });
    writeFileSync(join(dir, ".mma", "index-cache.json"), "{}");
    const check = new FactualCheck(dir);
    // The regex strips the leading dot from .mma/ → "mma/index-cache.json"
    // dotfileVariants must try ".mma/index-cache.json" as a candidate.
    const result = check.validate("Read mma/index-cache.json for cache data");
    expect(result.status).toBe("pass");
  });

  it("passes when a nested dot-prefixed directory is mentioned", () => {
    mkdirSync(join(dir, "src", ".config"), { recursive: true });
    writeFileSync(join(dir, "src", ".config", "settings.json"), "{}");
    const check = new FactualCheck(dir);
    // "src/.config/settings.json" — dot already present, should pass directly
    const result = check.validate("Read src/.config/settings.json");
    expect(result.status).toBe("pass");
  });

  it("passes when a nested dot-prefixed directory is mentioned without dot", () => {
    mkdirSync(join(dir, "app", ".hidden"), { recursive: true });
    writeFileSync(join(dir, "app", ".hidden", "data.json"), "{}");
    const check = new FactualCheck(dir);
    // "app/hidden/data.json" → must try "app/.hidden/data.json"
    const result = check.validate("Updated app/hidden/data.json");
    expect(result.status).toBe("pass");
  });

  it("passes when a deleted file is mentioned in the response", () => {
    const check = new FactualCheck(dir);
    // Create a file, then delete it from disk — but tell FactualCheck it was deleted
    const tmpFile = join(dir, "to-delete.txt");
    writeFileSync(tmpFile, "temp");
    rmSync(tmpFile);
    const deletedFiles = new Set([tmpFile]);
    const result = check.validate("Removed to-delete.txt successfully", deletedFiles);
    expect(result.status).toBe("pass");
  });

  it("still warns for a file that was never on disk even with deletedFiles set", () => {
    const check = new FactualCheck(dir);
    // phantom.json was never on disk and is not in deletedFiles
    const deletedFiles = new Set(["/some/other/deleted-file.txt"]);
    const result = check.validate("Removed phantom.json", deletedFiles);
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("phantom.json");
  });

  it("passes when a bare filename matches a deleted file's basename", () => {
    const check = new FactualCheck(dir);
    // Create a file in a subdirectory, then delete it
    const nested = join(dir, "deep", "nested", "target.json");
    mkdirSync(join(dir, "deep", "nested"), { recursive: true });
    writeFileSync(nested, "{}");
    rmSync(nested);
    rmSync(join(dir, "deep", "nested"), { recursive: true });
    rmSync(join(dir, "deep"), { recursive: true });
    // The token regex extracts "target.json" — deletedFiles has the full path
    const deletedFiles = new Set([nested]);
    const result = check.validate("Cleaned up target.json", deletedFiles);
    expect(result.status).toBe("pass");
  });

  it("passes when a relative path is a suffix of the real path (ses_mup6p61q)", () => {
    // Кейс сессии: «webui/state.ts» при реальном src/modules/webui/state.ts
    // давал ложный warn. Здесь: «utils/helper.ts» при src/utils/helper.ts.
    const check = new FactualCheck(dir);
    const result = check.validate("Updated utils/helper.ts and data/bikes.json");
    expect(result.status).toBe("pass");
  });

  it("still warns on a suffix that matches nothing", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("Updated utils/ghost.ts");
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("ghost.ts");
  });
});
