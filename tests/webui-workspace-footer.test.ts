// DOM coverage for the footer line under the composer: workspace path + agent
// version. The renderer is a leaf module taking its element as an argument, so
// the test needs no `dom.js` (whose element handles are captured once per
// process and would leak between test files).
// `bun test` doesn't apply vitest's environment docblock, so happy-dom is wired
// manually (tests/helpers/happy-dom.ts).
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom("");
const { renderFooter } = await import("../src/modules/webui/assets/js/footer.js");

const make = (cls: string, text: string): HTMLElement => {
  const el = win.document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
};

let line: HTMLElement;
beforeEach(() => {
  line = win.document.createElement("div");
  line.className = "ws-line";
  line.hidden = true;
  win.document.body.appendChild(line);
});

const draw = (ws: string, version: string) =>
  renderFooter(line, ws, version, "dir", make);

describe("workspace footer line", () => {
  it("renders dir + path and the version", () => {
    draw("E:\\projects\\demo", "2.29.1");
    expect(line.hidden).toBe(false);
    expect(line.querySelector(".ws-k")?.textContent).toBe("dir");
    expect(line.querySelector(".ws-v")?.textContent).toBe("E:\\projects\\demo");
    expect(line.querySelector(".ws-ver")?.textContent).toBe("mma 2.29.1");
    expect(line.querySelector(".ws-ver")?.getAttribute("title")).toBe(
      "micro-models-agent 2.29.1",
    );
  });

  it("shows the version even without a workspace path", () => {
    draw("", "2.29.0");
    expect(line.hidden).toBe(false);
    expect(line.querySelector(".ws-k")).toBeNull();
    expect(line.querySelector(".ws-ver")?.textContent).toBe("mma 2.29.0");
  });

  it("hides the line when neither path nor version is known", () => {
    draw("", "");
    expect(line.hidden).toBe(true);
    expect(line.children.length).toBe(0);
  });

  it("rebuilds when the version changes but not on an identical snapshot", () => {
    draw("E:\\p", "2.29.1");
    draw("E:\\p", "2.29.1");
    const first = line.querySelector(".ws-ver");
    expect(line.children.length).toBe(3);

    draw("E:\\p", "2.30.0");
    expect(line.querySelector(".ws-ver")).not.toBe(first);
    expect(line.querySelector(".ws-ver")?.textContent).toBe("mma 2.30.0");
  });
});