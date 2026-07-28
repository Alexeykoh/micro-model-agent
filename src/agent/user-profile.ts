import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform, version as osVersion, hostname } from "node:os";

/**
 * Профиль пользователя — автоматический сбор наблюдений.
 *
 * Собирает данные:
 * - OS (platform, version, hostname) — при старте REPL
 * - Tech Stack (dependencies из package.json) — при старте REPL
 * - Coding Style (indent, quotes, semicolons) — после записи файлов
 * - Session Patterns (время начала/конца сессии) — старт/стоп REPL
 *
 * Записи версионируются с датой: [2026-07-18] content
 * При повторном обнаружении того же факта дата обновляется.
 * Записи старше 30 дней помечаются как (stale Nd ago).
 *
 * @module agent/user-profile
 */

// ─── Константы ──────────────────────────────────────────
const USER_DIR = join(homedir(), ".mma", "user");
const PROFILE_FILE = join(USER_DIR, "profile.md");
const COUNTER_FILE = join(USER_DIR, ".counter");
const STALE_DAYS = 30; // дни до пометки записи как stale

/** Секции профиля пользователя */
type Section =
  "OS" | "Tech Stack" | "Coding Style" | "Session Patterns" | "Notes";

/** Создаёт директорию профиля если не существует */
export function ensureUserDir(): void {
  if (!existsSync(USER_DIR)) mkdirSync(USER_DIR, { recursive: true });
}

/** Загружает содержимое профиля пользователя */
export function loadProfile(): string {
  ensureUserDir();
  try {
    return readFileSync(PROFILE_FILE, "utf-8");
  } catch {
    return "";
  }
}

/** Проверяет существует ли файл профиля */
export function profileExists(): boolean {
  ensureUserDir();
  return existsSync(PROFILE_FILE);
}

/** Внутренняя: загружает профиль или создаёт заголовок по умолчанию */
function getProfile(): string {
  ensureUserDir();
  try {
    return readFileSync(PROFILE_FILE, "utf-8");
  } catch {
    return "# User Profile\n";
  }
}

/** Внутренняя: записывает содержимое профиля */
function writeProfile(content: string): void {
  ensureUserDir();
  writeFileSync(PROFILE_FILE, content, "utf-8");
}

/** Возвращает сегодняшнюю дату в формате YYYY-MM-DD */
function today(): string {
  return new Date().toISOString().split("T")[0];
}

/** Считает количество дней между датой и текущим моментом */
function daysAgo(dateStr: string): number {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

/** Удаляет дату из строки записи для сравнения содержимого */
function stripDate(line: string): string {
  return line.replace(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*/, "- ").trim();
}

/** Проверяет содержит ли строка дату в формате [YYYY-MM-DD] */
function hasDate(line: string): boolean {
  return /^-\s*\[\d{4}-\d{2}-\d{2}\]/.test(line);
}

/**
 * Добавляет или обновляет запись в секции.
 * Если запись с таким же содержимым (без учёта даты) уже существует —
 * обновляет её дату (версия повышается). Иначе добавляет новую с сегодняшней датой.
 */
export function upsertEntry(section: string, content: string): void {
  let profile = getProfile();
  const sectionHeader = `## ${section}`;
  const date = today();
  const newLine = `- [${date}] ${content}`;

  const sectionIdx = profile.indexOf(sectionHeader);
  if (sectionIdx === -1) {
    profile += `\n${sectionHeader}\n${newLine}\n`;
    writeProfile(profile);
    return;
  }

  const sectionEnd = profile.indexOf("\n## ", sectionIdx + 1);
  const secStart = sectionIdx + sectionHeader.length + 1;
  const secEnd = sectionEnd === -1 ? profile.length : sectionEnd;
  const before = profile.slice(0, secStart);
  const after = profile.slice(secEnd);
  const sectionBody = profile.slice(secStart, secEnd);

  const lines = sectionBody.split("\n").filter((l) => l.trim());
  const strippedNew = stripDate(newLine);
  let found = false;
  const updated = lines.map((line) => {
    if (hasDate(line) && stripDate(line) === strippedNew) {
      found = true;
      return newLine;
    }
    return line;
  });

  if (!found) updated.push(newLine);

  writeProfile(before + "\n" + updated.join("\n") + "\n" + after);
}

/** Добавляет заметку в указанную секцию профиля */
export function appendNote(note: string, section: Section = "Notes"): void {
  upsertEntry(section, note);
}

/** Собирает информацию об ОС (вызывается при старте REPL, один раз) */
export function collectOS(): void {
  const existing = loadProfile();
  if (existing.includes("## OS")) return;

  const osVer = `${platform()} (${osVersion()})`;
  upsertEntry("OS", `Platform: ${platform()}`);
  upsertEntry("OS", `Version: ${osVer}`);
  upsertEntry("OS", `Node.js: ${process.version}`);
}

/**
 * Формирует блок для system prompt с учётом версионности.
 */
export function loadProfileSummary(): string {
  const profile = loadProfile();
  if (!profile) return "";

  const lines = profile.split("\n");
  const sections: string[] = [];
  let currentSection = "";
  let items: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentSection && currentSection !== "Notes" && items.length > 0) {
        sections.push(`  ${currentSection}: ${items.join(", ")}`);
      }
      currentSection = line.replace("## ", "").trim();
      items = [];
    } else if (
      line.startsWith("- ") &&
      currentSection &&
      currentSection !== "Notes"
    ) {
      const match = line.match(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*(.*)/);
      if (match) items.push(match[1].trim());
    }
  }
  if (currentSection && currentSection !== "Notes" && items.length > 0) {
    sections.push(`  ${currentSection}: ${items.join(", ")}`);
  }

  if (sections.length === 0) return "";

  return `\n## User Profile\n${sections.join("\n")}\n`;
}

/** Создаёт пустой профиль если не существует */
export function initDefaultProfile(): void {
  ensureUserDir();
  if (existsSync(PROFILE_FILE)) return;
  writeProfile("# User Profile\n\n");
}
