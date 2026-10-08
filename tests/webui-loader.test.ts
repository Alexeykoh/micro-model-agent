// Loader faces: pure state mapping + DOM builder. `bun test` doesn't apply
// vitest's environment docblock, so happy-dom is wired manually.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { loaderStateFor, toolState, createFace, setFaceState } from "../src/modules/webui/assets/js/loader.js";
import type { FaceState } from "../src/modules/webui/assets/js/loader.js";

beforeAll(() => {
  const win = new Window();
  Object.assign(globalThis, { document: win.document, window: win });
});

describe("loaderStateFor", () => {
  it("maps tool names to states", () => {
    expect(toolState("read_file")).toBe("read");
    expect(toolState("grep")).toBe("find");
    expect(toolState("web_search")).toBe("web");
    expect(toolState("edit_file")).toBe("edit");
    expect(toolState("write_file")).toBe("create");
    expect(toolState("bash")).toBe("run");
    expect(toolState("subagent")).toBe("run");
    expect(toolState("unknown_tool")).toBe("run");
  });

  it("maps lifecycle signals", () => {
    expect(loaderStateFor({ type: "turn_end", success: true })).toBe("done");
    expect(loaderStateFor({ type: "turn_end", success: false })).toBe("error");
    expect(loaderStateFor({ type: "error" })).toBe("error");
    expect(loaderStateFor({ type: "question" })).toBe("ask");
    expect(loaderStateFor({ type: "text" })).toBe("type");
    expect(loaderStateFor({ type: "tool_start", name: "edit_file" })).toBe("edit");
    expect(loaderStateFor({ type: "phase", phase: "thinking" })).toBe("think");
  });
});

describe("createFace / setFaceState", () => {
  it("builds eyes + every extra, hidden by default", () => {
    const face = createFace("think", "sm");
    expect(face.classList.contains("mdl")).toBe(true);
    expect(face.classList.contains("sm")).toBe(true);
    expect(face.querySelectorAll(".eye").length).toBe(2);
    expect(face.querySelector(".orb")).not.toBeNull();
    expect(face.querySelector(".keys")).not.toBeNull();
    expect(face.querySelector(".star")).not.toBeNull();
  });

  it("swaps state classes without recreating the eyes", () => {
    const face = createFace("think", "sm");
    const eyes = face.querySelector(".eyes");
    setFaceState(face, "error");
    expect(face.dataset.state).toBe("error");
    expect(face.classList.contains("st-error")).toBe(true);
    expect(face.classList.contains("mdl")).toBe(true);
    expect(face.classList.contains("sm")).toBe(true);
    expect(face.querySelector(".eyes")).toBe(eyes);
  });

  it("keeps size when state changes to one without it", () => {
    const face = createFace("idle", "lg");
    setFaceState(face, "boot" as FaceState);
    expect(face.classList.contains("lg")).toBe(true);
    expect(face.classList.contains("st-boot")).toBe(true);
  });
});

describe("boot splash asset", () => {
  it("index.html declares #bootSplash", () => {
    const html = readFileSync("src/modules/webui/assets/index.html", "utf8");
    expect(html).toContain('id="bootSplash"');
  });
  it("styles.css defines the loader component", () => {
    const css = readFileSync("src/modules/webui/assets/styles.css", "utf8");
    expect(css).toContain(".mdl.st-read");
    expect(css).toContain("#bootSplash");
  });
});
