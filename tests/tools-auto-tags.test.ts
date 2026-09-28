import { describe, it, expect } from "vitest";
import { inferExtraToolTags, seedToolTags } from "../src/tools/auto-tags";
import { filterToolsByTags } from "../src/tools/filter-tools";
import { questionTool } from "../src/tools/question";
import { approveTool } from "../src/tools/approve";

describe("inferExtraToolTags (P5)", () => {
  it("returns nothing for trivial chat", () => {
    expect(inferExtraToolTags("привет, как дела?")).toEqual([]);
    expect(inferExtraToolTags("what is 2+2?")).toEqual([]);
    expect(inferExtraToolTags("")).toEqual([]);
  });

  it("detects research intent (en+ru)", () => {
    expect(inferExtraToolTags("найди в интернете варианты велосипедов")).toContain("research");
    expect(inferExtraToolTags("search the web for TypeScript docs")).toContain("research");
    expect(inferExtraToolTags("какая погода в Москве? https://example.com")).toContain("research");
  });

  it("detects browser intent with vision", () => {
    const tags = inferExtraToolTags("сделай скриншот страницы через browser");
    expect(tags).toContain("browser");
    expect(tags).toContain("vision");
  });

  it("detects shell/process intent", () => {
    expect(inferExtraToolTags("запусти dev server в background")).toContain("shell");
    expect(inferExtraToolTags("check background processes")).toContain("shell");
  });

  it("detects memory intent", () => {
    expect(inferExtraToolTags("запомни мой день рождения")).toContain("memory");
    expect(inferExtraToolTags("remember my preferences")).toContain("memory");
  });

  it("detects vision/image intent", () => {
    const tags = inferExtraToolTags("разбери это фото: что на картинке?");
    expect(tags).toContain("vision");
    expect(tags).toContain("image");
  });

  it("does not add file/code (defaults)", () => {
    expect(inferExtraToolTags("отредактируй файл кода")).not.toContain("file");
    expect(inferExtraToolTags("отредактируй файл кода")).not.toContain("code");
  });
});

describe("seedToolTags (P5)", () => {
  it("adds inferred tags without removing defaults", () => {
    const active = ["file", "code"];
    const added = seedToolTags(active, "найди в интернете новости");
    expect(added).toEqual(["research"]);
    expect(active).toEqual(["file", "code", "research"]);
  });

  it("never duplicates and preserves enable_tools grants", () => {
    const active = ["file", "code", "research"];
    expect(seedToolTags(active, "найди новости")).toEqual([]);
    expect(active).toEqual(["file", "code", "research"]);
  });

  it("is a no-op for trivial input and legacy mode", () => {
    const active = ["file", "code"];
    expect(seedToolTags(active, "привет")).toEqual([]);
    expect(active).toEqual(["file", "code"]);
    expect(seedToolTags(undefined, "найди новости")).toEqual([]);
  });

  it("seeded tags unlock hidden tools via the tag filter", () => {
    const tools = [
      { name: "read_file", description: "r", parameters: {}, tags: ["file"] },
      { name: "web_search", description: "w", parameters: {}, tags: ["research"] },
      { name: "plan", description: "p", parameters: {}, alwaysOn: true },
    ];
    const active = ["file", "code"];
    seedToolTags(active, "найди новости");
    const names = filterToolsByTags(tools, active).map((t) => t.name);
    expect(names).toContain("web_search");
  });
});

describe("interactive tools survive narrowing (P5)", () => {
  it("question/approve are alwaysOn", () => {
    expect(questionTool.alwaysOn).toBe(true);
    expect(approveTool.alwaysOn).toBe(true);
  });
});
