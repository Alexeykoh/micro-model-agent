import stringWidth from "string-width";
import { pc } from "./colors";
import { getTerminalWidth } from "./table";

export interface BoxOptions {
  title?: string;
  width?: number;
  padding?: number;
}

/** Wrap a string to `width` columns, keeping ANSI codes intact. */
export function wrapText(text: string, width: number): string[] {
  if (width < 1) return text ? [text] : [];
  const lines: string[] = [];
  let current = "";

  const push = (token: string): void => {
    const candidate = current ? `${current} ${token}` : token;
    if (stringWidth(candidate) <= width) {
      current = candidate;
      return;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    if (stringWidth(token) <= width) {
      current = token;
      return;
    }
    let acc = "";
    for (const ch of token) {
      if (stringWidth(acc + ch) <= width) {
        acc += ch;
      } else {
        lines.push(acc);
        acc = ch;
      }
    }
    current = acc;
  };

  for (const token of text.split(/\s+/)) {
    if (token) push(token);
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function padTo(text: string, width: number): string {
  const gap = Math.max(0, width - stringWidth(text));
  return text + " ".repeat(gap);
}

/** Render a box with an optional title embedded in the top border. */
export function box(lines: string[], opts: BoxOptions = {}): string[] {
  const pad = opts.padding ?? 1;
  const width = Math.max(20, Math.min(opts.width ?? getTerminalWidth(), 120));
  const inner = Math.max(1, width - 2 - pad * 2);

  const wrapped: string[] = [];
  for (const line of lines) {
    for (const part of wrapText(line, inner)) wrapped.push(part);
  }

  const out: string[] = [];

  const title = opts.title ?? "";
  if (title) {
    const head = `─ ${title} `;
    out.push(pc.dim(`┌${head}${"─".repeat(Math.max(0, width - 2 - stringWidth(head)))}┐`));
  } else {
    out.push(pc.dim(`┌${"─".repeat(width - 2)}┐`));
  }

  for (const line of wrapped) {
    out.push(pc.dim("│") + " ".repeat(pad) + padTo(line, inner) + " ".repeat(pad) + pc.dim("│"));
  }

  out.push(pc.dim(`└${"─".repeat(width - 2)}┘`));
  return out;
}

/** A horizontal rule that respects the terminal width (max 60 cols). */
export function divider(width?: number): string {
  const w = Math.min(width ?? getTerminalWidth(), 60);
  return pc.dim("─".repeat(w));
}
