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
  const read = (name: string, fallback: string) => {
    if (!ASSET_DIR) return fallback;
    const p = join(ASSET_DIR, name);
    return existsSync(p) ? readFileSync(p, "utf8") : fallback;
  };
  // Разделённые фронтенд-модули (`assets/js/*.js`, импортируются относительно из app.js).
  // Копируются в dist скриптом `scripts/copy-assets.ts` вместе с остальным `assets/`.
  const jsModules: Record<string, string> = {};
  if (ASSET_DIR) {
    const jsDir = join(ASSET_DIR, "js");
    if (existsSync(jsDir)) {
      for (const name of readdirSync(jsDir)) {
        if (name.endsWith(".js")) jsModules[`js/${name}`] = readFileSync(join(jsDir, name), "utf8");
      }
    }
  }
  return {
    html: read("index.html", "<!DOCTYPE html><h1>MMA web assets missing</h1>"),
    css: read("styles.css", "/* missing */"),
    js: read("app.js", "// missing"),
    setupJs: read("setup.js", "// missing"),
    mdJs: read("md.js", "// missing"),
    smdJs: read("smd.js", "// missing"),
    hljsJs: read("hljs.js", "// missing"),
    jsModules,
  };
}
