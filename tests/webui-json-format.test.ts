// Просмотр файлов: JSON/JSONC показывается отформатированным, без потери
// комментариев и строк, при этом переход из LSP по номеру строки остаётся верным.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="body"></div>`);

const fmt = await import("../src/modules/webui/assets/js/sidebar/files/json-format.js");
const view = await import("../src/modules/webui/assets/js/sidebar/files/view.js");

describe("webui: форматирование JSON в просмотрщике", () => {
  it("однотрочечный JSON получает отступы и переносы", () => {
    const { text } = fmt.formatJson('{"compilerOptions":{"target":"ES2022","module":"ES2022"}}');
    expect(text).toBe(
      [
        "{",
        '  "compilerOptions": {',
        '    "target": "ES2022",',
        '    "module": "ES2022"',
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("массивы и пустые контейнеры форматируются", () => {
    expect(fmt.formatJson('{"a":[1,2],"e":{}}').text).toBe(
      ["{", '  "a": [', "    1,", "    2", "  ],", '  "e": {}', "}"].join("\n"),
    );
  });

  it("комментарии JSONC и строки с //, { и , сохраняются", () => {
    const src = '{/* hi */ "url": "http://x/{a,b}", /*x*/ "n": 1 // tail\n}';
    const { text } = fmt.formatJson(src);
    expect(text).toContain('"url": "http://x/{a,b}"');
    expect(text).toContain("/* hi */");
    expect(text).toContain("/*x*/");
    expect(text).toContain("// tail");
  });

  it("lineMap переводит исходную строку в строку отображения", () => {
    // Уже отформатированный файл — карта тождественна.
    expect(fmt.formatJson('{\n  "a": 1,\n  "b": 2\n}').lineMap).toEqual([1, 2, 3, 4]);
    // Сжатый файл: вторая исходная строка оказалась третьей в показанном тексте.
    const { text, lineMap } = fmt.formatJson('{"a": 1,\n"b": 2}');
    expect(text.split("\n")).toEqual(["{", '  "a": 1,', '  "b": 2', "}"]);
    expect(lineMap).toEqual([1, 3]);
    expect(fmt.mapLine(lineMap, 2)).toBe(3);
    expect(fmt.mapLine([], 7)).toBe(7); // файл без форматирования — identity
  });

  it("не-JSON не трогается, а JSON рендерится с жёлобом по форматированному тексту", () => {
    const body = win.document.querySelector("#body") as HTMLElement;
    view.paintFile(body, "a.ts", { ok: true, mime: "text/plain", text: "a\nb" });
    expect((body.querySelector(".fcode") as HTMLElement).textContent).toBe("a\nb");

    view.paintFile(body, "tsconfig.json", {
      ok: true,
      mime: "text/plain",
      text: '{"a":1,"b":2}',
    });
    const code = body.querySelector(".fcode") as HTMLElement;
    const gutter = body.querySelector(".fv-gutter") as HTMLElement;
    expect(code.textContent).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(gutter.textContent).toBe("1\n2\n3\n4");
  });

  it("paintFile возвращает lineMap для перехода из LSP", () => {
    const body = win.document.querySelector("#body") as HTMLElement;
    const lineMap = view.paintFile(body, "tsconfig.json", {
      ok: true,
      mime: "text/plain",
      text: '{"a":1}',
    });
    expect(lineMap.length).toBe(1);
    expect(fmt.mapLine(lineMap, 1)).toBe(1);
    expect(fmt.mapLine(view.paintFile(body, "a.ts", { ok: true, mime: "text/plain", text: "x\ny" }), 2)).toBe(2);
  });
});
