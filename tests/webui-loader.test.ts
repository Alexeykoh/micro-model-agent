// Loader faces: pure state mapping + DOM builder. `bun test` doesn't apply
// vitest's environment docblock, so happy-dom is wired manually.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import {
  loaderStateFor,
  toolState,
  createFace,
  setFaceState,
  setGreetResolver,
  MMART_NAME,
  initCursor,
  lspOutputSignal,
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
    expect(loaderStateFor({ type: "retract" })).toBe("recheck");
    // Пока гейт проверяет готовый ответ — своё состояние, не think/error.
    expect(loaderStateFor({ type: "verify" })).toBe("verify");
    expect(loaderStateFor({ type: "verify" })).not.toBe("error");
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

describe("LSP mascot reactions", () => {
  it("gives lsp_check its own check state", () => {
    expect(toolState("lsp_check")).toBe("check");
    expect(loaderStateFor({ type: "tool_start", name: "lsp_check" })).toBe("check");
    expect(loaderStateFor({ type: "tool_end", name: "lsp_check", success: true })).toBe("check");
  });

  it("frowns when lsp_check reports errors", () => {
    // Модуль отвечает success:false именно при найденных ошибках.
    expect(loaderStateFor({ type: "tool_end", name: "lsp_check", success: false })).toBe("warn");
  });

  it("reads the LSP verdict out of a write/edit tool output", () => {
    expect(
      loaderStateFor({
        type: "tool_end",
        name: "write_file",
        success: true,
        output: "ok\n\n[LSP errors]:\n  a.ts(1,2): error: x",
      }),
    ).toBe("warn");
    expect(
      loaderStateFor({
        type: "tool_end",
        name: "edit_file",
        success: true,
        output: "ok\n\n[LSP warnings]:\n  a.ts(1,2): warning: y",
      }),
    ).toBe("edit");
    expect(
      loaderStateFor({ type: "tool_end", name: "write_file", success: true, output: "written" }),
    ).toBe("create");
  });

  it("treats a dead server as an error, not as code errors", () => {
    expect(
      loaderStateFor({
        type: "tool_end",
        name: "write_file",
        success: true,
        output: "\n\n[LSP check failed]: spawn failed",
      }),
    ).toBe("error");
    expect(
      loaderStateFor({
        type: "tool_end",
        name: "write_file",
        success: true,
        output: "\n\n[LSP disabled: unavailable]",
      }),
    ).toBe("error");
  });

  it("does not react to LSP markers on tool_start", () => {
    expect(loaderStateFor({ type: "tool_start", name: "write_file", output: "[LSP errors]" })).toBe(
      "create",
    );
  });

  it("parses the markers purely", () => {
    expect(lspOutputSignal("[LSP errors]:")).toBe("errors");
    expect(lspOutputSignal("[LSP check failed]: x")).toBe("failed");
    expect(lspOutputSignal("[LSP disabled: x]")).toBe("failed");
    expect(lspOutputSignal("[LSP warnings]:")).toBeNull();
    expect(lspOutputSignal("plain output")).toBeNull();
    expect(lspOutputSignal(undefined)).toBeNull();
  });

  it("styles the LSP states", () => {
    const css = readFileSync("src/modules/webui/assets/styles.css", "utf8");
    expect(css).toContain(".mdl.st-check");
    expect(css).toContain(".mdl.st-warn");
    // Обе реакции должны отличаться от нейтрального run.
    expect(css).not.toContain(".mdl.st-warn { animation: mdlRun");
  });

  it("renders warn as a canvas face", () => {
    const face = createFace("warn", "lg");
    expect(face.querySelector("canvas.mdl-cv")).not.toBeNull();
    expect(face.classList.contains("has-canvas")).toBe(true);
    expect(face.dataset.state).toBe("warn");
  });
});

describe("createFace / setFaceState", () => {
  it("builds a canvas face with the greeting tip", () => {
    const face = createFace("think", "sm");
    expect(face.classList.contains("mdl")).toBe(true);
    expect(face.classList.contains("sm")).toBe(true);
    expect(face.classList.contains("has-canvas")).toBe(true);
    expect(face.querySelector("canvas.mdl-cv")).not.toBeNull();
    expect(face.querySelector(".mdl-tip")).not.toBeNull();
  });

  it("swaps state classes without recreating the canvas", () => {
    const face = createFace("think", "sm");
    const canvas = face.querySelector("canvas");
    setFaceState(face, "error");
    expect(face.dataset.state).toBe("error");
    expect(face.classList.contains("st-error")).toBe(true);
    expect(face.classList.contains("mdl")).toBe(true);
    expect(face.classList.contains("sm")).toBe(true);
    expect(face.querySelector("canvas")).toBe(canvas);
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
    face.querySelector("canvas")?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
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
