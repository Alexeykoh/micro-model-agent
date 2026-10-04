# WebUI Frontend TypeScript Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `subagent-driven-development` (recommended) or `executing-plans` to implement task-by-task. Steps use checkbox (`- [ ]`) syntax. Spec: [docs/specs/2026-10-04-webui-frontend-ts-design.md](../specs/2026-10-04-webui-frontend-ts-design.md).

**Goal:** Перевести браузерный фронтенд `mma web` на TypeScript (`strict: true`) без изменения рантайм-контракта, с живым `web:dev` и без изменения URL/имён файлов.

**Architecture:** Инфраструктура даёт смешанный режим (`.ts` + `.js`): `tsconfig.frontend.json` с `allowJs` проверяет только переведённые файлы; `loadAssets()` транспилит `.ts` на лету через `Bun.Transpiler` (dev/тесты), prod читает готовые `.js` из `dist` (собирает `scripts/build-frontend.ts`). Миграция — снизу вверх (листья → `app.ts`), чтобы каждый переведённый файл импортил только уже переведённые или типизированные `.js`.

**Tech Stack:** Bun, TypeScript (`tsc`), vitest (`bun test`), Biome. Типы — DOM lib + `import type` контрактов из бэкенда.

---

## Порядок волн (зависимости)

```
leaf:     dom, api, i18n, format, core/menus
store:    core/store/{feed,tabs,settings,session,index}, store
mid:      dialog, subdialog, rail
feed:     feed/{core,stream,turn,history,plan,question,sidebar}, feed
sidebar:  sidebar/{state,map,lsp,trace,core}, sidebar
session:  session/{composer,sessions-menu,cmdk,tabs}
settings: settings/{write,form,providers,controls,editors,modal,search,subdialog,panels}, settings
entry:    app, md, setup
```

Каждый шаг миграции файла — один цикл: `git mv` → аннотации до зелёного `tsc` → тесты → commit.

---

## Phase 0: Infrastructure

### Task 0.1: Frontend tsconfig

**Files:**
- Create: `tsconfig.frontend.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Exclude assets from the backend project**

`tsconfig.json` — добавить `exclude` (сейчас его нет):

```json
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/modules/webui/assets/**"]
```

- [ ] **Step 2: Create `tsconfig.frontend.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "strict": true,
    "allowJs": true,
    "checkJs": false,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "forceConsistentCasingInFileNames": true,
    "types": []
  },
  "include": ["src/modules/webui/assets/**/*.ts", "src/modules/webui/assets/**/*.js"],
  "exclude": [
    "node_modules",
    "src/modules/webui/assets/smd.js",
    "src/modules/webui/assets/hljs.js"
  ]
}
```

- [ ] **Step 3: Verify both projects are green on the untouched tree**

Run: `tsc --noEmit` — Expected: PASS (assets excluded).
Run: `bunx tsc -p tsconfig.frontend.json` — Expected: PASS (only vendored/JS, not checked).

- [ ] **Step 4: Commit**

```bash
git add tsconfig.json tsconfig.frontend.json
git commit -m "build(webui): add frontend tsconfig, exclude assets from backend project"
```

### Task 0.2: `loadAssets` transpiles `.ts` on the fly

**Files:**
- Modify: `src/modules/webui/assets.ts:36-50`
- Test: `tests/webui-assets.test.ts`

- [ ] **Step 1: Add a source-walker that resolves `.ts` → `.js`**

Replace the `walkJs` block (lines 36-50) so it accepts both extensions and transpiles `.ts`:

```ts
  const jsModules: Record<string, string> = {};
  if (ASSET_DIR) {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
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
  }
```

Also update the top-level `read()` calls for `app.js`/`md.js`/`setup.js` so that when the
source is `.ts`, they read `.ts` and transpile. Add a helper:

```ts
  const transpilerTop = new Bun.Transpiler({ loader: "ts" });
  const read = (name: string, fallback: string) => {
    if (!ASSET_DIR) return fallback;
    const tsPath = join(ASSET_DIR, name.replace(/\.js$/, ".ts"));
    const jsPath = join(ASSET_DIR, name);
    if (existsSync(tsPath)) return transpilerTop.transformSync(readFileSync(tsPath, "utf8"));
    return existsSync(jsPath) ? readFileSync(jsPath, "utf8") : fallback;
  };
