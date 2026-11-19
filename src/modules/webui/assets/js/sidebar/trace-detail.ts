// Trace master-detail pane: metadata, payload groups and session-log
// provenance. Split out of `trace.ts` (rule ≤300).
import { el } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { formatMs } from "../format.js";
import type { Dict } from "../core/store/types.js";
import { sb, MAX_OUTPUT_CHARS, type TraceEntry } from "./state.js";
import { isWarn, retractSourceLabel, rowLabel } from "./trace-labels.js";

function detailGroup(title: string, bodyNode: Node): HTMLElement {
  const g = el("div");
  g.appendChild(el("h5", "", title));
  g.appendChild(bodyNode);
  return g;
}
function kv(label: string, value: string): HTMLElement {
  const row = el("div", "kv");
  row.appendChild(el("span", "dim", label));
  const b = el("b");
  b.textContent = value;
  row.appendChild(b);
  return row;
}
function codeBlock(text: string): HTMLElement {
  const c = el("div", "code");
  c.textContent = text;
  return c;
}
function capOutput(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.length <= MAX_OUTPUT_CHARS
    ? text
    : text.slice(0, MAX_OUTPUT_CHARS) + "\n… [truncated from " + text.length + " chars]";
}

export function renderDetail(entry: TraceEntry): void {
  const glyph = sb.detailGlyph;
  const titleEl = sb.detailTitle;
  const body = sb.detailBody;
  const detail = sb.detailEl;
  if (!detail || !glyph || !titleEl || !body) return;
  detail.hidden = false;
  const warn = isWarn(entry);
  glyph.textContent = warn ? "⚠" : entry.kind === "question" ? "?" : "◇";
  glyph.style.color = warn ? "var(--yellow)" : "var(--accent)";
  titleEl.textContent = rowLabel(entry);
  body.textContent = "";

  const meta = el("div");
  meta.appendChild(el("h5", "", t("web.sidebar.detail_metadata")));
  const d = entry.ts ? new Date(entry.ts) : null;
  if (entry.kind === "tool" || entry.kind === "tool_fail") {
    meta.appendChild(
      kv(
        t("web.sidebar.detail_status"),
        entry.success === false ? t("web.sidebar.detail_fail") : t("web.sidebar.detail_ok"),
      ),
    );
    if (entry.durationMs)
      meta.appendChild(kv(t("web.sidebar.detail_duration"), formatMs(entry.durationMs)));
  }
  if (d) meta.appendChild(kv(t("web.sidebar.detail_time"), d.toLocaleTimeString()));
  if (entry.toolCallId)
    meta.appendChild(kv(t("web.sidebar.detail_tool_call"), String(entry.toolCallId)));
  if (sb.el && sb.el.dataset.sid)
    meta.appendChild(kv(t("web.sidebar.detail_session"), sb.el.dataset.sid));
  meta.appendChild(kv(t("web.sidebar.detail_turn"), String(entry.turn)));
  if (typeof entry.iteration === "number")
    meta.appendChild(kv(t("web.sidebar.detail_iteration"), String(entry.iteration)));
  if (entry.kind === "retract" && entry.source)
    meta.appendChild(kv(t("web.sidebar.detail_source"), retractSourceLabel(entry.source)));
  if (entry.kind === "retract" && entry.verdict)
    meta.appendChild(kv(t("web.sidebar.detail_verdict"), String(entry.verdict)));
  body.appendChild(meta);

  if (entry.kind === "tool" || entry.kind === "tool_fail") {
    body.appendChild(
      detailGroup(
        t("web.sidebar.detail_arguments"),
        codeBlock(JSON.stringify(entry.args || {}, null, 2)),
      ),
    );
    body.appendChild(
      detailGroup(t("web.sidebar.detail_output"), codeBlock(capOutput(entry.output))),
    );
  } else if (entry.kind === "text") {
    body.appendChild(detailGroup(t("web.sidebar.detail_text"), codeBlock(entry.text || "")));
    loadTextProvenance(entry);
  } else if (entry.kind === "reasoning") {
    body.appendChild(detailGroup(t("web.sidebar.detail_reasoning"), codeBlock(entry.text || "")));
  } else if (entry.kind === "plan") {
    const list = el("div");
    (entry.steps || []).forEach((s: Dict) => {
      const mark =
        s.status === "done"
          ? "✓"
          : s.status === "failed"
            ? "✗"
            : s.status === "in_progress"
              ? "▸"
              : "○";
      const cls =
        s.status === "failed"
          ? "fail"
          : s.status === "in_progress"
            ? "cur"
            : s.status === "done"
              ? "done"
              : "";
      list.appendChild(el("div", ("plan-step " + cls).trim(), mark + " " + s.text));
    });
    body.appendChild(detailGroup(t("web.sidebar.detail_plan"), list));
  } else if (entry.kind === "question") {
    body.appendChild(detailGroup(t("web.sidebar.trace_question"), codeBlock(entry.text || "")));
  } else if (entry.kind === "error") {
    body.appendChild(detailGroup(t("web.sidebar.detail_error"), codeBlock(entry.message || "")));
  } else if (
    entry.kind === "status" ||
    entry.kind === "log" ||
    entry.kind === "retract" ||
    entry.kind === "index" ||
    entry.kind === "critic" ||
    entry.kind === "compaction" ||
    entry.kind === "probe" ||
    entry.kind === "usage" ||
    entry.kind === "audit" ||
    entry.kind === "claim" ||
    entry.kind === "output" ||
    entry.kind === "gate"
  ) {
    const title =
      entry.kind === "log" && entry.level
        ? "log · " + entry.level
        : entry.kind === "index" && entry.phase
          ? "index · " + entry.phase
          : entry.kind === "critic" && entry.status
            ? "critic · " + entry.status
            : entry.kind === "claim" && entry.subkind
              ? "claim_retry · " + entry.subkind
              : rowLabel(entry);
    body.appendChild(detailGroup(title, codeBlock(entry.text || "")));
    if (entry.kind === "retract")
      body.appendChild(el("div", "dim", t("web.sidebar.detail_retract_normal")));
  }
}

