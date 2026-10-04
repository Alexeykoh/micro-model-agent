/**
 * Best-effort матчер `.gitignore` / `.mmaignore` для обхода проекта.
 *
 * Не переизобретает полный git-синтаксис, но покрывает практичные случаи:
 * комментарии, пустые строки, `!`-негация, якорь по `/`, `dir/`, `*`, `?`,
 * `**`. `fail-open`: нечитаемый/битый файл игноров не ломает обход — правило
 * просто не применяется. Семантика «последнее совпадение выигрывает».
 */

/** Скомпилированный матчер игноров дерева. */
export interface IgnoreMatcher {
  /** True, если путь (относительный, posix) игнорируется. */
  ignores(relPath: string, isDir: boolean): boolean;
}

interface IgnoreRule {
  re: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

const NULL_MATCHER: IgnoreMatcher = { ignores: () => false };

/** Экранирует активные спецсимволы regex (кроме `*`/`?`, обрабатываемых отдельно). */
function escapeRegex(ch: string): string {
  return "\\^$.|+()[]{}".includes(ch) ? `\\${ch}` : ch;
}

/** Конвертирует gitignore-glob в regex-тело (без якорей). */
function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

/** Снимает `!`/экранирующий префикс; возвращает negation-флаг и остаток. */
function splitNegation(line: string): { negated: boolean; pattern: string } {
  if (line.startsWith("!")) return { negated: true, pattern: line.slice(1) };
  if (line.startsWith("\\#") || line.startsWith("\\!")) {
    return { negated: false, pattern: line.slice(1) };
  }
  return { negated: false, pattern: line };
}

/** Собирает regex-правило; null на невалидном glob. */
function buildRule(
  pattern: string,
  negated: boolean,
  dirOnly: boolean,
  anchored: boolean,
): IgnoreRule | null {
  const body = globToRegex(pattern);
  const source = anchored ? `^${body}$` : `(?:^|/)${body}$`;
  try {
    return { re: new RegExp(source), negated, dirOnly };
  } catch {
    return null;
  }
}

/** Парсит одну строку игнора; null для пустой/комментария. */
function parseRule(raw: string): IgnoreRule | null {
  const line = raw.replace(/\s+$/, "");
  if (!line || line.startsWith("#")) return null;

  const { negated, pattern: afterBang } = splitNegation(line);
  const rootAnchored = afterBang.startsWith("/");
  const unrooted = rootAnchored ? afterBang.slice(1) : afterBang;
  const dirOnly = unrooted.endsWith("/");
  const pattern = dirOnly ? unrooted.slice(0, -1) : unrooted;
  if (!pattern) return null;

  return buildRule(pattern, negated, dirOnly, rootAnchored || pattern.includes("/"));
}

/** Компилирует содержимое файла игноров в правила. */
function compile(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of content.split(/\r?\n/)) {
    const rule = parseRule(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Читает `.gitignore` и `.mmaignore` из корня проекта (оба — если есть,
 * порядок: `.gitignore`, затем `.mmaignore` — поздние правила побеждают).
 */
export function loadIgnoreMatcher(
  baseDir: string,
  readFile: (path: string) => string | null,
): IgnoreMatcher {
  const rules: IgnoreRule[] = [];
  for (const name of [".gitignore", ".mmaignore"]) {
    let content: string | null = null;
    try {
      content = readFile(`${baseDir}/${name}`);
    } catch {
      content = null;
    }
    if (content) rules.push(...compile(content));
  }
  if (rules.length === 0) return NULL_MATCHER;

  return {
    ignores(relPath: string, isDir: boolean): boolean {
      const target = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
      if (!target) return false;
      // Кандидаты: сам путь + все каталоги-предки. Каталог-паттерн `dir/`
      // обязан вычёркивать и `dir/file`, поэтому предки проверяются как dir.
      const segments = target.split("/");
      const targets: Array<{ path: string; isDir: boolean }> = [];
      for (let i = 1; i < segments.length; i++) {
        targets.push({ path: segments.slice(0, i).join("/"), isDir: true });
      }
      targets.push({ path: target, isDir });

      let ignored = false;
      for (const rule of rules) {
        if (rule.dirOnly && !targets.some((t) => t.isDir)) continue;
        const hit = targets.some(
          (t) => (!rule.dirOnly || t.isDir) && rule.re.test(t.path),
        );
        if (hit) ignored = !rule.negated;
      }
      return ignored;
    },
  };
}
