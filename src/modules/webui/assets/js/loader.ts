// Loader faces — a small squircle "agent presence": eyes + extra effects,
// driven entirely by CSS state classes. One component for the boot splash,
// the in-feed busy line, the activity rail and the first-run wizard.
// The mascot is called **MMART** (MMA + art): clicking it pops a localized
// greeting bubble. See docs/specs/2026-10-08-loader-webui-design.md.

import { populateFx } from "./loader-fx.js";

export type FaceState =
  | "idle" | "think" | "read" | "find" | "web" | "edit" | "type" | "create"
  | "run" | "tests" | "compact" | "plan" | "ask" | "done" | "error" | "stop"
  | "queued" | "boot" | "load" | "update"
  // LSP: идёт статическая проверка / сервер вернул ошибки.
  | "check" | "warn";

export type FaceSize = "sm" | "lg" | "xs";

// state → modifier classes (color + animation + mood). Kept in one place so
// the feed and the rail can never diverge.
const FACE_CLASS: Record<FaceState, string> = {
  idle: "c-dim track poke blink",
  think: "c-active st-think blink",
  read: "c-recon st-read",
  find: "c-recon st-find squint",
  web: "c-recon st-web squint",
  edit: "c-mutate st-edit narrow",
  type: "c-active st-type narrow",
  create: "c-mutate st-create",
  run: "c-exec st-run",
  tests: "c-exec st-tests",
  compact: "c-active st-compact",
  plan: "c-active st-plan",
  ask: "c-warn st-ask wide",
  done: "c-ok st-done happy celebrate",
  error: "c-err st-error sad",
  stop: "c-dim st-stop sleep",
  queued: "c-dim st-queued blink",
  boot: "c-dim st-boot",
  load: "c-dim st-load",
  // An available update is good news: sparkly and awake. No `track`/`poke` —
  // the mascot should not follow the cursor while advertising something, and
  // a click on it should not pop the greeting over the update chip.
  update: "c-ok st-update happy",
  // LSP: осмотр кода (измеряющий пульс, взгляд вбок — «смотрю, что скажет
  // компилятор»). Проверка ничего не пишет, поэтому recon-цвет.
  check: "c-recon st-check squint",
  // LSP: компилятор нашёл ошибки. Тревога слабее, чем `error`: это рабочая
  // обратная связь от сервера, а не сбой харнесса.
  warn: "c-warn st-warn squint",
};

// Tool name → loader state (matches STYLE.md tool categories). Every core
// tool has a state, so the face never falls back to a generic "run" for a
// known behavioural category (ask, research, memory, introspection).
const TOOL_STATE: Record<string, FaceState> = {
  read_file: "read", list_dir: "read", file_info: "read",
  load_skill: "read", session_info: "read",
  grep: "find", glob: "find", project_map: "find", chunk_query: "find",
  history: "find", recall: "find", search_history: "find",
  web_search: "web", web_fetch: "web", download_file: "web", web_browse: "web",
  write_file: "create", create_dir: "create",
  define_capability: "create", remember: "create",
  edit_file: "edit", move_file: "edit", delete_file: "edit", attach_image: "edit",
  bash: "run", pipeline_run: "run", process_wait: "run", process_kill: "run",
  browser: "run", subagent: "run", mcp_call: "run", enable_tools: "run",
  plan: "plan", todo: "plan", verify: "plan",
  lsp_check: "check",
  set_thinking: "think",
  approve: "ask", question: "ask",
  meet_done: "done",
};

export interface LoaderSignal {
  type:
    | "phase" | "tool_start" | "tool_end" | "text" | "question" | "turn_end" | "error"
    | "retract" | "index" | "setup_done" | "update"
    | "usage" | "state" | "config" | "files" | "sessions" | "plugins" | "log";
  name?: string;
  phase?: string;
  success?: boolean;
  /** Вывод тула — нужен, чтобы отличить LSP-ошибки от успешного тула. */
  output?: string;
}

/**
 * Что LSP дописал в вывод тула. Пост- проверка после `write_file`/`edit_file`
 * и `lsp_check` помечают результат маркерами `[LSP ...]`; по ним маскот
 * понимает, радоваться или тревожиться.
 *
 * - `errors` — сервер вернул error'ы (рабочая обратная связь);
 * - `failed` — сервер недоступен или отключён (проблема харнесса, не кода).
 */
export function lspOutputSignal(output: string | undefined): "errors" | "failed" | null {
  if (!output) return null;
  if (output.includes("[LSP check failed") || output.includes("[LSP disabled")) return "failed";
  if (output.includes("[LSP errors]")) return "errors";
  return null;
}

export function toolState(name: string): FaceState {
  return TOOL_STATE[name] || "run";
}

// Pure mapping used by both the feed and the rail.
export function loaderStateFor(s: LoaderSignal): FaceState {
  switch (s.type) {
    case "turn_end": return s.success === false ? "error" : "done";
    case "error":
    // A retracted draft is a rejected claim — the face shows the same
    // "human, fix that" mood as a tool error.
    case "retract": return "error";
    case "question": return "ask";
    case "text": return "type";
    case "tool_start":
    case "tool_end": {
      const name = s.name || "";
      // `lsp_check` отвечает success:false именно тогда, когда нашёл ошибки —
      // это обратная связь, а не сбой.
      if (name === "lsp_check" && s.type === "tool_end" && s.success === false) return "warn";
      // Пост- проверка LSP после write/edit живёт в выводе тула.
      const lsp = lspOutputSignal(s.output);
      if (s.type === "tool_end") {
        if (lsp === "errors") return "warn";
        if (lsp === "failed") return "error";
      }
      return toolState(name);
    }
    // Re-indexing is a workspace-wide search.
    case "index": return "find";
    case "setup_done": return "done";
    // Unlike the broadcasts below, an update is news for the user — the mascot
    // celebrates it. The persistent part lives in the footer chip (snapshot).
    case "update": return "update";
    // Background broadcasts (usage/state/config/files/sessions/plugins/log)
    // carry no agent activity: the face must NOT move on them, they map to
    // idle and callers are expected to drop the event instead of animating.
    case "usage": case "state": case "config": case "files":
    case "sessions": case "plugins": case "log":
      return "idle";
    default: return "think";
  }
}

