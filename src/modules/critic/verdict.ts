// Разбор вердикта критика: сырой текст модели → типизированный вердикт.
//
// Вынесено из `client.ts` (файл был на пределе правила «≤300 строк»).
// Инварианты (спека W2, INV-C2/INV-C3):
//   • вердикт не теряется из-за регистра/пробелов в `status`/`severity`;
//   • код-fences и хвостовая проза НЕ делают вердикт «починенным» —
//     «починен» только JSON, который без jsonrepair не разбирается;
//   • `checks` читаются независимо от `status`: ответ `{"checks":[...]}`
//     без статуса — валидный запрос проверок, а не мусор.
import { jsonrepair } from "jsonrepair";
import type { CriticIssue, CriticVerdict } from "./types";

/** Допустимые статусы вердикта. */
const STATUSES = new Set(["ok", "concern", "critical"]);
/** Допустимые severities issue'а. */
const SEVERITIES = new Set(["info", "concern", "critical"]);

/** Вердикт + признак, что JSON пришлось чинить. */
export interface ParsedVerdict {
  verdict: CriticVerdict | null;
  repaired: boolean;
}

/** Сырые запрошенные проверки (кап применяет вызывающий). */
export type RawChecks = Array<{ tool: string; args?: Record<string, unknown> }> | undefined;

/** Результат строгого JSON.parse. */
function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Подстрока с JSON-объектом (код-fences, хвостовая проза). */
function jsonSlice(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

/**
 * Достаёт JSON-объект из ответа модели.
 *
 * Строгий путь: если объект разбирается как есть — вердикт НЕ «починен».
 * jsonrepair — только когда без него не обойтись (обрезанный по maxTokens
 * вердикт): там «починенный ok» может означать не то, что сказала модель,
 * и это уже деградация, а не мелочь.
 */
export function extractJsonObject(text: string): { obj: unknown; repaired: boolean } | null {
  const trimmed = text.trim();
  const whole = tryParse(trimmed);
  if (whole.ok) return { obj: whole.value, repaired: false };
  const slice = jsonSlice(trimmed);
  if (slice) {
    const strict = tryParse(slice);
    if (strict.ok) return { obj: strict.value, repaired: false };
  }
  try {
    const repaired = tryParse(jsonrepair(trimmed));
    if (repaired.ok) return { obj: repaired.value, repaired: true };
  } catch {
    // jsonrepair не вытащил — падаем на regex-путь ниже.
  }
  if (slice) {
    try {
      const repaired = tryParse(jsonrepair(slice));
      if (repaired.ok) return { obj: repaired.value, repaired: true };
    } catch {
      // чинить нечего.
    }
  }
  return null;
}

/** Нормализованный статус вердикта (регистр/пробелы не важны). */
function normalizeStatus(raw: unknown): CriticVerdict["status"] | null {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  return STATUSES.has(value) ? (value as CriticVerdict["status"]) : null;
}

/** Проблемы вердикта с санитизированным severity; записи без claim+problem дропаются. */
function parseIssuesList(raw: unknown): CriticIssue[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((i) => ({
      severity: (SEVERITIES.has(String(i.severity ?? "").trim().toLowerCase())
        ? String(i.severity).trim().toLowerCase()
        : "concern") as CriticIssue["severity"],
      claim: String(i.claim ?? ""),
      problem: String(i.problem ?? ""),
      suggestion: i.suggestion ? String(i.suggestion) : undefined,
      evidence: i.evidence ? String(i.evidence) : undefined,
    }))
    .filter((i) => i.claim || i.problem);
}

/** Сырые запрошенные проверки (с капом); форма + allowlist enforced в parseChecks. */
export function parseRawChecks(raw: unknown): RawChecks {
  if (!Array.isArray(raw)) return undefined;
  const out = (raw as unknown[])
    .filter(
      (c): c is { tool: string; args?: unknown } =>
        !!c && typeof c === "object" && typeof (c as { tool?: unknown }).tool === "string",
    )
    .map((c) => ({ tool: c.tool, args: c.args as Record<string, unknown> | undefined }));
  return out.length > 0 ? out : undefined;
}

/**
 * Парсит вердикт, различая «разобралось само» и «починили jsonrepair».
 * Второе — не ошибка парсинга, но и не доверие: починенный обрезанный вердикт
 * может оказаться `ok`, которого модель не говорила.
 */
export function parseVerdictDetailed(text: string): ParsedVerdict {
  const extracted = extractJsonObject(text);
  if (!extracted) return { verdict: null, repaired: false };
  const obj = extracted.obj;
  if (!obj || typeof obj !== "object") return { verdict: null, repaired: extracted.repaired };
  const rec = obj as Record<string, unknown>;
  const status = normalizeStatus(rec.status);
  if (!status) return { verdict: null, repaired: extracted.repaired };
  const issues = parseIssuesList(rec.issues);
  // Запрошенные проверки верификации (Phase 2): несём сырыми, кап здесь;
  // форма + allowlist enforced в parseChecks, вслепую не доверяем.
  const checks = parseRawChecks(rec.checks);
  return {
    verdict: { status, summary: String(rec.summary ?? ""), issues, ...(checks ? { checks } : {}) },
    repaired: extracted.repaired,
  };
}

/** Парсит вердикт из сырого текста. Null, если это не вердикт. */
export function parseVerdict(text: string): CriticVerdict | null {
  return parseVerdictDetailed(text).verdict;
}

/**
 * Достаёт запрошенные проверки из ответа модели БЕЗ требования `status`:
 * модель часто отвечает `{"checks":[...]}` — это валидный запрос проверок,
 * а не «неразбираемый вердикт».
 */
export function extractChecks(text: string): RawChecks {
  const extracted = extractJsonObject(text);
  if (!extracted) return undefined;
  const obj = extracted.obj;
  if (!obj || typeof obj !== "object") return undefined;
  return parseRawChecks((obj as Record<string, unknown>).checks);
}
