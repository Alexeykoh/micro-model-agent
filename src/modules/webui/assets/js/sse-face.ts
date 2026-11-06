// Composer face (MMART) SSE wiring — вынесено из `sse.ts` (правило 6: ≤300
// строк). Маскот реагирует на реальную активность агента; фоновые рассылки
// (`usage`/`state`/`config`/`files`/`sessions`/`plugins`/`log`) сознательно
// не несут `faceEvent` и его не двигают.
import type { Dict } from "./core/store/types.js";
import type { SseDeps } from "./sse-deps.js";
import { activityPhase } from "./core/activity.js";
import { activityKey } from "./core/activity-stream.js";

/** Всё, что нужно маскоту от потока: разбор и подписка на состояние лица. */
export interface FaceSseDeps {
  parse: (e: MessageEvent) => Dict | null;
  faceEvent: SseDeps["faceEvent"];
  loaderStateFor: SseDeps["loaderStateFor"];
  composerFace: SseDeps["composerFace"];
  getComposerToken: SseDeps["getComposerToken"];
  setFaceState: SseDeps["setFaceState"];
  applyUpdateEvent: SseDeps["applyUpdateEvent"];
  updateHooks: SseDeps["updateHooks"];
}

/** Тип события потока → состояние маскота. */
const FACE_TYPES: Array<[string, "tool_start" | "tool_end" | "text" | "question" | "error"]> = [
  ["tool_start", "tool_start"],
  ["tool_end", "tool_end"],
  ["text", "text"],
  ["question", "question"],
  ["error", "error"],
];

/** Подписать маскота на поток. */
export function attachFaceSse(es: EventSource, deps: FaceSseDeps): void {
  const {
    parse,
    faceEvent,
    loaderStateFor,
    composerFace,
    getComposerToken,
    setFaceState,
    applyUpdateEvent,
    updateHooks,
  } = deps;
  for (const [ev, type] of FACE_TYPES) {
    es.addEventListener(ev, (e) => {
      const d = parse(e);
      if (!d) return;
      faceEvent(
        loaderStateFor({
          type,
          name: typeof d.name === "string" ? d.name : "",
          success: d.success !== false,
          // Нужен только для tool_end: по выводу маскот ловит LSP-реакцию.
          ...(type === "tool_end" && typeof d.output === "string" ? { output: d.output } : {}),
        }),
      );
    });
  }
  es.addEventListener("phase", (e) => {
    const d = parse(e);
    // Маскот смотрит на ту же фазу, что и рельс: пишет — «печатает», тул — «бежит».
    const phase = d ? activityPhase(activityKey(d)) : "thinking";
    faceEvent(phase === "composing" ? "type" : phase === "tool" ? "run" : "think");
  });
  es.addEventListener("reasoning", () => faceEvent("think"));
  es.addEventListener("plan", () => faceEvent("plan"));
  es.addEventListener("turn_end", (e) => {
    const d = parse(e);
    // An interrupted turn (`success:false, interrupted:true`) is a user stop, not
    // a failure — settle the face to "done", never "error".
    faceEvent(d && d.success === false && !d.interrupted ? "error" : "done");
    const faceToken = getComposerToken();
    window.setTimeout(() => {
      if (faceToken === getComposerToken()) setFaceState(composerFace, "idle");
    }, 1500);
  });
  // A retracted draft is a normal re-check (the gate asked the model to rewrite),
  // re-indexing as workspace search, first-run completion as done.
  es.addEventListener("retract", () => faceEvent(loaderStateFor({ type: "retract" })));
  // Гейт проверяет готовый ответ: своё состояние, не think/error.
  es.addEventListener("meta", (e) => {
    const d = parse(e);
    if (d?.kind === "progress") faceEvent(loaderStateFor({ type: "verify" }));
  });
  es.addEventListener("index", () => faceEvent("find"));
  es.addEventListener("setup_done", () => faceEvent("done"));
  // An available version is news for the user, so MMART reacts. The face
  // settles back to idle: the persistent half of the notice is the footer chip.
  es.addEventListener("update", (e) => {
    const d = parse(e);
    if (d) applyUpdateEvent(d, updateHooks);
  });
}
