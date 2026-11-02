import { describe, expect, it } from "vitest";
import {
  FILE_CONTENT_MASK,
  tagFileContent,
  visibleFileContent,
} from "../../src/modules/security/data-policy/file-content";

describe("производные каналы не видят защищённое содержимое", () => {
  const secret = "PAYLOAD CANARY_live_demo";

  it("дайджест/критик/evidence получают [FILE] вместо tagged-вывода", () => {
    expect(visibleFileContent(tagFileContent(secret))).toBe(FILE_CONTENT_MASK);
  });

  it("тег снят/обычный текст проходят без изменений", () => {
    expect(visibleFileContent(secret)).toBe(secret);
    expect(visibleFileContent("abc", 2)).toBe("ab");
  });

  it("срез по капу не раскрывает tagged-вывод", () => {
    expect(visibleFileContent(tagFileContent(secret), 5)).toBe(FILE_CONTENT_MASK);
  });
});
