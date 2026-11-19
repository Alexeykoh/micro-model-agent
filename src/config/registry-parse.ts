// Разбор и показ значений ключей конфига (bool/enum/int/share/list/json).
import { MAX_SHARE, MIN_SHARE, type ConfigKeyDef } from "./registry-key-def";

/** Человекочитаемое форматирование значения (bool → on/off, массивы через запятую). */
export function formatConfigValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/** Результат парсинга сырого значения: ок или "invalid". */
export type ParseResult = { ok: true; value: unknown } | { ok: false; reason: "invalid" };

function parseBool(raw: string): ParseResult {
  const v = raw.trim().toLowerCase();
  if (["on", "true", "1", "yes", "y", "enable", "enabled"].includes(v)) return { ok: true, value: true };
  if (["off", "false", "0", "no", "n", "disable", "disabled"].includes(v)) return { ok: true, value: false };
  return { ok: false, reason: "invalid" };
}

/** Парсит сырую строку по типу ключа (bool/enum/int/share/list/json). */
export function parseConfigValue(def: ConfigKeyDef, raw: string): ParseResult {
  const trimmed = raw.trim();
  switch (def.valueType) {
    case "string":
      if (trimmed.length === 0) {
        return def.allowEmpty ? { ok: true, value: "" } : { ok: false, reason: "invalid" };
      }
      return { ok: true, value: trimmed };
    case "bool":
      return parseBool(trimmed);
    case "enum": {
      const v = trimmed.toLowerCase();
      if (def.enumValues && !def.enumValues.includes(v)) return { ok: false, reason: "invalid" };
      return { ok: true, value: v };
    }
    case "int": {
      if (!/^-?\d+$/.test(trimmed)) return { ok: false, reason: "invalid" };
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { ok: false, reason: "invalid" };
      if (def.min !== undefined && n < def.min) return { ok: false, reason: "invalid" };
      if (def.max !== undefined && n > def.max) return { ok: false, reason: "invalid" };
      return { ok: true, value: n };
    }
    case "share": {
      // Доля (0.1) или проценты (10%).
      const isPct = trimmed.endsWith("%");
      const body = isPct ? trimmed.slice(0, -1).trim() : trimmed;
      if (!/^-?\d+(\.\d+)?$/.test(body)) return { ok: false, reason: "invalid" };
      let n = Number(body);
      if (isPct) n = n / 100;
      if (!Number.isFinite(n) || n < MIN_SHARE || n > MAX_SHARE) return { ok: false, reason: "invalid" };
      return { ok: true, value: n };
    }
    case "list": {
      if (trimmed.length === 0) return { ok: true, value: [] };
      // Структурные редакторы постят JSON-массив (значения могут содержать запятые,
      // напр. regex вида `a{1,3}`); REPL держит синтаксис через запятую.
      if (trimmed.startsWith("[")) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
            return { ok: true, value: parsed };
          }
        } catch {
          /* fall through to comma splitting */
        }
      }
      const items = trimmed.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      return { ok: true, value: items };
    }
    case "json": {
      if (trimmed.length > 20000) return { ok: false, reason: "invalid" };
      try {
        return { ok: true, value: JSON.parse(trimmed) };
      } catch {
        return { ok: false, reason: "invalid" };
      }
    }
  }
}
