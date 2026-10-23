// Event → DOM for the subagent run view (`mma web`).
//
// Mirror of the main feed's canon, but scoped to one run: text streams through
// the same Markdown renderer, reasoning uses the collapsible think block, tools
// keep the single `◇` glyph, quiet mode hides successful bodies. All untrusted
// text goes through `textContent` / `mountMarkdown` (which never uses innerHTML).
import { el } from "../dom.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";
import { buildThinkBlock, mdOpts } from "./core.js";
import { labelOf, argText, formatMs, verbosity, firstOutputLine } from "../format.js";
import { mountMarkdown } from "../../md.js";

/** Состояние рендера одного прогона (сегменты + строки тулов). */
export interface RunRender {
  body: HTMLElement;
  text: { write(chunk: string): void; end(): void } | null;
  think: { wrap: HTMLElement; body: HTMLElement } | null;
  tools: Map<string, { line: HTMLElement; status: HTMLElement }>;
}

/** Новое состояние рендера для пустого тела. */
export function makeRunRender(body: HTMLElement): RunRender {
  return { body, text: null, think: null, tools: new Map() };
}

function closeSegments(r: RunRender): void {
  if (r.text) {
    r.text.end();
    r.text = null;
  }
  if (r.think) {
    r.think.wrap.classList.remove("live");
    r.think = null;
  }
}

function ensureText(r: RunRender) {
  if (!r.text) {
    const h = mountMarkdown(r.body, mdOpts(true) as Dict);
    r.text = h;
  }
  return r.text;
}

function ensureThink(r: RunRender) {
  if (!r.think) {
    const b = buildThinkBlock(true, true);
    r.body.appendChild(b.wrap);
    r.think = { wrap: b.wrap, body: b.body };
  }
  return r.think;
}

function appendOutput(r: RunRender, line: HTMLElement | null, text: string, ok: boolean): void {
  if (!text) return;
  if (ok && verbosity() === "quiet") return;
  if (!ok && verbosity() === "quiet") {
    const cause = firstOutputLine(text);
    if (cause) {
      const d = el("div", "detail", "↳ " + cause);
      if (line && line.parentNode) line.parentNode.insertBefore(d, line.nextSibling);
      else r.body.appendChild(d);
    }
    return;
  }
  const wrap = el("div", "toolout");
  const code = el("div", "code");
  code.textContent = text;
  wrap.appendChild(code);
  if (line && line.parentNode) line.parentNode.insertBefore(wrap, line.nextSibling);
  else r.body.appendChild(wrap);
}

/** Рендерит одно событие прогона; `ev` — wire-событие из SSE/снимка. */
export function renderRunEvent(r: RunRender, ev: Dict): void {
  switch (ev.kind) {
    case "text":
      ensureText(r).write(String(ev.chunk ?? ""));
      break;
    case "reasoning": {
      const think = ensureThink(r);
      think.body.appendChild(document.createTextNode(String(ev.chunk ?? "")));
      break;
    }
    case "note": {
      closeSegments(r);
      const text = String(ev.chunk ?? "").trim();
      if (text) r.body.appendChild(el("div", "detail", text));
      break;
    }
    case "tool_start": {
      closeSegments(r);
      const line = el("div", "act " + (ev.tool ? "run" : "meta"));
      line.dataset.callId = String(ev.callId ?? "");
      line.appendChild(el("span", "g", "◇"));
      line.appendChild(el("span", "lab", labelOf(String(ev.tool ?? ""))));
      const args = argText(ev.args || {});
      if (args) line.appendChild(el("span", "args", args));
      const status = el("span", "ok", "");
      line.appendChild(status);
      line.classList.add("running");
      r.body.appendChild(line);
      r.tools.set(String(ev.callId ?? ""), { line, status });
      break;
    }
    case "tool_end": {
      const id = String(ev.callId ?? "");
      const node = r.tools.get(id);
      r.tools.delete(id);
      const ok = ev.success !== false;
      if (node) {
        node.line.classList.remove("running");
        node.status.textContent = (ok ? " ✓" : " ✗") + (ev.durationMs ? " " + formatMs(ev.durationMs) : "");
        if (!ok) node.status.classList.add("fail");
        appendOutput(r, node.line, String(ev.output ?? ""), ok);
      } else if (ev.output) {
        appendOutput(r, null, String(ev.output), ok);
      }
      break;
    }
    case "end": {
      closeSegments(r);
      const status = String(ev.status ?? "done");
      if (status !== "done") {
        const cls = status === "interrupted" ? "warnline" : "errline";
        const reason =
          String(ev.error ?? "") ||
          t(status === "interrupted" ? "web.subagent.interrupted" : "web.subagent.failed");
        r.body.appendChild(el("div", cls, (status === "interrupted" ? "⚠ " : "✗ ") + reason));
      }
      const parts: string[] = [];
      if (typeof ev.iterations === "number") parts.push(t("web.subagent.iterations", { n: ev.iterations }));
      if (typeof ev.durationMs === "number") parts.push(formatMs(ev.durationMs));
      if (typeof ev.usage?.totalTokens === "number") {
        parts.push(t("web.subagent.tokens", { n: ev.usage.totalTokens }));
      }
      if (parts.length) r.body.appendChild(el("div", "metric", "⟡ " + parts.join(" · ")));
      break;
    }
    default:
      break;
  }
}
