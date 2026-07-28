import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Собирает контекст для субагента: список файлов, зависимости, tsconfig.
 * Сканирует все директории проекта (не только src/).
 *
 * @param cwd - корневая директория проекта
 * @returns Текстовый контекст для system prompt субагента
 */
export function buildSubagentContext(cwd: string): string {
  const lines: string[] = [];

  // Сканируем все директории в поисках исходных файлов
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        entry.name === "node_modules"
      )
        continue;
      const dirPath = join(cwd, entry.name);
      try {
        const files = (readdirSync(dirPath, { recursive: true }) as string[])
          .filter((f: string) => /\.(ts|tsx|js|jsx)$/.test(f))
          .slice(0, 20);
        if (files.length > 0) {
          lines.push(`Files in ${entry.name}/: ${files.join(", ")}`);
        }
      } catch {
        /* skip unreadable dirs */
      }
    }
  } catch {
    /* no entries */
  }

  // Корневые .ts/.js файлы
  try {
    const rootFiles = readdirSync(cwd).filter(
      (f: string) => /\.(ts|js)$/.test(f) && !f.startsWith("."),
    );
    if (rootFiles.length > 0) {
      lines.push("Root files: " + rootFiles.join(", "));
    }
  } catch {
    /* skip */
  }

  // package.json — зависимости и тип модулей
  try {
    const pkgPath = join(cwd, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const deps = Object.keys(pkg.dependencies || {});
      const devDeps = Object.keys(pkg.devDependencies || {});
      if (deps.length > 0) lines.push("Dependencies: " + deps.join(", "));
      if (devDeps.length > 0)
        lines.push("DevDependencies: " + devDeps.join(", "));
      lines.push("Module type: " + (pkg.type || "commonjs"));
    }
  } catch {
    /* no package.json */
  }

  // Наличие tsconfig.json
  try {
    if (existsSync(join(cwd, "tsconfig.json"))) {
      lines.push("Has tsconfig.json");
    }
  } catch {
    /* no tsconfig */
  }

  return lines.join("\n");
}