```

(Use one shared `transpiler` instance for both walker and `read`.)

- [ ] **Step 2: Run the asset tests**

Run: `bun test tests/webui-assets.test.ts` — Expected: PASS (still `.js` source, unchanged behavior).

- [ ] **Step 3: Commit**

```bash
git add src/modules/webui/assets.ts
git commit -m "build(webui): loadAssets transpiles TS source on the fly"
```

### Task 0.3: Prod frontend build script

**Files:**
- Create: `scripts/build-frontend.ts`
- Modify: `scripts/copy-assets.ts` (drop the verbatim webui copy), `package.json`

- [ ] **Step 1: Write `scripts/build-frontend.ts`**

```ts
import { cp, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src", "modules", "webui", "assets");
const outDir = join(root, "dist", "assets");
const VENDOR = new Set(["smd.js", "hljs.js"]);
const transpiler = new Bun.Transpiler({ loader: "ts" });

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

async function walk(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(srcDir, full);
    const dest = join(outDir, rel);
    if (entry.isDirectory()) {
      await mkdir(dest, { recursive: true });
      await walk(full);
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      const js = transpiler.transformSync(await readFile(full, "utf8"));
      await writeFile(dest.replace(/\.ts$/, ".js"), js);
    } else if (entry.name.endsWith(".js")) {
      await cp(full, dest);
    } else {
      await cp(full, dest);
    }
  }
}

await walk(srcDir);
```

- [ ] **Step 2: Remove the verbatim webui copy from `copy-assets.ts`**

Delete lines 20-27 (the `webuiSrc`/`webuiDest` block); `build-frontend.ts` owns it now.

- [ ] **Step 3: Wire into `build:prod`**

`package.json`:

```json
    "build:frontend": "bun run scripts/build-frontend.ts",
    "build:prod": "bun run 'build:bundle' && bun run 'build:frontend' && bun run 'build:copy-assets'",
```

- [ ] **Step 4: Verify the build output**

Run: `bun run build:prod`
Expected: `dist/assets/app.js`, `dist/assets/js/**/*.js`, `dist/assets/index.html`, `dist/assets/smd.js`, `dist/assets/hljs.js` exist. `bun test tests/webui-assets.test.ts` still PASS (reads sources).

- [ ] **Step 5: Commit**

```bash
git add scripts/build-frontend.ts scripts/copy-assets.ts package.json
git commit -m "build(webui): transpile frontend TS into dist/assets"
```

### Task 0.4: Gates and graph guard

**Files:**
- Modify: `package.json` (`quality`), `tests/webui-frontend-graph.test.ts`

- [ ] **Step 1: Add frontend typecheck to `quality`**

```json
    "typecheck:frontend": "tsc -p tsconfig.frontend.json",
    "quality": "bun run typecheck && bun run typecheck:frontend && bun run lint && bun run fallow",
