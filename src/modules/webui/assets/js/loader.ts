// Loader faces — a small squircle "agent presence": eyes + extra effects,
// driven entirely by CSS state classes. One component for the boot splash,
// the in-feed busy line, the activity rail and the first-run wizard.
// See docs/specs/2026-10-08-loader-webui-design.md.

export type FaceState =
  | "idle" | "think" | "read" | "find" | "web" | "edit" | "type" | "create"
  | "run" | "tests" | "compact" | "plan" | "ask" | "done" | "error" | "stop"
  | "queued" | "boot" | "load";

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
};

// Tool name → loader state (matches STYLE.md tool categories).
const TOOL_STATE: Record<string, FaceState> = {
  read_file: "read", list_dir: "read", file_info: "read",
  grep: "find", glob: "find", project_map: "find", chunk_query: "find",
  history: "find", recall: "find",
  web_search: "web", web_fetch: "web", download_file: "web",
  write_file: "create", create_dir: "create",
  edit_file: "edit", move_file: "edit", delete_file: "edit", attach_image: "edit",
  bash: "run", pipeline_run: "run", process_wait: "run", process_kill: "run",
  browser: "run", subagent: "run", mcp_call: "run",
  plan: "plan", todo: "plan", verify: "plan", lsp_check: "plan",
};

export interface LoaderSignal {
  type: "phase" | "tool_start" | "tool_end" | "text" | "question" | "turn_end" | "error";
  name?: string;
  phase?: string;
  success?: boolean;
}

export function toolState(name: string): FaceState {
  return TOOL_STATE[name] || "run";
}

// Pure mapping used by both the feed and the rail.
export function loaderStateFor(s: LoaderSignal): FaceState {
  switch (s.type) {
    case "turn_end": return s.success === false ? "error" : "done";
    case "error": return "error";
    case "question": return "ask";
    case "text": return "type";
    case "tool_start":
    case "tool_end": return toolState(s.name || "");
    default: return "think";
  }
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
  face.append(
    eyes, orb, keys, el("span", "grow"), el("span", "fly"),
    dust, el("span", "q", "?"), el("span", "spark", "✦"), el("span", "star"),
  );
  setFaceState(face, state);
  return face;
}

export function setFaceState(face: HTMLElement | null, state: FaceState): void {
  if (!face) return;
  const size = face.dataset.size || "";
  face.className = "mdl" + (size ? " " + size : "") + " " + FACE_CLASS[state];
  face.dataset.state = state;
  // Drop any leftover cursor-tracking offsets/tilt so the new state starts clean.
  if (!FACE_CLASS[state].includes("track")) {
    face.style.setProperty("--ex", "0px");
    face.style.setProperty("--ey", "0px");
    face.style.setProperty("--tilt", "0deg");
  }
}

// ---- cursor tracking + click-to-blink for idle faces (`.track` / `.poke`) ----
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

let cursorWired = false;

export function initCursor(): void {
  if (cursorWired || typeof window === "undefined") return;
  cursorWired = true;
  window.addEventListener("mousemove", (e) => lookAt(e.clientX, e.clientY));
  window.addEventListener("mouseleave", resetLook);
  // Click anywhere → idle faces blink. Every click restarts the blink, so fast
  // clicking keeps up (no lock-out guard).
  let pokeTimer: number | null = null;
  window.addEventListener("click", () => {
    const targets = trackTargets(".mdl.poke");
    if (!targets.length) return;
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
  });
}
