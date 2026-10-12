// Покрытие плана: упомянутые в задаче файлы обязаны встречаться в шагах.
import { stripUrls } from "../../core/hallucination/js-identifiers";

/**
 * Coverage-allow-list расширений. Считаются только реальные типы deliverable-
 * файлов: проза `e.g` / `i.e` (расширения `g`/`e`) за файлы не сойдёт, а
 * web/doc-результаты (`.css`, `.html`, `.scss`, `.md`) проверяются —
 * старый deny-list их молча пропускал.
 */
const COVERAGE_EXT = new Set([
  // Код
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java",
  "kt", "kts", "cs", "php", "swift", "c", "cc", "cpp", "cxx", "h", "hpp",
  "lua", "pl", "sh", "bash", "zsh", "bat", "cmd", "ps1", "sql", "vue",
  "svelte", "dart", "scala", "clj",
  // web / доки / конфиги
  "css", "scss", "less", "html", "htm", "md", "mdx", "json", "json5",
  "toml", "yaml", "yml", "ini", "env", "txt",
]);

const FILE_PATH_RE = /\b[\w./\\-]+\.[a-z]{1,6}\b/gi;

/**
 * Извлекает пути файлов (с расширениями), упомянутые в формулировке задачи.
 * Проверяет, покрывает ли сгенерированный план каждый требуемый файл.
 */
export function extractFilePaths(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of stripUrls(text).matchAll(FILE_PATH_RE)) {
    const p = m[0].replace(/[.,;:)\]>]+$/g, "");
    if (!p) continue;
    // Требуем настоящее имя: непустой stem перед расширением в последнем
    // сегменте (сегменты `tsx/.ts` / `.env` — не "файлы").
    const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    const last = slash >= 0 ? p.slice(slash + 1) : p;
    const dot = last.lastIndexOf(".");
    if (dot <= 0) continue;
    if (!COVERAGE_EXT.has(last.slice(dot + 1).toLowerCase())) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(p);
  }
  return result;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * Сравнивает файловые требования задачи с описаниями шагов плана. Требование
 * "покрыто", если его путь (или basename) есть хоть в одном шаге. Возвращает
 * недостающие пути.
 */
export function checkPlanCoverage(
  taskText: string,
  stepDescriptions: string[],
): { missing: string[] } {
  const taskPaths = extractFilePaths(taskText);
  if (taskPaths.length === 0) return { missing: [] };

  const stepText = stepDescriptions.map((s) => s.toLowerCase()).join("\n");
  const missing = taskPaths.filter((p) => {
    const lower = p.toLowerCase();
    const base = basename(lower);
    // Шаг с полным относительным путём или его basename — засчитывается.
    return !stepText.includes(lower) && !stepText.includes(base);
  });

  return { missing };
}
