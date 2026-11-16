/**
 * Тема из операционной системы: активная тема Omarchy Linux.
 *
 * Omarchy хранит текущую тему в `~/.config/omarchy/current/theme/colors.toml`
 * (плоский TOML: `accent = "#..."`, `background = "#..."`, …) и её имя в
 * `~/.config/omarchy/current/theme.name`. Читаем только Linux: на Windows/macOS
 * такого файла нет по определению, поэтому `omarchy: null`.
 *
 * Модуль сознательно не тянет TOML-парсер: файл плоский, значения — hex-цвета.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { sendJson } from "../util";

/** Плоский набор цветов из `colors.toml` (ключ → `#rrggbb`). */
export interface OmarchyColors {
  [key: string]: string;
}

export interface OmarchyTheme {
  /** Имя активной темы (`theme.name`), если записано. */
  name: string | null;
  /** Фон светлый или тёмный — из `mode = "light"|"dark"`. */
  mode: "dark" | "light";
  colors: OmarchyColors;
}

/** Ответ `GET /api/os-theme`. */
export interface OsThemeInfo {
  /**
   * `true` только на Linux. Булево, а не строка платформы: DLP-фильтр API
   * заменяет value-based идентификаторы машины (`linux`, `win32`) на токены
   * для не-loopback клиентов, и группа «ОС» молча исчезала бы.
   */
  available: boolean;
  /** `null` — не Linux, Omarchy не установлена или тема не выбрана. */
  omarchy: OmarchyTheme | null;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Каталог текущей темы Omarchy (`XDG_CONFIG_HOME` учитывается). */
export function defaultOmarchyDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "omarchy", "current");
}

/**
 * Разбирает `colors.toml`. Понимает и старый формат (`color0…color15`), и
 * новый семантический (`accent`, `background`, `red`, `bright_blue`, …).
 * Возвращает только валидные hex-цвета, нормализованные к нижнему регистру.
 */
export function parseOmarchyColors(raw: string): Omit<OmarchyTheme, "name"> {
  const colors: OmarchyColors = {};
  let mode: "dark" | "light" = "dark";
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
    if (key === "mode") {
      if (value === "light" || value === "dark") mode = value;
      continue;
    }
    if (HEX_COLOR.test(value)) colors[key] = value.toLowerCase();
  }
  return { mode, colors };
}

function readText(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * Читает активную тему из `currentDir` (по умолчанию — `~/.config/omarchy/current`).
 * @returns `null`, если файла цветов нет или он пуст.
 */
export function readOmarchyTheme(currentDir = defaultOmarchyDir()): OmarchyTheme | null {
  const themeDir = join(currentDir, "theme");
  const raw = readText(join(themeDir, "colors.toml"));
  if (!raw) return null;
  const parsed = parseOmarchyColors(raw);
  if (!Object.keys(parsed.colors).length) return null;
  const storedName = readText(join(currentDir, "theme.name"))?.trim();
  return {
    name: storedName || null,
    mode: parsed.mode,
    colors: parsed.colors,
  };
}

/** Снимок для фронтенда: доступность OS-тем + активная тема Omarchy (только Linux). */
export function getOsThemeInfo(
  platform: string = process.platform,
  currentDir: string = defaultOmarchyDir(),
): OsThemeInfo {
  if (platform !== "linux") return { available: false, omarchy: null };
  return { available: true, omarchy: readOmarchyTheme(currentDir) };
}

/** `GET /api/os-theme`. */
export function handleOsThemeGet(res: ServerResponse): void {
  sendJson(res, 200, getOsThemeInfo());
}
