// Кнопка паузы хода в композере (`#pauseBtn`, перед кнопкой стоп/отправки;
// спека webui-pause-resume).
//
// Семантика размещения: «управление ходом» живёт у края поля ввода, там же,
// где stop — пользователь ищет паузу рядом со стопом, а не в рельсе статуса.
// Вид — иконочный, как у send-кнопки: pause (две черты) / play (треугольник),
// подпись только в title/aria-label. Состояние рисуется по серверной проекции
// `pausedIds` (SSE `state`), а не по локальному флагу: сервер — источник
// правды (INV-P5).
import { icon } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { tabs as tabState, session } from "../store.js";

function btnEl(): HTMLButtonElement | null {
  return document.getElementById("pauseBtn") as HTMLButtonElement | null;
}

/** Ход какой сессии показывать: активная сессионная вкладка. */
function ownSessionId(): string | null {
  const tab = tabState.tabs.find((x) => x.id === tabState.activeTabId);
  return tab && tab.kind === "session" ? String(tab.id) : null;
}

/**
 * Перерисовать кнопку по серверной проекции: видима только когда ход своей
 * сессии бежит; иконка — pause или play. Идемпотентна, дёргается из
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
  // Тот же способ, что у send-кнопки: икона + title/aria, без текстовой подписи.
  btn.textContent = "";
  btn.appendChild(icon(paused ? "play" : "pause"));
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.classList.toggle("paused", paused);
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

const composerBtn = btnEl();
if (composerBtn) composerBtn.addEventListener("click", () => void toggle());
