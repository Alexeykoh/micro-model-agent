/** Обнаружение и загрузка инструкций (AGENTS.md / CLAUDE.md / config.sources). */
import { existsSync, globSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, relative, sep } from "path";
import { projectMmaDir } from "../../config/paths";
import { estimateTokens } from "../../llm/token-counter";
import type { PromptBlock } from "../types";

/** Каталоги, в которые обход вложенных AGENTS.md не заходит. */
const AGENTS_SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".mma", "dist", ".cache"]);

/** Максимальная глубина обхода вложенных AGENTS.md (каталогов от baseDir). */
const AGENTS_MAX_DEPTH = 4;

/** Максимальное число вложенных AGENTS.md в промпте. */
const AGENTS_MAX_NESTED = 5;

/**
 * Ищет вложенные инструкции под `baseDir`: обход до глубины 4, скип служебных
 * каталогов. Не падает на нечитаемых каталогах.
 */
function nestedInstructionPaths(baseDir: string, fileName: string): string[] {
  const found: Array<{ path: string; depth: number }> = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (AGENTS_SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (entry === fileName) {
        if (depth < AGENTS_MAX_DEPTH) found.push({ path: full, depth });
        continue;
      }
      if (depth + 1 < AGENTS_MAX_DEPTH) walk(full, depth + 1);
    }
  };
  walk(baseDir, 0);
  found.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  return found.slice(0, AGENTS_MAX_NESTED).map((f) => f.path);
}

/** Вложенные `AGENTS.md` (публичный враппер для тестов и фазы workspace). */
export function nestedAgentsMdPaths(baseDir: string): string[] {
  return nestedInstructionPaths(baseDir, "AGENTS.md");
}

/**
 * Инструкции в каталогах от workspace вверх до дома (если дом — предок).
 * Для workspace вне дома возвращает пустой список (стоп на корне проекта).
 */
function upwardInstructionPaths(baseDir: string, fileName: string): string[] {
  const home = homedir();
  const start = relative(home, baseDir);
  if (start.startsWith("..") || isAbsolute(start)) return [];
  const found: string[] = [];
  let dir = dirname(baseDir);
  for (;;) {
    const rel = relative(home, dir);
    if (rel.startsWith("..") || isAbsolute(rel)) break;
    const candidate = join(dir, fileName);
    if (existsSync(candidate)) found.push(candidate);
    if (rel === "") break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/**
 * Кандидаты инструкций по приоритету: проект, проектный `.mma`, вложенные,
 * вверх до дома, глобальный. `CLAUDE.md` — fallback, если файла нет.
 */
export function agentsMdPaths(
  baseDir: string,
  configDir: string,
  fallback: "claude" | "none" = "none",
): string[] {
  const noProject = process.env.OPENCODE_DISABLE_PROJECT_CONFIG === "1";
  const useClaude =
    fallback === "claude" && process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT !== "1";
  const explicit: string[] = noProject
    ? []
    : [join(baseDir, "AGENTS.md"), join(projectMmaDir(baseDir), "AGENTS.md")];
  // Nested-обход тоже находит корневой AGENTS.md (depth 0) — без фильтра он
  // попадался в промпт дважды (2× токены, дубль варнингов dry-run).
  const explicitSet = new Set(explicit);
  const nested = noProject
    ? []
    : nestedAgentsMdPaths(baseDir).filter((p) => !explicitSet.has(p));
  const upward = noProject ? [] : upwardInstructionPaths(baseDir, "AGENTS.md");
  const global = join(configDir, "AGENTS.md");
  const candidates = [...explicit, ...upward, ...nested, global];
  if (!useClaude) return [...new Set(candidates)];

  const withFallback = candidates.map((p) => {
    if (existsSync(p)) return p;
    if (p === global) return join(homedir(), ".claude", "CLAUDE.md");
    return join(dirname(p), "CLAUDE.md");
  });
  const claudeNested = noProject
    ? []
    : nestedInstructionPaths(baseDir, "CLAUDE.md").filter(
        (p) => !withFallback.some((x) => dirname(x) === dirname(p)),
      );
  const claudeUpward = noProject ? [] : upwardInstructionPaths(baseDir, "CLAUDE.md");
  return [
    ...new Set([
      ...withFallback,
      ...claudeUpward,
      ...claudeNested,
      join(homedir(), ".claude", "CLAUDE.md"),
    ]),
  ];
}

/**
 * Разрешает один законфигурированный источник: `~/`, абсолютный путь или glob.
 * Отсутствующие файлы молча пропускаются; пустые строки игнорируются.
 * HTTPS-источники пока не поддерживаются (синхронный загрузчик) — DEBT(ins-url-sources).
 */
function resolveSourcePattern(baseDir: string, raw: string): string[] {
  const source = raw.trim();
  if (!source || source.startsWith("http://") || source.startsWith("https://")) return [];
  const expanded = source.startsWith("~/") ? join(homedir(), source.slice(2)) : source;
  const absolute = isAbsolute(expanded) ? expanded : join(baseDir, expanded);
  const pattern = absolute.split(sep).join("/");
  try {
    return globSync(pattern).filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return existsSync(absolute) ? [absolute] : [];
  }
}

/**
 * Грузит инструкции по приоритету. Каждый непустой файл — блок высокого
 * приоритета; корневой блок `essential`, вложенные сжимаются по отдельности.
 */
export function loadAgentsMdBlocks(
  baseDir: string,
  dir: string,
  skip: boolean,
  extraSources: string[] = [],
  fallback: "claude" | "none" = "none",
): PromptBlock[] {
  if (skip) return [];
  const blocks: PromptBlock[] = [];
  const configured = extraSources.flatMap((raw) => resolveSourcePattern(baseDir, raw));
  const candidates = [...new Set([...agentsMdPaths(baseDir, dir, fallback), ...configured])];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf-8").trim();
    if (!content) continue;
    // Вложенные помечаем относительным путём, чтобы модель видела поддерево.
    const rel = relative(baseDir, p).split(sep).join("/");
    const label = rel.includes("/")
      ? `instructions (${rel.replace(/\/AGENTS\.md$/, "/")})`
      : "instructions";
    blocks.push({
      source: "agents-md",
      label,
      content,
      priority: "high",
      essential: label === "instructions",
      estimatedTokens: estimateTokens(content),
      kind: "instructions",
    });
  }
  return blocks;
}
