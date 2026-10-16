import { describe, expect, it } from "vitest";
import { inferExtraToolTags, KNOWN_TOOL_TAGS } from "../../src/tools/auto-tags";

describe("document tag", () => {
  it("тег известен", () => {
    expect([...KNOWN_TOOL_TAGS]).toContain("document");
  });
  it("таблица/документ сеет тег document в research-задаче", () => {
    expect(inferExtraToolTags("прочитай таблицу из report.xlsx и summarise")).toContain("document");
  });
});
