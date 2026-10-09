// DOM coverage for the footer line under the composer: workspace path, MoE mode
// chip and agent version. The renderer is a leaf module taking its element as an
// argument, so the test needs no `dom.js` (whose element handles are captured
// once per process and would leak between test files).
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

const draw = (input: Partial<Parameters<typeof renderFooter>[1]> = {}) =>
  renderFooter(line, { dirLabel: "dir", ...input }, make);

describe("workspace footer line", () => {
  it("renders dir + path and the version", () => {
    draw({ workspace: "E:\\projects\\demo", version: "2.29.1" });
    expect(line.hidden).toBe(false);
    expect(line.querySelector(".ws-k")?.textContent).toBe("dir");
    expect(line.querySelector(".ws-v")?.textContent).toBe("E:\\projects\\demo");
    expect(line.querySelector(".ws-ver")?.textContent).toBe("mma 2.29.1");
    expect(line.querySelector(".ws-ver")?.getAttribute("title")).toBe(
      "micro-models-agent 2.29.1",
    );
  });

  it("shows the version even without a workspace path", () => {
    draw({ version: "2.29.0" });
    expect(line.hidden).toBe(false);
    expect(line.querySelector(".ws-k")).toBeNull();
    expect(line.querySelector(".ws-ver")?.textContent).toBe("mma 2.29.0");
  });

  it("hides the line when there is nothing to show", () => {
    draw({});
    expect(line.hidden).toBe(true);
    expect(line.children.length).toBe(0);
  });

  it("rebuilds when the version changes but not on an identical snapshot", () => {
    draw({ workspace: "E:\\p", version: "2.29.1" });
    draw({ workspace: "E:\\p", version: "2.29.1" });
    const first = line.querySelector(".ws-ver");
    expect(line.children.length).toBe(3);

    draw({ workspace: "E:\\p", version: "2.30.0" });
    expect(line.querySelector(".ws-ver")).not.toBe(first);
    expect(line.querySelector(".ws-ver")?.textContent).toBe("mma 2.30.0");
  });

  it("lights the MoE chip only while MoE runs the turn", () => {
    draw({ workspace: "E:\\p", version: "2.29.1" });
    expect(line.querySelector(".ws-moe")).toBeNull();

    draw({ workspace: "E:\\p", version: "2.29.1", moeActive: true });
    expect(line.hidden).toBe(false);
    expect(line.querySelector(".ws-moe")?.textContent).toBe("MoE");

    // Плановый снимок без флага гасит чип: MoE отдал ход одиночному циклу.
    draw({ workspace: "E:\\p", version: "2.29.1" });
    expect(line.querySelector(".ws-moe")).toBeNull();
  });

  it("keeps the chip visible without a version", () => {
    draw({ moeActive: true });
    expect(line.hidden).toBe(false);
    expect(line.querySelector(".ws-moe")?.textContent).toBe("MoE");
  });

  it("shows an update chip with the new version and the install hint", () => {
    draw({
      workspace: "E:\\p",
      version: "2.36.0",
      updateAvailable: { current: "2.36.0", latest: "2.37.0" },
      updateTitle: "npm install -g micro-models-agent@2.37.0",
    });
    expect(line.hidden).toBe(false);
    const chip = line.querySelector(".ws-upd");
    expect(chip?.textContent).toBe("↑ 2.37.0");
    expect(chip?.getAttribute("title")).toBe("npm install -g micro-models-agent@2.37.0");
    // Installed version stays next to it: "newer is available / this is yours".
    expect(line.querySelector(".ws-ver")?.textContent).toBe("mma 2.36.0");
  });

  it("keeps the update chip visible without a workspace path", () => {
    draw({ updateAvailable: { current: "2.36.0", latest: "2.37.0" } });
    expect(line.hidden).toBe(false);
    expect(line.querySelector(".ws-upd")?.textContent).toBe("↑ 2.37.0");
  });

  it("drops the update chip once the notice is gone", () => {
    draw({ version: "2.37.0", updateAvailable: { current: "2.36.0", latest: "2.37.0" } });
    expect(line.querySelector(".ws-upd")).not.toBeNull();

    draw({ version: "2.37.0" });
    expect(line.querySelector(".ws-upd")).toBeNull();
  });

  it("coexists with the MoE chip", () => {
    draw({
      version: "2.36.0",
      moeActive: true,
      updateAvailable: { current: "2.36.0", latest: "2.37.0" },
    });
    expect(line.querySelector(".ws-moe")?.textContent).toBe("MoE");
    expect(line.querySelector(".ws-upd")?.textContent).toBe("↑ 2.37.0");
  });
});