```

- [ ] **Step 2: Teach the graph guard to read `.ts`**

In `tests/webui-frontend-graph.test.ts`, wherever it enumerates `assets/**` files and parses
imports, include `.ts` files and resolve a specifier ending in `.js` to the sibling `.ts` if
one exists. Concretely: collect `**/*.{js,ts}` (excluding vendored), and when building the
resolved-edge map, `target.replace(/\.js$/, ".ts")` fallback.

- [ ] **Step 3: Run**

Run: `bun run typecheck:frontend && bun test tests/webui-frontend-graph.test.ts tests/webui-assets.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add package.json tests/webui-frontend-graph.test.ts
git commit -m "test(webui): frontend typecheck gate + graph guard reads TS"
```

---

## Phase 1: Leaf/shared modules

Per-file recipe (repeated for every file below):

1. `git mv <file>.js <file>.ts`
2. Add types until `bunx tsc -p tsconfig.frontend.json` is clean for that file.
3. `bun test tests/webui-assets.test.ts tests/webui-frontend-graph.test.ts`
4. Commit `refactor(webui): migrate <file> to TS`.

Typing guidance per leaf:

- `js/dom.js` — element getters are `HTMLElement | null`; `el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K]`; `icon(name: string, cls?: string): SVGElement`; `ICONS: Record<string, Array<[string, Record<string, string|number>]>>`.
- `js/api.js` — `export interface ApiResponse<T = unknown> { ok: boolean; status: number; data: T | null }`; `api<T = unknown>(path: string, opts?: { method?: string; headers?: Record<string,string>; body?: unknown }): Promise<ApiResponse<T>>`.
- `js/i18n.js` — `I18N: Record<string,string>`; `t(key: string, params?: Record<string, string|number>): string`.
- `js/format.js` — annotate params/returns; `labelOf(name: string): string`.
- `js/core/menus.js` — as needed.

### Tasks
- [ ] **Task 1.1:** migrate `js/dom.js`
- [ ] **Task 1.2:** migrate `js/api.js`
- [ ] **Task 1.3:** migrate `js/i18n.js`
- [ ] **Task 1.4:** migrate `js/format.js`
- [ ] **Task 1.5:** migrate `js/core/menus.js`
- [ ] **Task 1.6:** migrate `js/core/store/{feed,tabs,settings,session,index}.js` + `js/store.js` (one commit; they form a cycle-free cluster)

---

## Phase 2: feed + sidebar + rail

Same recipe. Typing guidance:

- `js/feed/*` — DOM-heavy; use `as HTMLElement` at the boundary; define small local types
  for stream/turn state. `js/feed/core.js` owns shared render helpers.
- `js/sidebar/{state,map,lsp,trace,core}.js` — `sb` slice gets an interface in `sidebar/state.ts`.
- `js/rail.js` — event payload types.

### Tasks
- [ ] **Task 2.1:** `js/dialog.js`, `js/subdialog.js`
- [ ] **Task 2.2:** `js/feed/{core,stream,turn,history,plan,question,sidebar}.js`, `js/feed.js`
- [ ] **Task 2.3:** `js/sidebar/{state,map,lsp,trace,core}.js`, `js/sidebar.js`
- [ ] **Task 2.4:** `js/rail.js`

---

## Phase 3: session + settings

Same recipe.

- [ ] **Task 3.1:** `js/session/{composer,sessions-menu,cmdk,tabs}.js`
- [ ] **Task 3.2:** `js/settings/{write,form,providers,controls,editors,subdialog,search,modal,panels}.js`, `js/settings.js`

---

## Phase 4: entry points

- [ ] **Task 4.1:** `app.js` → `app.ts`
- [ ] **Task 4.2:** `md.js` → `md.ts`
- [ ] **Task 4.3:** `setup.js` → `setup.ts`

After Phase 4 every asset is `.ts` except vendored `smd.js`/`hljs.js`.

---

## Phase 5: Close-out

### Task 5.1: `allowJs` stays (vendored only)
- [x] Keep `allowJs: true` in `tsconfig.frontend.json` — it is now needed only to
  import the vendored `smd.js` from `md.ts`; all first-party code is `.ts`.
- [x] `tsc -p tsconfig.frontend.json` green.

### Task 5.2: Docs
- [ ] Update AGENTS.md «WebUI Modularization» section: frontend is now TS; note the
  `loadAssets` transpile path and `build:frontend`.
- [ ] CHANGELOG `[Unreleased]` → Changed: internal TS migration, contracts unchanged.
- [ ] Commit.

### Task 5.3: Final gates
- [ ] `bun run quality` (typecheck + frontend typecheck + lint + fallow)
- [ ] `bun test` (full)
- [ ] `bun run build:prod` — verify `dist/assets` output
- [ ] `bun build src/modules/webui/assets/app.js --target=browser` — graph resolves
- [ ] Commit if anything changed.
