// Загрузка веб-ассетов (html/css/js) из исходников или из бандла dist.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WebUiAssets } from "./state";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Кандидаты каталогов, проверяются по порядку. В исходниках `here` —
 * `src/modules/webui`, и первая запись — настоящий каталог ассетов. В бандле
 * (`dist/main.js`) `here` — `<dist>`, куда `build:prod` копирует ассеты в
 * `assets/` (см. `scripts/copy-assets.ts`); остальные покрывают раскладки,
 * где бандл лежит в другом месте, а дерево исходников рядом.
 */
const ASSET_DIR_CANDIDATES = [
  join(here, "assets"),
  join(here, "modules", "webui", "assets"),
  join(here, "..", "src", "modules", "webui", "assets"),
  join(here, "..", "..", "src", "modules", "webui", "assets"),
];

const ASSET_DIR = ASSET_DIR_CANDIDATES.find((d) => existsSync(join(d, "index.html")));

/** Грузит все ассеты в память (с заглушками, если каталог не найден). */
export function loadAssets(): WebUiAssets {
  // Исходники фронта — TypeScript; в dev/тестах транспилируются на лету
  // (`web:dev` без шага сборки). В prod `build:frontend` кладёт готовые `.js`
  // в `dist/assets`, и та же функция просто читает их.
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const read = (name: string, fallback: string) => {
    if (!ASSET_DIR) return fallback;
    if (name.endsWith(".js")) {
      const tsPath = join(ASSET_DIR, name.replace(/\.js$/, ".ts"));
      if (existsSync(tsPath)) return transpiler.transformSync(readFileSync(tsPath, "utf8"));
    }
    const jsPath = join(ASSET_DIR, name);
    return existsSync(jsPath) ? readFileSync(jsPath, "utf8") : fallback;
  };
  // Разделённые фронтенд-модули (`assets/js/**`, импортируются относительно
  // из `/app.js`). Рекурсивно: модули сгруппированы по фичам (`js/settings/*`
  // и т.п.), ключ — путь без ведущего слеша (`js/settings/controls.js`).
  // `.ts` транспилируется в `.js` под тем же ключом. Копируются в dist скриптом
  // `scripts/build-frontend.ts` вместе с остальным `assets/`.
  const jsModules: Record<string, string> = {};
  if (ASSET_DIR) {
    const walkJs = (dir: string, prefix: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const key = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walkJs(full, key);
        else if (entry.isFile() && entry.name.endsWith(".ts")) {
          jsModules[key.replace(/\.ts$/, ".js")] = transpiler.transformSync(
            readFileSync(full, "utf8"),
          );
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
          jsModules[key] = readFileSync(full, "utf8");
        }
      }
    };
    walkJs(join(ASSET_DIR, "js"), "js");
    // Топ-левел `.ts`/`.js` рядом с `app.ts` (напр. split `md-copy.ts`): у них
    // нет выделенного route, а `md.ts` импортирует их как `./md-copy.js`. Без
    // этого импорт отдавал бы 404 и весь ESM-граф (а с ним boot чата) падал.
    // Явные ключи `STATIC_ASSETS` (app/setup/md/smd/hljs) сюда не дублируем.
    const explicit = new Set(["app.js", "setup.js", "md.js", "smd.js", "hljs.js"]);
    for (const entry of readdirSync(ASSET_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const key = entry.name.replace(/\.ts$/, ".js");
      if (!key.endsWith(".js") || explicit.has(key)) continue;
      jsModules[key] = entry.name.endsWith(".ts")
        ? transpiler.transformSync(readFileSync(join(ASSET_DIR, entry.name), "utf8"))
        : readFileSync(join(ASSET_DIR, entry.name), "utf8");
    }
  }
  return {
    html: read("index.html", "<!DOCTYPE html><h1>MMA web assets missing</h1>"),
    css: read("styles.css", "/* missing */"),
    cssConsole: read("console.css", ""),
    cssGroovebox: read("groovebox.css", ""),
    cssThemes: read("themes.css", ""),
    js: read("app.js", "// missing"),
    setupJs: read("setup.js", "// missing"),
    mdJs: read("md.js", "// missing"),
    smdJs: read("smd.js", "// missing"),
    hljsJs: read("hljs.js", "// missing"),
    jsModules,
  };
}
