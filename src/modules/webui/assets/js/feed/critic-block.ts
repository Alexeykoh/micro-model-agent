// Свёрнутый блок проверки критика: одна строка в ленте, детали — под тогглом.
// По умолчанию закрыт ВСЕГДА (quiet/normal/verbose): это материал проверки, а не
// ответ модели. Хост — `onMeta kind: "critic"` → SSE `critic` (см. forward.ts).
import { el, setIcon } from "../dom.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";
import { activeFeed, appendTo, clearEmpty, feedForEvent, scroll } from "./core.js";
import { clearBusy } from "./busy.js";
import { clearStatusLines, finishMd } from "./stream.js";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function statusLabel(status: string): string {
  const key = "web.feed.critic_status." + status;
  return t(key);
}

function durationLabel(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function issueRow(issue: Dict): HTMLElement {
  const row = el("div", "critic-issue");
  const head = el("div", "critic-issue-head");
  head.appendChild(
    el("span", "critic-sev sev-" + (str(issue.severity) || "info"), str(issue.severity) || "info"),
  );
  head.appendChild(el("span", "critic-claim", str(issue.claim)));
  row.appendChild(head);
  if (str(issue.problem)) row.appendChild(el("div", "critic-problem", str(issue.problem)));
  if (str(issue.suggestion)) row.appendChild(el("div", "critic-suggestion", str(issue.suggestion)));
  if (str(issue.evidence)) row.appendChild(el("div", "critic-evidence", str(issue.evidence)));
  return row;
}

function checkRow(check: Dict): HTMLElement {
  const row = el("div", "critic-check");
  const mark = check.ok === false ? "✗" : check.ok === true ? "✓" : "·";
  row.appendChild(el("span", "critic-check-mark", mark));
  row.appendChild(el("span", "critic-check-tool", str(check.tool)));
  if (str(check.args)) row.appendChild(el("span", "critic-check-args", str(check.args)));
  if (str(check.output)) row.appendChild(el("div", "critic-check-out", str(check.output)));
  return row;
}

/**
 * Отрисовка итога проверки. Тело всегда `hidden`; раскрытие — общий
 * `.think-h`-обработчик (тот же, что у размышлений и отзыва черновика).
 */
export function onCritic(report: Dict | undefined, sid?: string): void {
  if (!report || typeof report !== "object") return;
  const feed = feedForEvent(sid);
  if (!feed) return;
  clearBusy(feed);
  clearEmpty(feed);
  finishMd(feed);
  clearStatusLines(feed);

  const status = str(report.status) || "none";
  const passes = num(report.passes);
  const duration = num(report.durationMs);
  const wrap = el("div", "think critic-block");
  const head = el("button", "think-h");
  head.type = "button";
  head.setAttribute("aria-expanded", "false");
  head.appendChild(el("span", "g", "◇"));
  head.appendChild(
    el(
      "span",
      "lab",
      t("web.feed.critic_head", {
        status: statusLabel(status),
        passes: String(passes),
        duration: durationLabel(duration),
      }),
    ),
  );
  const tog = el("span", "tog");
  setIcon(tog, "chevron-right", t("web.action.show"));
  head.appendChild(tog);

  const body = el("div", "think-body hidden");
  if (str(report.summary)) body.appendChild(el("div", "critic-summary", str(report.summary)));
  body.appendChild(
    el(
      "div",
      "critic-meta",
      [
        t("web.feed.critic_status_label", { status: statusLabel(status) }),
        t("web.feed.critic_passes", { n: String(passes) }),
        t("web.feed.critic_duration", { time: durationLabel(duration) }),
        ...(report.timedOut ? [t("web.feed.critic_timed_out")] : []),
      ].join(" · "),
    ),
  );

  const issues = Array.isArray(report.issues) ? (report.issues as Dict[]) : [];
  body.appendChild(el("div", "critic-sub", t("web.feed.critic_issues")));
  if (issues.length === 0)
    body.appendChild(el("div", "critic-none", t("web.feed.critic_no_issues")));
  else for (const issue of issues) body.appendChild(issueRow(issue));

  const checks = Array.isArray(report.checks) ? (report.checks as Dict[]) : [];
  if (checks.length > 0) {
    body.appendChild(el("div", "critic-sub", t("web.feed.critic_checks")));
    for (const check of checks) body.appendChild(checkRow(check));
  }

  wrap.appendChild(head);
  wrap.appendChild(body);
  appendTo(feed, wrap);
  if (feed === activeFeed()) scroll();
}
