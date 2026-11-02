// Поп-ап «Запрос провайдеру» (U20): что реально ушло в модель после DLP.
// Показывает system → messages → tools и параметры; оригиналов в снимке нет
// (проекция уже применена до сети), поэтому показывать можно как есть.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { api } from "../api.js";
import { openSubDialog } from "../subdialog.js";
import type { Dict } from "../core/store/types.js";

/** Последний показанный снимок: по нему работает переход из бейджа DLP (U21). */
let lastRequest: Dict | null = null;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Список сообщений: индекс, роль, текст (с подсветкой цели перехода). */
function messagesNode(request: Dict, focusIdx?: number): HTMLElement {
  const list = el("div", "req-messages");
  const messages = Array.isArray(request.messages) ? request.messages : [];
  messages.forEach((raw, idx) => {
    if (!raw || typeof raw !== "object") return;
    const msg = raw as Dict;
    const row = el("div", "req-msg" + (idx === focusIdx ? " req-focus" : ""));
    row.dataset.idx = String(idx);
    const head = el("div", "req-msg-head");
    head.appendChild(el("span", "req-idx", String(idx + 1)));
    head.appendChild(el("span", "req-role", str(msg.role) || "user"));
    const text = str(msg.text);
    head.appendChild(el("span", "req-chars", t("web.request.chars", { count: text.length })));
    if (msg.clipped === true) head.appendChild(el("span", "req-clip", t("web.request.clipped")));
    row.appendChild(head);
    row.appendChild(el("pre", "req-text", text));
    list.appendChild(row);
  });
  if (list.childElementCount === 0) list.appendChild(el("div", "detail", t("web.request.no_messages")));
  return list;
}

/** Дефиниции тулов: имя + описание, свёрнуто в details. */
function toolsNode(request: Dict): HTMLElement | null {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  if (tools.length === 0) return null;
  const details = document.createElement("details");
  details.className = "req-tools";
  const summary = document.createElement("summary");
  summary.textContent = t("web.request.tools", { count: tools.length });
  details.appendChild(summary);
  for (const raw of tools) {
    if (!raw || typeof raw !== "object") continue;
    const tool = raw as Dict;
    const item = el("div", "req-tool");
    item.appendChild(el("b", "req-tool-name", str(tool.name)));
    const desc = str(tool.description);
    if (desc) item.appendChild(el("div", "req-tool-desc", desc));
    details.appendChild(item);
  }
  return details;
}

/** Шапка: модель, хост, параметры вызова. */
function metaNode(request: Dict): HTMLElement {
  const head = el("div", "req-meta");
  const parts: string[] = [str(request.model)];
  if (str(request.providerHost)) parts.push(str(request.providerHost));
  if (request.stream === true) parts.push("stream");
  head.appendChild(el("div", "req-model", parts.filter(Boolean).join(" · ")));
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as Dict;
  const chips = el("div", "req-params");
  const add = (label: string, value: unknown): void => {
    if (value === undefined || value === null || value === "") return;
    chips.appendChild(el("span", "req-chip", `${label} ${String(value)}`));
  };
  add("max_tokens", params.maxTokens);
  add("reasoning", params.reasoning ?? params.reasoningEffort);
  add("temperature", params.temperature);
  add("tool_choice", params.toolChoice);
  if (chips.childElementCount) head.appendChild(chips);
  return head;
}

/** Кнопка «копировать JSON» как есть — для разбора инцидентов. */
function copyRow(request: Dict): HTMLElement {
  const row = el("div", "req-actions");
  const btn = el("button", "linkbtn req-copy", t("web.request.copy"));
  btn.type = "button";
  btn.addEventListener("click", () => {
    try {
      const text = JSON.stringify(request, null, 2);
      void navigator.clipboard?.writeText(text);
      btn.textContent = t("web.request.copied");
    } catch {
      /* clipboard недоступен — молча */
    }
  });
  row.appendChild(btn);
  return row;
}

/** Собрать тело поп-апа из снимка запроса. */
function requestBody(request: Dict, focus?: { messageIdx?: number }): HTMLElement {
  const wrap = el("div", "req-view");
  wrap.appendChild(metaNode(request));
  if (request.truncated === true) {
    wrap.appendChild(el("div", "req-truncated", t("web.request.truncated")));
  }
  const system = str(request.system);
  if (system) {
    const details = document.createElement("details");
    details.className = "req-system";
    details.open = system.length <= 1200;
    const summary = document.createElement("summary");
    summary.textContent = t("web.request.system", { count: system.length });
    details.appendChild(summary);
    details.appendChild(el("pre", "req-text", system));
    wrap.appendChild(details);
  }
  wrap.appendChild(el("div", "req-section", t("web.request.messages")));
  wrap.appendChild(messagesNode(request, focus?.messageIdx));
  const tools = toolsNode(request);
  if (tools) wrap.appendChild(tools);
  wrap.appendChild(copyRow(request));
  return wrap;
}

/** Открыть поп-ап снимка; `focus` подсвечивает конкретное сообщение (U21). */
export function openRequestDialog(request: unknown, focus?: { messageIdx?: number }): void {
  if (!request || typeof request !== "object") return;
  const data = request as Dict;
  lastRequest = data;
  const body = requestBody(data, focus);
  openSubDialog(t("web.request.title"), body, () => {
    // Прокрутка к цели после монтирования: scrollIntoView до открытия не виден.
    const idx = focus?.messageIdx;
    if (typeof idx !== "number") return;
    const node = body.querySelector(`.req-msg[data-idx="${idx}"]`);
    if (node instanceof HTMLElement) node.scrollIntoView({ block: "nearest" });
  });
}

/**
 * Запомнить последний снимок без открытия поп-апа: Trace получает
 * `llm_request` живьём, и переход из бейджа DLP (U21) должен работать, даже
 * если пользователь ещё не открывал сам снимок.
 */
export function rememberRequest(request: unknown): void {
  if (request && typeof request === "object") lastRequest = request as Dict;
}

/** Сбросить запомненный снимок при смене сессии (чужой запрос не показываем). */
export function clearRequestMemo(): void {
  lastRequest = null;
}

/** Снимок без живого события: последняя запись `llm_request` из журнала. */
async function fetchLastRequest(): Promise<Dict | null> {
  const sid = document.querySelector(".sb")?.getAttribute("data-sid") || "";
  if (!sid) return null;
  try {
    const r = await api<{ log?: Dict[] }>(
      "/api/sessions/" + encodeURIComponent(sid) + "/log?types=llm_request&limit=1",
    );
    const last = Array.isArray(r.data?.log) ? r.data.log[r.data.log.length - 1] : undefined;
    const request = last && typeof last.llmRequest === "object" ? last.llmRequest : null;
    return request && typeof request === "object" ? (request as Dict) : null;
  } catch {
    return null;
  }
}

/** Подключить переход из бейджа DLP (U21) к снимку запроса. */
export function initRequestPopup(): void {
  document.addEventListener("mma:open-request", (ev) => {
    const detail = (ev as CustomEvent).detail;
    const messageIdx =
      detail && typeof detail === "object" ? (detail as Dict).messageIdx : undefined;
    const focus = { ...(typeof messageIdx === "number" ? { messageIdx } : {}) };
    // Снимок живьём (Trace уже видел `llm_request`) либо из журнала сессии:
    // после перезагрузки живых событий нет, а переход из бейджа обязан работать.
    if (lastRequest) {
      openRequestDialog(lastRequest, focus);
      return;
    }
    void fetchLastRequest().then((request) => {
      if (request) openRequestDialog(request, focus);
    });
  });
}
