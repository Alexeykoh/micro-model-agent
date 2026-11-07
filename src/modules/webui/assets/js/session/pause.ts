// Кнопка паузы хода в рельсе (`#railPause`, спека webui-pause-resume).
//
// Рельс виден ровно пока ход своей сессии бежит — та же область, где «Esc —
// stop». Клик шлёт `POST /api/pause {sessionId, action}`; состояние рисует
// `⏸ пауза` / `▶ продолжить` по серверной проекции `pausedIds` (SSE `state`),
// а не по локальному флагу: сервер — источник правды (INV-P5).
import { api } from "../api.js";
import { t } from "../i18n.js";
import { tabs as tabState, session } from "../store.js";

function btnEl(): HTMLButtonElement | null {
  return document.getElementById("railPause") as HTMLButtonElement | null;
}

/** Ход какой сессии показывать: активная сессионная вкладка. */
function ownSessionId(): string | null {
  const tab = tabState.tabs.find((x) => x.id === tabState.activeTabId);
  return tab && tab.kind === "session" ? String(tab.id) : null;
}

/**
 * Перерисовать кнопку по серверной проекции: видима только когда ход своей
 * сессии бежит; подпись — пауза или продолжить. Идемпотентна, дёргается из
 * renderTabstrip (смена вкладки/статуса) и из проекции `state`.
 */
export function refreshPauseButton(): void {
  const btn = btnEl();
  if (!btn) return;
  const sid = ownSessionId();
  const running = !!sid && (session.runningSessionIds || []).includes(sid);
  const paused = !!sid && (session.pausedIds || []).includes(sid);
  btn.hidden = !running;
  if (!running) return;
  const label = paused ? t("web.pause.resume") : t("web.pause.hold");
  btn.textContent = (paused ? "▶ " : "⏸ ") + label;
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

async function toggle(): Promise<void> {
  const sid = ownSessionId();
  if (!sid) return;
  const paused = (session.pausedIds || []).includes(sid);
  const btn = btnEl();
  if (btn) btn.disabled = true;
  await api("/api/pause", {
    method: "POST",
    body: { sessionId: sid, action: paused ? "resume" : "pause" },
  });
  // Ответ сервера уже разослал `state`; но если broadcast опоздал/дошёл до
  // другой вкладки — перерисуемся по факту запроса и снимем инвалидацию.
  if (btn) btn.disabled = false;
  refreshPauseButton();
}

const railBtn = btnEl();
if (railBtn) railBtn.addEventListener("click", () => void toggle());
