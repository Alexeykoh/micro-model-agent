// Поп-ап редактирования запланированного сообщения очереди (`mma web`).
//
// Хост — общий вложенный диалог `subdialog.ts` (тот же, что у провайдера/MCP).
// Строка очереди кликается → здесь поле с текущим текстом + «Сохранить/Отмена».
// Сохранение — `POST /api/queue/edit {sessionId, id, text}`; серверная запись —
// источник правды (после `turn_end` в ленту уйдёт новый текст), поэтому после
// успеха локальный `PendingMessage` синхронизируется колбэком `onSaved`.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { api } from "../api.js";
import { closeSubDialog, openSubDialog } from "../subdialog.js";
import type { Dict } from "../core/store/types.js";

/** Сохранённый текст: колбэк вызывается только после успешного ответа сервера. */
export type QueueSavedCb = (sessionId: string, id: string, text: string) => void;

/**
 * Открыть попап редактора для строки очереди `{ id, text }`. Пустой текст
 * сохранить нельзя (кнопка «Сохранить» выключена) — совпадает с серверным
 * гейтом `text.trim().length === 0`.
 */
export function openQueueEdit(tab: Dict, id: string, current: string, onSaved: QueueSavedCb): void {
  const sessionId = String(tab.id ?? "");
  const box = el("div", "queue-edit");
  const area = el("textarea", "qe-text") as HTMLTextAreaElement;
  area.value = current;
  area.placeholder = t("web.queue.edit_placeholder");
  box.appendChild(area);

  const actions = el("div", "qe-actions");
  const save = el("button", "qe-save primary", t("web.queue.edit_save")) as HTMLButtonElement;
  const cancel = el("button", "qe-cancel", t("web.action.cancel")) as HTMLButtonElement;
  save.type = "button";
  cancel.type = "button";
  cancel.addEventListener("click", closeSubDialog);
  save.disabled = current.trim().length === 0;
  area.addEventListener("input", () => {
    save.disabled = area.value.trim().length === 0;
  });
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
        const msg = el("div", "qe-err", t("web.queue.edit_failed"));
        actions.insertBefore(msg, actions.firstChild);
        return;
      }
      onSaved(sessionId, id, text);
      closeSubDialog();
    });
  });
  actions.append(save, cancel);
  box.appendChild(actions);
  openSubDialog(t("web.queue.edit_title"), box);
}
