// DOM-покрытие блока пользователя (`userBlock`): вложения — строкой над
// текстом, маркер `> ` остаётся на тексте, картинки vs файловые чипы.
// `bun test` не применяет vitest-докблок окружения — happy-dom вручную.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom(`<div id="msgs" class="msgs"></div>`);

const { userBlock } = await import("../src/modules/webui/assets/js/feed/core.js");

const IMG = "data:image/png;base64,AAAA";

describe("userBlock attachments", () => {
  it("stacks an image strip above the text", () => {
    const node = userBlock("look", [IMG]);
    const kids = [...node.children].map((c) => c.className);
    expect(kids[0]).toBe("u-attach");
    expect(kids[1]).toBe("u-text");
    expect(node.querySelector(".u-attach img.uimg")).toBeTruthy();
    expect(node.querySelector(".u-text")?.textContent).toBe("look");
  });

  it("renders multiple images and a file chip, in order", () => {
    const node = userBlock("x", [IMG, "/api/sessions/s1/images/a.png", "data:application/pdf;base64,AAAA"]);
    // data:image + relative `/api/.../a.png` resolve to thumbnails.
    expect(node.querySelectorAll(".uimg").length).toBe(2);
    const chips = node.querySelectorAll(".u-file");
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain("application/pdf");
  });

  it("renders just text without attachments", () => {
    const node = userBlock("hi");
    expect(node.querySelector(".u-attach")).toBeNull();
    expect(node.querySelector(".u-text")?.textContent).toBe("hi");
  });
});
