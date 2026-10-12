// Валидация, нормализация и рендер исходника черновика capability (вынесено из
// `drafts.ts`, правило ≤300). Без доступа к ФС — чистые функции.
import type { DraftSpec } from "./drafts";

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_DESCRIPTION = 400;
const MAX_CODE = 20_000;

/** Проверка описания capability. Возвращает текст проблемы или null. */
export function validateDraftSpec(spec: DraftSpec): string | null {
  if (!spec.name || !NAME_RE.test(spec.name)) return `name must match ${NAME_RE.source}`;
  if (!spec.description?.trim()) return "description is required";
  if (spec.description.length > MAX_DESCRIPTION) {
    return `description is longer than ${MAX_DESCRIPTION} chars`;
  }
  if (!spec.parameters || typeof spec.parameters !== "object") {
    return "parameters must be a JSON object schema";
  }
  if (!spec.code?.trim()) return "code is required";
  if (spec.code.length > MAX_CODE) return `code is longer than ${MAX_CODE} chars`;
  // Права обязательны: показываемое декларативное поле без единого заявления
  // ничего не значит.
  if (!Array.isArray(spec.permissions) || spec.permissions.length === 0) {
    return "permissions are required for a draft capability";
  }
  const syntax = validateDraftCode(spec.code);
  if (syntax) return `code has a syntax error: ${syntax}`;
  return null;
}

/**
 * Синтаксическая проверка тела хендлера **без исполнения**. Тело — обычные
 * стейтменты (с `return`), поэтому оборачиваем в стрелку и прогоняем через
 * `Bun.Transpiler`. Вне Bun (degraded Node-фолбэк) проверку пропускаем.
 */
export function validateDraftCode(code: string): string | null {
  if (!code.trim() || typeof Bun === "undefined") return null;
  try {
    new Bun.Transpiler({ loader: "ts" }).transformSync(`async (ctx, args) => {\n${code}\n}`);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Причёсывает тело хендлера: CRLF→LF, dedent, ≤1 пустая строка, финальный `\n`. */
export function normalizeDraftCode(code: string): string {
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indents = lines
    .filter((l) => l.trim())
    .map((l) => (l.match(/^[ \t]*/) as RegExpMatchArray)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  const out: string[] = [];
  let blank = 0;
  for (const raw of lines) {
    const line = raw.slice(min).replace(/\s+$/, "");
    if (line) {
      blank = 0;
      out.push(line);
    } else {
      blank += 1;
      if (blank <= 1) out.push("");
    }
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

/**
 * Собрать исходник плагина из описания capability. Никакого `eval`: тело
 * хендлера пишется в файл как есть и исполняется загрузчиком плагинов.
 */
export function renderDraft(spec: DraftSpec): string {
  const perms = JSON.stringify(spec.permissions);
  const body = normalizeDraftCode(spec.code)
    .split("\n")
    .map((l) => (l ? `  ${l}` : l))
    .join("\n");
  return `// Черновик capability "${spec.name}", создан агентом через define_capability.
// Файл НЕ выполняется, пока пользователь не разрешит черновики этого проекта
// (mma plugins drafts approve). Код ниже написан агентом и исполняется в процессе агента.
const handler = async (ctx, args) => {
${body}};

export default {
  name: ${JSON.stringify(spec.name)},
  version: "0.0.1",
  description: ${JSON.stringify(spec.description)},
  permissions: ${perms},
  getToolDefinitions: () => [
    {
      name: ${JSON.stringify(spec.name)},
      description: ${JSON.stringify(spec.description)},
      parameters: ${JSON.stringify(spec.parameters, null, 2)},
      handler,
    },
  ],
};
`;
}
