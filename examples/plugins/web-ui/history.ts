/**
 * History backfill: read the tail of the active session's history.jsonl so a
 * freshly opened page shows the recent conversation instead of a blank pane.
 *
 * Path layout matches SessionStore: <configDir>/sessions/<id>/history.jsonl.
 * Best-effort — any read/parse failure yields an empty list, never a throw.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clip, scrub } from "./util";

export interface HistoryEntry {
  role: string;
  text: string;
  ts?: string;
}

/** Extract plain text from a content value (string or ContentPart array). */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (p.type === "image_url") return "[image]";
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

export function readHistoryTail(
  configDir: string | null,
  sessionId: string | undefined,
  tail = 30,
): HistoryEntry[] {
  if (!configDir || !sessionId) return [];
  const file = join(configDir, "sessions", sessionId, "history.jsonl");
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const out: HistoryEntry[] = [];
    for (const line of lines.slice(-tail)) {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const role = typeof msg.role === "string" ? msg.role : "?";
        if (role === "system") continue; // system prompt is not chat
        out.push({
          role,
          text: clip(scrub(contentToText(msg.content)), 4000),
          ts: typeof msg.timestamp === "string" ? msg.timestamp : undefined,
        });
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}
