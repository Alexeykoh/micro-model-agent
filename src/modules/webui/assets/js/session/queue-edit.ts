// Поп-ап редактирования запланированного сообщения очереди (`mma web`).
//
// Хост — общий вложенный диалог `subdialog.ts` (тот же, что у провайера/MCP).
// Строка очереди кликается → здесь поле с текущим текстом + «Сохранить/Отмена».
// Сохранение — `POST /api/queue/edit {sessionId, id, text}`; серверная запись —
// источник правды (после `turn_end` в ленту уйдёт новый текст), поэтому после
// успеха локальный `PendingMessage` синхронизируется колбэком `onSaved`.
//
// UX-спека `docs/specs/2026-11-07-webui-queue-edit-ux-design.md`:
// - textarea в «языке композера» + dim-счётчик `N / MAX`;
// - dirty → стандартный confirm вместо молча терять текст;
// - `404 not_queued` → закрыть попап + toast, транспорт/400 → остаться с ошибкой;
// - приложения сообщения видны в редакторе (сохраняются, редактируется текст);
// - действия через классы `.btn` / `.btn.primary`.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { api } from "../api.js";
import { openConfirm, setIndicator } from "../dialog.js";
import { closeSubDialog, openSubDialog, setSubDialogCloseGuard } from "../subdialog.js";
import type { Dict } from "../core/store/types.js";

/** Серверный лимит длины сообщения — тот же, что `MAX_MESSAGE_CHARS` в util. */
const MAX_MESSAGE_CHARS = 32 * 1024;

/** Сохранённый текст: колбэк вызывается только после успешного ответа сервера. */
export type QueueSavedCb = (sessionId: string, id: string, text: string) => void;

/** Текущий редактируемый черновик и его источник (для dirty-проверки). */
interface EditState {
  original: string;
  onSaved: QueueSavedCb;
  area: HTMLTextAreaElement;
}

let editState: EditState | null = null;

function isDirty(): boolean {
  const s = editState;
  if (!s) return false;
  return s.area.value.trim() !== s.original.trim();
}

/** Закрытие попапа с учётом dirty: изменённый текст отбрасывается через confirm. */
function requestClose(): void {
  const s = editState;
  if (!s) {
    closeSubDialog();
    return;
  }
  if (isDirty()) {
    openDiscard();
    return;
  }
  closeSubDialog();
}

/** Стандартный discard-confirm; после подтверждения закрываем попап. */
function openDiscard(): void {
  const confirmEl = document.getElementById("confirmOverlay");
  if (confirmEl) confirmEl.style.zIndex = "70"; // над вложенным sub-overlay (60)
  openConfirm({
    title: t("web.queue.edit_discard_title"),
    body: t("web.queue.edit_discard_body"),
    acceptLabel: t("web.queue.edit_discard_accept"),
    cancelLabel: t("web.action.cancel"),
    onAccept: () => {
      editState = null;
      setSubDialogCloseGuard(null);
      closeSubDialog();
    },
  });
}

/**
 * Открыть попап редактора для строки очереди `{ id, text }`. Пустой текст
 * сохранить нельзя (кнопка «Сохранить» выключена) — совпадает с серверным
 * гейтом `text.trim().length === 0`.
 */
export function openQueueEdit(
  tab: Dict,
  id: string,
  current: string,
  onSaved: QueueSavedCb,
  images: string[] = [],
): void {
  const sessionId = String(tab.id ?? "");
  const box = el("div", "queue-edit");
  const area = el("textarea", "qe-text") as HTMLTextAreaElement;
  area.value = current;
  area.placeholder = t("web.queue.edit_placeholder");
  area.maxLength = MAX_MESSAGE_CHARS;
  box.appendChild(area);

  editState = { original: current, onSaved, area };
  setSubDialogCloseGuard(
    () => !isDirty(),
    () => {
      if (editState) openDiscard();
    },
  );

  const meta = el("div", "inp-meta");
  const counter = el("span", "qe-count");
  const renderCounter = (): void => {
    counter.textContent = t("web.queue.edit_count", {
      n: String(area.value.length),
      max: String(MAX_MESSAGE_CHARS),
    });
    counter.classList.toggle("warn", area.value.length >= MAX_MESSAGE_CHARS);
  };
  box.appendChild(meta);
  meta.appendChild(counter);

  if (images.length > 0) {
    const imgs = el("div", "queue-edit qe-imgs");
    imgs.textContent = t("web.queue.edit_keep");
    box.appendChild(imgs);
  }

  const actions = el("div", "qe-actions");
  const save = el("button", "qe-save btn primary", t("web.queue.edit_save")) as HTMLButtonElement;
  const cancel = el("button", "qe-cancel btn", t("web.action.cancel")) as HTMLButtonElement;
  save.type = "button";
  cancel.type = "button";
  cancel.addEventListener("click", requestClose);
  save.disabled = current.trim().length === 0;
  area.addEventListener("input", () => {
    renderCounter();
    save.disabled = area.value.trim().length === 0;
  });
  renderCounter();
  save.addEventListener("click", () => {
    const text = area.value;
    if (text.trim().length === 0) return;
    save.disabled = true;
    void api<Dict>("/api/queue/edit", {
      method: "POST",
      body: { sessionId, id, text },
    }).then((r) => {
      if (!r.ok) {
        save.disabled = false;
        const fail = (r.data as { error?: string } | null)?.error;
        if (fail === "not_queued") {
          // The message already started/cancelled elsewhere → it left the queue.
          editState = null;
          setSubDialogCloseGuard(null);
          closeSubDialog();
          setIndicator(t("web.queue.edit_failed"), true);
          return;
        }
        const msg = el("div", "qe-err", t("web.queue.edit_failed"));
        actions.insertBefore(msg, actions.firstChild);
        return;
      }
      const state = editState;
      editState = null;
      setSubDialogCloseGuard(null);
      if (state) state.onSaved(sessionId, id, text);
      closeSubDialog();
    });
  });
  actions.append(save, cancel);
  box.appendChild(actions);
  openSubDialog(t("web.queue.edit_title"), box);
}
