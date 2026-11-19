// Persistent face in the composer's selectors row: reflects agent state and
// falls back to the idle (cursor-following) face between turns. Clicking the
// mascot opens the MMART mini-game. Extracted from `app.ts` (file-size rule 6).
import { openGame } from "./game.js";
import { t } from "./i18n.js";
import { createFace, setFaceState, type FaceState } from "./loader.js";

let face: HTMLElement | null = null;
let token = 0;

function openFromFace(): void {
  openGame();
}

/** Mounts the face placeholder, if the composer row exists. */
export function initComposerFace(): void {
  const host = document.getElementById("composerFace");
  if (!host) return;
  face = createFace("idle", "sm");
  face.removeAttribute("aria-hidden");
  face.tabIndex = 0;
  face.setAttribute("role", "button");
  applyComposerFaceI18n();
  face.addEventListener("click", (e) => {
    e.stopPropagation();
    openFromFace();
  });
  face.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openFromFace();
  });
  host.replaceChildren(face);
}

/** Localized action label for the mascot button (re-applied on locale switch). */
export function applyComposerFaceI18n(): void {
  if (!face) return;
  const label = t("web.game.tab");
  face.title = label;
  face.setAttribute("aria-label", label);
}

/** Applies an agent face; bumps the token so a later idle settle cannot win. */
export function composerFaceEvent(state: FaceState): void {
  token++;
  setFaceState(face, state);
}

/** Current face element (null before the composer mounts). */
export function composerFaceElement(): HTMLElement | null {
  return face;
}

/** Monotonic face token; lets callers detect a newer state change. */
export function composerFaceToken(): number {
  return token;
}

/** Returns the face to idle only if no newer state arrived meanwhile. */
export function settleComposerFaceIdle(): void {
  const current = token;
  window.setTimeout(() => {
    if (current === token) setFaceState(face, "idle");
  }, 4000);
}
