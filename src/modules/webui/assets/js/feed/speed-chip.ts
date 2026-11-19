// Generation-speed chip above the composer: the single place tok/s is shown.
// While a turn streams it reads the live estimate (`speedView`); when the turn is
// over it switches to the exact per-turn `llmSpeed` snapshot.
import { t } from "../i18n.js";
import { speedText, speedView } from "../speed.js";
import { session } from "../store.js";
import type { Dict } from "../core/store/types.js";

function chipEl(): HTMLElement | null {
  return document.getElementById("speedChip");
}

/** Whether the ACTIVE session has a turn running (background tabs don't count). */
function activeBusy(): boolean {
  const id = session.activeSessionId;
  if (!id) return session.busy;
  const running = session.runningSessionIds || [];
  return running.length > 0 ? running.includes(id) : session.busy;
}

function hideChip(chip: HTMLElement): void {
  chip.hidden = true;
  chip.textContent = "";
  chip.removeAttribute("title");
}

/**
 * Live estimate while the active session streams. The rail ticker (or an SSE
 * chunk) calls this; only the active session may write to the shared chip.
 * A null view hides the chip so a new turn never shows the previous turn's
 * number before its first token arrives.
 */
export function renderLiveSpeed(id?: string | null): void {
  const chip = chipEl();
  if (!chip) return;
  if (!activeBusy()) return;
  if (id && session.activeSessionId && id !== session.activeSessionId) return;
  const sp = speedView(session.activeSessionId);
  if (!sp) {
    hideChip(chip);
    return;
  }
  chip.hidden = false;
  chip.textContent = speedText(sp.value, sp.estimated);
  chip.title = t("web.speed.title");
}

/** Final per-turn speed from the session snapshot (exact, from provider usage). */
export function renderSpeed(h: Dict): void {
  const chip = chipEl();
  if (!chip) return;
  // The live estimate owns the chip while a turn is running.
  if (activeBusy()) return;
  const s = h.llmSpeed && typeof h.llmSpeed === "object" ? (h.llmSpeed as Dict) : null;
  const tokens = s && typeof s.completionTokens === "number" ? s.completionTokens : 0;
  const ms = s && typeof s.decodeMs === "number" ? s.decodeMs : 0;
  if (!s || !(tokens > 0) || !(ms > 0)) {
    hideChip(chip);
    return;
  }
  const calls = Array.isArray(s.calls) ? s.calls : [];
  const estimated = calls.some((c) => c && c.source === "estimate");
  chip.hidden = false;
  chip.textContent = speedText(tokens / (ms / 1000), estimated);
  chip.title = t("web.speed.title");
}

/** Clears the chip when the tab changes: speed belongs to one turn/session. */
export function resetSpeedChip(): void {
  const chip = chipEl();
  if (chip) hideChip(chip);
}
