// Shell of the subagent run view: sticky header, mascot, stop button, body.
// Extracted from `subagent.ts` (rule 6 ≤300) — pure DOM, no API/view state.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { createFace, setFaceState } from "../loader.js";
import type { Dict } from "../core/store/types.js";
import { buf, runFaceState, statusText } from "./subagent-buffer.js";

/** Элементы шапки/тела прогона; владелец — `View` в `subagent.ts`. */
export interface RunShell {
  root: HTMLElement;
  body: HTMLElement;
  title: HTMLElement;
  state: HTMLElement;
  chips: HTMLElement;
  face: HTMLElement;
  stop: HTMLButtonElement;
}

/** Строит статичный каркас вида; `onStop` жмёт кнопку остановки. */
export function buildRunShell(onBack: () => void, onStop: () => void): RunShell {
  const root = el("div", "srun");
  // Sticky-обёртка: «← к чату» и чипы остаются сверху при скролле.
  const head = el("div", "srun-head");
  const top = el("div", "srun-top");
  const back = el("button", "srun-back");
  back.type = "button";
  back.textContent = "← " + t("web.subagent.back");
  back.addEventListener("click", onBack);
  top.appendChild(back);
  const faceSlot = el("span", "srun-face-top");
  const face = createFace("think", "sm");
  faceSlot.appendChild(face);
  top.appendChild(faceSlot);
  const title = el("span", "srun-title", t("web.subagent.title"));
  top.appendChild(title);
  const state = el("span", "srun-state", t("web.subagent.running"));
  top.appendChild(state);
  const stop = el("button", "srun-stop") as HTMLButtonElement;
  stop.type = "button";
  stop.textContent = "■";
  stop.title = t("web.subagent.stop");
  stop.setAttribute("aria-label", t("web.subagent.stop"));
  stop.addEventListener("click", onStop);
  top.appendChild(stop);
  head.appendChild(top);
  const chips = el("div", "srun-chips");
  chips.hidden = true;
  head.appendChild(chips);
  root.appendChild(head);
  const note = el("div", "srun-note", t("web.subagent.readonly"));
  root.appendChild(note);
  const body = el("div", "srun-body");
  root.appendChild(body);
  return { root, body, title, state, chips, face, stop };
}

/** Обновляет шапку по мете прогона (статус, лицо, доступность стопа). */
export function applyRunHeader(
  shell: RunShell,
  runId: string,
  meta: Dict,
  started: number,
  stopping: boolean,
): void {
  shell.title.textContent = String(meta.task || t("web.subagent.title"));
  shell.title.title = String(meta.task || "");
  shell.state.textContent = statusText(meta, started);
  shell.state.className = "srun-state st-" + String(meta.status || "running");
  setFaceState(shell.face, runFaceState(buf(runId)));
  shell.stop.hidden = String(meta.status || "running") !== "running";
  shell.stop.disabled = shell.stop.hidden || stopping;
}
