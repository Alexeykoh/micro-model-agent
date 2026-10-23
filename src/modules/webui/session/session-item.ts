// Параметризованные `/api/sessions/:id/<sub>` GET-роуты и `DELETE /:id`
// (вынесено из `sessions-api.ts`, правило ≤300). DELETE прокинут колбэком,
// чтобы не заводить цикл импортов с `sessions-api`.
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSessionHistory } from "./history-api";
import { handleSessionImage } from "./images-api";
import { handleSessionLog } from "./log-api";
import { handleSubagentRunsGet } from "./subagent-api";
import type { SessionStore, RuntimeState, HttpTransport, SseTransport } from "../state";

export function handleSessionItem(
  req: IncomingMessage,
  res: ServerResponse,
  p: string,
  s: SessionStore & RuntimeState & HttpTransport & SseTransport,
  onDelete: (id: string) => void,
): boolean {
  if (!p.startsWith("/api/sessions/")) return false;
  if (req.method === "DELETE") {
    onDelete(decodeURIComponent(p.slice("/api/sessions/".length)));
    return true;
  }
  if (req.method !== "GET") return false;
  if (p.endsWith("/history")) {
    const id = decodeURIComponent(p.slice("/api/sessions/".length, -"/history".length));
    handleSessionHistory(res, id, s);
    return true;
  }
  if (p.endsWith("/log")) {
    const id = decodeURIComponent(p.slice("/api/sessions/".length, -"/log".length));
    handleSessionLog(req, res, id, s);
    return true;
  }
  if (p.endsWith("/subagents")) {
    const id = decodeURIComponent(p.slice("/api/sessions/".length, -"/subagents".length));
    handleSubagentRunsGet(req, res, id, s);
    return true;
  }
  if (p.includes("/images/")) {
    const rest = p.slice("/api/sessions/".length);
    const cut = rest.indexOf("/images/");
    const id = decodeURIComponent(rest.slice(0, cut));
    const name = decodeURIComponent(rest.slice(cut + "/images/".length));
    handleSessionImage(res, id, name, s);
    return true;
  }
  return false;
}
