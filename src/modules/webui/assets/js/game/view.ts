// DOM shell for MMART flight: the modal, its stats/hint and the focus target.
// Kept apart from the game loop so each file stays small and the scene can be
// reviewed on its own.
import { el, icon } from "../dom.js";
import { t } from "../i18n.js";
import type { Phase } from "./world.js";

export interface GameView {
  root: HTMLDivElement;
  stage: HTMLDivElement;
  hint: HTMLElement;
  score: HTMLElement;
  best: HTMLElement;
}

export interface GameHandlers {
  onClose: () => void;
  onFlap: () => void;
}

function stat(label: string): { wrap: HTMLElement; value: HTMLElement } {
  const wrap = el("span", "game-stat");
  wrap.appendChild(el("span", "game-stat-label", label));
  const value = el("b", null, "0");
  wrap.appendChild(value);
  return { wrap, value };
}

export function buildView(handlers: GameHandlers): GameView {
  const box = el("div", "game-overlay") as HTMLDivElement;
  box.hidden = true;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "gameTitle");

  const top = el("div", "game-top");
  const title = el("span", "game-title", t("web.game.title"));
  title.id = "gameTitle";
  const scoreBits = stat(t("web.game.score"));
  const bestBits = stat(t("web.game.best"));

  const close = el("button", "game-close") as HTMLButtonElement;
  close.type = "button";
  close.appendChild(icon("x"));
  close.title = t("web.game.close");
  close.setAttribute("aria-label", t("web.game.close"));
  close.addEventListener("click", handlers.onClose);

  top.appendChild(title);
  top.appendChild(scoreBits.wrap);
  top.appendChild(bestBits.wrap);
  top.appendChild(close);

  const stage = el("div", "game-stage") as HTMLDivElement;
  stage.tabIndex = 0;
  stage.setAttribute("aria-label", t("web.game.title"));
  const canvas = document.createElement("canvas");
  canvas.className = "game-canvas";
  const hint = el("div", "game-hint");
  hint.setAttribute("aria-live", "polite");
  stage.appendChild(canvas);
  stage.appendChild(hint);
  stage.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    stage.focus();
    handlers.onFlap();
  });

  const panel = el("div", "game-box");
  panel.appendChild(top);
  panel.appendChild(stage);
  box.appendChild(panel);
  box.addEventListener("click", (e: MouseEvent) => {
    if (e.target === box) handlers.onClose();
  });

  document.body.appendChild(box);
  return { root: box, stage, hint, score: scoreBits.value, best: bestBits.value };
}

export function paintScore(view: GameView, score: number, best: number): void {
  view.score.textContent = String(score);
  view.best.textContent = String(best);
}

/** Re-apply copy after a locale switch (the modal is built once, kept closed). */
export function applyViewI18n(view: GameView): void {
  const title = view.root.querySelector<HTMLElement>("#gameTitle");
  if (title) title.textContent = t("web.game.title");
  const labels = view.root.querySelectorAll<HTMLElement>(".game-stat-label");
  if (labels[0]) labels[0].textContent = t("web.game.score");
  if (labels[1]) labels[1].textContent = t("web.game.best");
  const close = view.root.querySelector<HTMLElement>(".game-close");
  if (close) {
    close.title = t("web.game.close");
    close.setAttribute("aria-label", t("web.game.close"));
  }
  view.stage.setAttribute("aria-label", t("web.game.title"));
}

export function syncHint(view: GameView, phase: Phase, newBest: boolean): void {
  view.hint.hidden = phase === "playing";
  if (phase === "ready") view.hint.textContent = t("web.game.ready");
  else if (phase === "over") {
    view.hint.textContent = t("web.game.over") + (newBest ? " · " + t("web.game.best_new") : "");
  } else view.hint.textContent = "";
}
