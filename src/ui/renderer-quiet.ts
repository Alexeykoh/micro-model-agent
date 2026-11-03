// Quiet-режим: свёртка recon-прогонов и повторов в одну строку (шов `renderer.ts`).
import type { OutputChannel } from "../output";
import { t } from "../i18n/index";
import { pc } from "./colors";
import { GUTTER } from "./renderer-body";
import { actionHead } from "./renderer-format";
import { formatDuration, glyph, successMark } from "./theme";

/**
 * Read-only тулы разведки. В quiet прогон сворачивается в `│ N actions ✓`.
 */
const RECON_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "file_info",
  "project_map",
  "chunk_query",
  "web_search",
  "web_fetch",
  "web_browse",
  "search_history",
  "recall",
  "session_info",
  "process_list",
  "process_log",
]);

interface ReconItem {
  tool: string;
  mark: string;
  label: string;
  summary: string;
  duration: number;
}

/** Результат действия, нужный quiet-свёртке (срез карточки тула). */
export interface QuietCard {
  tool: string;
  mark: string;
  label: string;
  summary: string;
  firstBody: string;
}

export class QuietFlow {
  private recon: ReconItem[] = [];
  /** Отложенная на шаг строка действия: повтор сворачивается в `×N`. */
  private pending: {
    key: string;
    leadMark: string;
    tool: string;
    label: string;
    summary: string;
    duration: number;
  } | null = null;
  private repeatCount = 0;
  private repeatMs = 0;

  constructor(private readonly channel: OutputChannel) {}

  /**
   * Quiet-футер: сворачивает отложенную шапку в одну строку действия.
   * Успешные read-only тулы буферятся в recon-сводку; подряд идущие одинаковые
   * успешные сворачиваются в строку `×N`; всё прочее буферится на шаг, чтобы
   * повтор успел свернуться. Ошибки печатаются сразу.
   */
  finish(card: QuietCard, duration: number, error: boolean | undefined, tail: string): void {
    const { tool, mark: leadMark, label, summary, firstBody } = card;
    // Прогон успешных read-only тулов буферится и суммируется.
    if (!error && RECON_TOOLS.has(tool)) {
      this.flushPending();
      this.recon.push({ tool, mark: leadMark, label, summary, duration });
      return;
    }
    // Подряд идущие одинаковые успешные действия (poll-циклы, повторные
    // статус-чеки) — в одну строку `×N` вместо N строк.
    const repeatKey = `${tool}::${label}::${summary}`;
    if (!error && this.pending?.key === repeatKey) {
      this.repeatCount += 1;
      this.repeatMs += duration;
      return;
    }
    this.flushPending();
    this.flushRecon();
    if (!error) {
      // Буфер на шаг: строка печатается на следующем действии (или любом сбросе),
      // чтобы идентичный повтор успел свернуться.
      this.pending = { key: repeatKey, leadMark, tool, label, summary, duration };
      return;
    }
    this.channel.writeRaw(`${actionHead(leadMark, tool, label, summary)}  ${tail}\n`);
    if (error && firstBody) {
      const soft = firstBody.startsWith("⚠");
      const color = soft ? pc.yellow : pc.red;
      this.channel.writeRaw(`${GUTTER}${pc.dim(glyph.detail)} ${color(firstBody)}\n`);
    }
  }

  /** Выпуск буферного прогона read-only действий (quiet). */
  flushRecon(): void {
    // Отложенная строка действия всегда старше любого буферного recon-прогона:
    // печатаем её первой, чтобы чат остался хронологичным.
    this.flushPending();
    if (this.recon.length === 0) return;
    const items = this.recon;
    this.recon = [];
    if (items.length === 1) {
      const it = items[0];
      const head = actionHead(it.mark, it.tool, it.label, it.summary);
      this.channel.writeRaw(`${head}  ${successMark()} ${pc.dim(formatDuration(it.duration))}\n`);
      return;
    }
    const total = items.reduce((a, b) => a + b.duration, 0);
    const label = t("ui.actions_summary", { count: String(items.length) });
    this.channel.writeRaw(
      `${pc.dim(glyph.group)} ${label} ${successMark()} ${pc.dim(`· ${formatDuration(total)}`)} ${pc.dim("· /verbose")}\n`,
    );
  }

  /** Печать отложенной строки, повторы сворачивает в одну строку `×N`. */
  private flushPending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const times = this.repeatCount + 1;
    const total = p.duration + this.repeatMs;
    this.repeatCount = 0;
    this.repeatMs = 0;
    const head = actionHead(p.leadMark, p.tool, p.label, p.summary);
    const timesPart = times > 1 ? ` ${pc.dim(`×${times}`)}` : "";
    this.channel.writeRaw(
      `${head}  ${successMark()} ${pc.dim(formatDuration(total))}${timesPart}\n`,
    );
  }
}