/**
 * Привязка текста хода к session-логу: сколько assistant-сообщений в сессии,
 * их итерации и провенанс последнего LLM-вызова (модель/провайдер/токены).
 * Живой текст хода уже показан выше целиком; это — сверка с логом.
 */
async function loadTextProvenance(entry: TraceEntry): Promise<void> {
  const sid = sb.el && sb.el.dataset.sid;
  const body = sb.detailBody;
  if (!sid || !body || sb.selected !== entry.id) return;
  try {
    const r = await api<{ log?: Dict[] }>(
      "/api/sessions/" + encodeURIComponent(sid) + "/log?types=assistant,llm_usage&limit=20",
    );
    if (!r.ok || !r.data || !Array.isArray(r.data.log) || sb.selected !== entry.id) return;
    const log = r.data.log;
    const assistants = log.filter((e) => e.type === "assistant");
    const usages = log.filter((e) => e.type === "llm_usage");
    const iters = assistants.map((e) => e.iteration).filter((n) => typeof n === "number");
    const last = usages.length > 0 ? usages[usages.length - 1] : null;
    const bits = [
      t("web.sidebar.detail_provenance_count", { n: assistants.length }) +
        (iters.length > 0 ? " · iter " + Math.min(...iters) + "–" + Math.max(...iters) : ""),
      last
        ? [
            last.model || last.provider,
            last.totalTokens ?? (last.promptTokens || 0) + (last.completionTokens || 0),
          ]
            .filter(Boolean)
            .join(" · ")
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (bits) body.appendChild(detailGroup(t("web.sidebar.detail_provenance"), codeBlock(bits)));
  } catch {
    /* best-effort: живой текст уже на месте */
  }
}
