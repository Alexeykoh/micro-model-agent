// Транспорт и тексты встроенного `telegram-notify`: HTTP к Bot API,
// резолв chat_id, сборка сообщений. Чистые функции + инжектируемый fetch,
// чтобы тесты не трогали сеть. Файловые пути решает плагин.
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { fetchOutbound } from "../../security/outbound-policy";

export const TELEGRAM_HTTP_TIMEOUT_MS = 10_000;
export const TELEGRAM_MAX_TEXT_CHARS = 3800;

export type FetchJson = (url: string, payload: unknown) => Promise<unknown>;

/** POST JSON через политику исходящих вызовов (SSRF, W13) + таймаут. */
export async function fetchJson(url: string, payload: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_HTTP_TIMEOUT_MS);
  try {
    const res = await fetchOutbound(
      url,
      "module:telegram-notify",
      { operation: "telegram-notify.send" },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTelegramMessage(
  fetchImpl: FetchJson,
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
  });
}

export interface ChatIdCache {
  read: () => string | null;
  write: (chatId: string) => void;
}

/** chat_id: кэш → последний chat из getUpdates (и запись в кэш). */
export async function resolveChatId(
  fetchImpl: FetchJson,
  token: string,
  cache: ChatIdCache,
): Promise<string | null> {
  const cached = cache.read();
  if (cached) return cached;
  const data = (await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates`, {
    limit: 100,
    timeout: 0,
  })) as { result?: Array<Record<string, Record<string, { id?: unknown }>>> };
  const updates = Array.isArray(data.result) ? data.result : [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const update = updates[i];
    const chat =
      update.message?.chat ??
      update.edited_message?.chat ??
      update.channel_post?.chat ??
      update.my_chat_member?.chat;
    if (chat && chat.id != null) {
      const id = String(chat.id);
      cache.write(id);
      return id;
    }
  }
  return null;
}

/** Ветка git проекта (worktree-aware); null — не git. */
export function readGitBranch(projectDir: string | null): string | null {
  if (!projectDir) return null;
  try {
    const gitPath = join(projectDir, ".git");
    let headFile: string;
    try {
      if (!statSync(gitPath).isDirectory()) {
        const content = readFileSync(gitPath, "utf8").trim();
        const match = /^gitdir:\s*(.+)$/.exec(content);
        if (!match) return null;
        headFile = resolve(projectDir, match[1].trim(), "HEAD");
      } else {
        headFile = join(gitPath, "HEAD");
      }
    } catch {
      return null;
    }
    const head = readFileSync(headFile, "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1];
    if (/^[0-9a-f]{7,}$/i.test(head)) return head.slice(0, 7);
    return null;
  } catch {
    return null;
  }
}

export interface TurnExtras {
  branch: string | null;
  provider: string | null;
  model: string | null;
  text: string | null;
}

export interface TurnSummaryView {
  success: boolean;
  interrupted?: boolean;
  durationMs?: number;
  toolCalls?: number;
}

export interface SessionMeta {
  id?: unknown;
  name?: unknown;
  projectDir?: unknown;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function statusText(summary: TurnSummaryView): string {
  if (summary.interrupted) return "прервано";
  return summary.success ? "успех" : "ошибка";
}

function sessionLine(meta: SessionMeta | null): string | null {
  if (!meta || (meta.id == null && meta.name == null)) return null;
  const name = meta.name != null ? String(meta.name) : "—";
  const id = meta.id != null ? String(meta.id) : "";
  return id ? `Сессия: ${name} (${id})` : `Сессия: ${name}`;
}

function detailLine(extras: TurnExtras): string | null {
  const bits: string[] = [];
  if (extras.branch) bits.push(`Ветка: ${extras.branch}`);
  if (extras.provider) bits.push(`Провайдер: ${extras.provider}`);
  if (extras.model) bits.push(`Модель: ${extras.model}`);
  return bits.length ? bits.join(" · ") : null;
}

/** Короткая причина ошибки: message из JSON либо первая строка, кап 300. */
export function friendlyError(raw: unknown): string {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      const inner =
        parsed?.error && typeof parsed.error.message === "string"
          ? parsed.error.message
          : typeof parsed?.message === "string"
            ? parsed.message
            : null;
      if (inner?.trim()) return inner.trim().slice(0, 300);
    } catch {
      /* не JSON — первая строка ниже */
    }
  }
  return text.split(/\r?\n/)[0].slice(0, 300);
}

export function turnMessage(
  meta: SessionMeta | null,
  summary: TurnSummaryView,
  extras: TurnExtras,
  errText: string | null,
): string {
  const icon = summary.interrupted ? "⏹" : summary.success ? "✅" : "❌";
  const lines = [`${icon} MMA: ход завершён`];
  const sl = sessionLine(meta);
  if (sl) lines.push(sl);
  const dl = detailLine(extras);
  if (dl) lines.push(dl);
  const parts = [`Статус: ${statusText(summary)}`];
  if (typeof summary.durationMs === "number") parts.push(`${(summary.durationMs / 1000).toFixed(1)} с`);
  if (summary.toolCalls != null) parts.push(`${summary.toolCalls} тулов`);
  lines.push(parts.join(" · "));
  if (errText) lines.push(`Ошибка: ${errText}`);
  if (extras.text) {
    lines.push("");
    lines.push(clip(extras.text, TELEGRAM_MAX_TEXT_CHARS));
  }
  return lines.join("\n");
}

export function sessionEndMessage(meta: SessionMeta | null, extras: TurnExtras): string {
  const lines = ["🏁 MMA: сессия завершена"];
  const sl = sessionLine(meta);
  if (sl) lines.push(sl);
  const dl = detailLine(extras);
  if (dl) lines.push(dl);
  if (extras.text) {
    lines.push("");
    lines.push(clip(extras.text, TELEGRAM_MAX_TEXT_CHARS));
  }
  return lines.join("\n");
}

/** Финальный ответ ассистента — последнее непустое сообщение из истории. */
export function finalAssistantText(history: unknown): string | null {
  try {
    if (!Array.isArray(history)) return null;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i] as { role?: unknown; content?: unknown };
      if (msg?.role !== "assistant") continue;
      const content = msg.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter(
                  (p): p is { type: string; text: string } =>
                    !!p && (p as { type?: unknown }).type === "text",
                )
                .map((p) => String(p.text))
                .join("")
          : "";
      if (text.trim()) return text.trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}