// ---- MMART: the mascot's identity and its greeting bubble ----
export const MMART_NAME = "MMART";
// app.ts injects the localized resolver so this module stays import-time-safe
// under `bun test` (i18n → api touches `location`, which is undefined there).
let greetResolver: () => string = () => `Привет! Я ${MMART_NAME}`;
export function setGreetResolver(fn: () => string): void {
  greetResolver = fn;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

// A face always carries every extra element; CSS shows only the ones its
// state uses, so `setFaceState` never touches the DOM structure.
export function createFace(state: FaceState = "think", size: FaceSize | null = null): HTMLElement {
  const face = el("span");
  face.setAttribute("aria-hidden", "true");
  face.dataset.size = size || "";
  const eyes = el("span", "eyes");
  eyes.appendChild(el("i", "eye left"));
  eyes.appendChild(el("i", "eye right"));
  const orb = el("span", "orb");
  orb.appendChild(el("i"));
  const keys = el("span", "keys");
  for (let i = 0; i < 4; i++) keys.appendChild(el("i"));
  const dust = el("span", "dust");
  for (let i = 0; i < 3; i++) dust.appendChild(el("i"));
  const fx = el("span", "fx");
  for (let i = 0; i < 6; i++) fx.appendChild(el("i"));
  face.append(
    eyes, orb, keys, el("span", "grow"), el("span", "fly"), fx,
    el("span", "sweep"), dust, el("span", "q", "?"), el("span", "spark", "✦"), el("span", "star"),
    el("span", "mdl-tip"),
  );
  setFaceState(face, state);
  return face;
}

export function setFaceState(face: HTMLElement | null, state: FaceState): void {
  if (!face) return;
  const size = face.dataset.size || "";
  face.className = "mdl" + (size ? " " + size : "") + " " + FACE_CLASS[state];
  face.dataset.state = state;
  populateFx(face, state);
  // Drop any leftover cursor-tracking offsets/tilt so the new state starts clean.
  if (!FACE_CLASS[state].includes("track")) {
    face.style.setProperty("--ex", "0px");
    face.style.setProperty("--ey", "0px");
    face.style.setProperty("--tilt", "0deg");
  }
}

// ---- cursor tracking, click-to-blink and the MMART greeting for idle faces
// (`.track` / `.poke`) ----
const tipTimers = new WeakMap<HTMLElement, number>();

// Pop the localized greeting above the face. Repeated clicks restart the
// timer instead of stacking, so the bubble can never stick open.
function showGreeting(m: HTMLElement): void {
  const tip = m.querySelector<HTMLElement>(".mdl-tip");
  if (!tip) return;
  tip.textContent = greetResolver();
  m.classList.add("show-tip");
  const prev = tipTimers.get(m);
  if (prev !== undefined) window.clearTimeout(prev);
  tipTimers.set(
    m,
    window.setTimeout(() => {
      m.classList.remove("show-tip");
      tipTimers.delete(m);
    }, 2200),
  );
}

function trackTargets(sel: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(sel));
}

function lookAt(x: number, y: number): void {
  for (const m of trackTargets(".mdl.track")) {
    const r = m.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const maxShift = r.width * 0.16;
    const reach = Math.min(1, dist / 140);
    const nx = dx / dist;
    const ny = dy / dist;
    m.style.setProperty("--ex", (nx * maxShift * reach).toFixed(1) + "px");
    m.style.setProperty("--ey", (ny * maxShift * reach).toFixed(1) + "px");
    m.style.setProperty("--tilt", (nx * 6 * reach).toFixed(2) + "deg");
  }
}

function resetLook(): void {
  for (const m of trackTargets(".mdl.track")) {
    m.style.setProperty("--ex", "0px");
    m.style.setProperty("--ey", "0px");
    m.style.setProperty("--tilt", "0deg");
  }
}

// The click landed on the face itself (its own parts count). Anything else in
// the document only lets it blink — the greeting is not a page-wide easter egg.
function clickOnFace(e: MouseEvent): HTMLElement | null {
  const node = e.target as HTMLElement | null;
  if (!node || typeof node.closest !== "function") return null;
  return node.closest<HTMLElement>(".mdl.poke");
}

let cursorWired = false;

export function initCursor(): void {
  if (cursorWired || typeof window === "undefined") return;
  cursorWired = true;
  window.addEventListener("mousemove", (e) => lookAt(e.clientX, e.clientY));
  window.addEventListener("mouseleave", resetLook);
  // Click anywhere → idle faces blink. Every click restarts the blink, so fast
  // clicking keeps up (no lock-out guard).
  let pokeTimer: number | null = null;
  window.addEventListener("click", (e) => {
    const targets = trackTargets(".mdl.poke");
    if (targets.length) {
      for (const m of targets) {
        m.classList.remove("blink-once");
        void m.offsetWidth; // restart the CSS animation
        m.classList.add("blink-once");
      }
      if (pokeTimer !== null) window.clearTimeout(pokeTimer);
      pokeTimer = window.setTimeout(() => {
        for (const m of targets) m.classList.remove("blink-once");
        pokeTimer = null;
      }, 130);
    }
    const hit = clickOnFace(e);
    if (hit) showGreeting(hit);
  });
}
