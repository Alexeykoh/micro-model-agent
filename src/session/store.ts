import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { getTheme } from "../styling/index.js";

/**
 * Хранение сессий агента.
 *
 * Сессии сохраняются в ~/.mma/sessions/ в виде JSON-файлов.
 * Индекс сессий в ~/.mma/sessions/index.json.
 *
 * Особенности:
 * - Читаемые ID (00001-snake-base-tutorial)
 * - Автосохранение при завершении
 * - Ограничение: 50 сессий, 10MB каждая
 * - Автообрезка при превышении лимита
 *
 * @module session/store
 */

// ─── Константы ──────────────────────────────────────────
const SESSIONS_DIR = join(homedir(), ".mma", "sessions");
const INDEX_FILE = join(SESSIONS_DIR, "index.json");
const MAX_SESSIONS = 50;
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/** Генерирует короткий ID сессии */
export function generateReadableId(): string {
  return randomUUID().slice(0, 8);
}

/** Сообщение сессии */
export interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
}

/** Сессия агента */
export interface Session {
  id: string;
  name: string;
  created: string;
  provider: string;
  cwd: string;
  messages: SessionMessage[];
  context: {
    totalTokens: number;
    compactCount: number;
  };
  /** Режим агента (fast/base/pro/custom) */
  mode?: string;
}

interface SessionIndex {
  sessions: { id: string; name: string; created: string; size: number }[];
}

/** Создаёт директорию сессий если не существует */
function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

/** Загружает индекс сессий */
function loadIndex(): SessionIndex {
  ensureDir();
  try {
    if (existsSync(INDEX_FILE)) {
      return JSON.parse(readFileSync(INDEX_FILE, "utf-8"));
    }
  } catch {
    /* ignore */
  }
  return { sessions: [] };
}

/** Сохраняет индекс сессий */
function saveIndex(index: SessionIndex): void {
  ensureDir();
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
}

/** Сохраняет сессию в файл. Автосокращение при превышении 10MB. */
export function saveSession(session: Session): string {
  ensureDir();

  const filePath = join(SESSIONS_DIR, `${session.id}.json`);
  const content = JSON.stringify(session, null, 2);

  if (content.length > MAX_SIZE_BYTES) {
    console.log(
      getTheme().warning(
        `  Warning: session too large (${Math.round(content.length / 1024)}KB), truncating messages`,
      ),
    );
    session.messages = session.messages.slice(-50);
    return saveSession(session);
  }

  writeFileSync(filePath, content, "utf-8");

  const index = loadIndex();
  const existing = index.sessions.findIndex((s) => s.id === session.id);
  const entry = {
    id: session.id,
    name: session.name,
    created: session.created,
    size: content.length,
  };

  if (existing >= 0) {
    index.sessions[existing] = entry;
  } else {
    index.sessions.unshift(entry);
  }

  // Cleanup old sessions
  while (index.sessions.length > MAX_SESSIONS) {
    const oldest = index.sessions.pop();
    if (oldest) {
      const oldPath = join(SESSIONS_DIR, `${oldest.id}.json`);
      try {
        unlinkSync(oldPath);
      } catch {
        /* ignore */
      }
    }
  }

  saveIndex(index);
  return filePath;
}

/** Загружает сессию по ID */
export function loadSession(id: string): Session | null {
  const filePath = join(SESSIONS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Возвращает список всех сессий из индекса */
export function listSessions(): {
  id: string;
  name: string;
  created: string;
  size: number;
}[] {
  return loadIndex().sessions;
}

/** Создаёт автосессию (без имени, при завершении REPL) */
export function createAutoSession(
  messages: SessionMessage[],
  provider: string,
  cwd: string,
  context: Session["context"],
  mode?: string,
): string {
  const session: Session = {
    id: generateReadableId(),
    name: "",
    created: new Date().toISOString(),
    provider,
    cwd,
    messages,
    context,
    mode,
  };
  return saveSession(session);
}

/** Создаёт именованную сессию (при команде /save) */
export function createNamedSession(
  name: string,
  messages: SessionMessage[],
  provider: string,
  cwd: string,
  context: Session["context"],
  mode?: string,
): string {
  const session: Session = {
    id: generateReadableId(),
    name,
    created: new Date().toISOString(),
    provider,
    cwd,
    messages,
    context,
    mode,
  };
  return saveSession(session);
}

/** Форматирует список сессий для отображения */
export function formatSessionList(
  sessions: { id: string; name: string; created: string; size: number }[],
): string {
  const theme = getTheme();
  if (sessions.length === 0) return theme.dim("  No saved sessions.");

  const lines: string[] = [
    theme.info(`  Saved sessions (${sessions.length}):`),
  ];
  for (const s of sessions) {
    const date = new Date(s.created).toLocaleString("ru-RU");
    const name = s.name || "(auto)";
    const size = `${Math.round(s.size / 1024)}KB`;
    lines.push(
      `    ${theme.highlight(s.id)}  ${name}  ${theme.dim(date)}  ${size}`,
    );
  }
  return lines.join("\n");
}
