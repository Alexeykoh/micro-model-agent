// Loader faces: pure state mapping + DOM builder. `bun test` doesn't apply
// vitest's environment docblock, so happy-dom is wired manually.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import {
  loaderStateFor, toolState, createFace, setFaceState, setGreetResolver,
  MMART_NAME, initCursor,
} from "../src/modules/webui/assets/js/loader.js";
import type { FaceState } from "../src/modules/webui/assets/js/loader.js";

let win: Window;
beforeAll(() => {
  win = new Window();
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
    expect(loaderStateFor({ type: "retract" })).toBe("error");
    expect(loaderStateFor({ type: "question" })).toBe("ask");
    expect(loaderStateFor({ type: "text" })).toBe("type");
    expect(loaderStateFor({ type: "tool_start", name: "edit_file" })).toBe("edit");
    expect(loaderStateFor({ type: "phase", phase: "thinking" })).toBe("think");
  });

  it("covers every core tool with a behavioural state", () => {
    // user interaction
    expect(toolState("approve")).toBe("ask");
    expect(toolState("question")).toBe("ask");
    // web browsing
    expect(toolState("web_browse")).toBe("web");
    // memory / knowledge / introspection
    expect(toolState("load_skill")).toBe("read");
    expect(toolState("session_info")).toBe("read");
    expect(toolState("search_history")).toBe("find");
    expect(toolState("remember")).toBe("create");
    expect(toolState("define_capability")).toBe("create");
    expect(toolState("set_thinking")).toBe("think");
    // onboarding sentinel
    expect(toolState("meet_done")).toBe("done");
  });

  it("reacts to agent-facing SSE and ignores background broadcasts", () => {
    expect(loaderStateFor({ type: "index" })).toBe("find");
    expect(loaderStateFor({ type: "setup_done" })).toBe("done");
    for (const bg of ["usage", "state", "config", "files", "sessions", "plugins", "log"] as const) {
      expect(loaderStateFor({ type: bg })).toBe("idle");
    }
  });

  it("celebrates an available update instead of ignoring it as background", () => {
    // `update` is news for the user, so it must NOT collapse to idle the way
    // the background broadcasts do.
    expect(loaderStateFor({ type: "update" })).toBe("update");
  });

  it("update face is sparkly but does not greet or follow the cursor", () => {
    const face = createFace("update", "lg");
    expect(face.classList.contains("st-update")).toBe(true);
    expect(face.classList.contains("happy")).toBe(true);
    // No `track`/`poke`: the mascot must not chase the mouse or pop its
    // greeting over the update chip while advertising something.
    expect(face.classList.contains("track")).toBe(false);
    expect(face.classList.contains("poke")).toBe(false);
  });

  it("styles the update state", () => {
    const css = readFileSync("src/modules/webui/assets/styles.css", "utf8");
    expect(css).toContain(".mdl.st-update");
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

describe("MMART greeting", () => {
  beforeAll(() => {
    // One-shot wiring of the window listeners; must run before dispatching.
    initCursor();
  });

  it("carries a tip element in every face", () => {
    const tip = createFace("idle", "lg").querySelector<HTMLElement>(".mdl-tip");
    expect(tip).not.toBeNull();
    expect(MMART_NAME).toBe("MMART");
  });

  it("localizes the greeting through the injected resolver", () => {
    const face = createFace("idle", "lg");
    document.body.appendChild(face);
    setGreetResolver(() => "Hola MMART");
    face.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(face.querySelector(".mdl-tip")?.textContent).toBe("Hola MMART");
    expect(face.classList.contains("show-tip")).toBe(true);
  });

  it("only greets when the click lands on the face itself", () => {
    const face = createFace("idle", "lg");
    document.body.appendChild(face);
    document.body.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(face.classList.contains("show-tip")).toBe(false);
    face.querySelector(".eyes")?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(face.classList.contains("show-tip")).toBe(true);
  });

  it("does not greet a working face (idle-only `.poke`)", () => {
    const face = createFace("run", "lg");
    document.body.appendChild(face);
    face.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(face.classList.contains("show-tip")).toBe(false);
  });

  afterAll(() => {
    setGreetResolver(() => `Привет! Я ${MMART_NAME}`);
  });
});
