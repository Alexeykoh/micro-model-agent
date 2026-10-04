# npm Build Optimization (B) — Implementation Plan

> **For agentic workers:** execute task-by-task. Steps use checkbox (`- [ ]`) syntax. Spec: [docs/specs/2026-10-04-npm-build-optimization-design.md](../specs/2026-10-04-npm-build-optimization-design.md).

**Goal:** Сжать npm-пакет (`main.js` + ассеты/CSS/JSON), вынести зависимости, ускорить старт (лёгкий tiktoken), навести порядок в пайплайне — без runtime-сетевых докачек и без смены контрактов.

**Architecture:** `bun build --packages external` → минификация всего `dist` через esbuild (`scripts/optimize-dist.ts`) → портативный `clean` и упорядоченный `build:prod`. `token-counter` переходит на `js-tiktoken/lite` + `cl100k_base`.

**Tech Stack:** Bun, esbuild (devDep), TypeScript.

---

## Task 1: Lightweight token counter

**Files:** Modify `src/llm/token-counter.ts`; Test `tests/token-counter.test.ts`.

- [ ] **Step 1: Switch imports and encoder**

Replace the `js-tiktoken` import and `TokenCounter` construction:

```ts
/** Подсчёт токенов: точный (cl100k_base) и дешёвая эвристика для блоков. */
import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";
import { getMessageText } from "./provider";
import type { ContentPart } from "./provider";
```

```ts
/** Точный счётчик токенов поверх cl100k_base (единая таблица, ~1.1 MB). */
export class TokenCounter {
  private encoder: Tiktoken;

  constructor(_model: string = "gpt-4o") {
    // Один enñанкодинг для всех моделей: cl100k_base — уже документированный
    // фолбэк, а полный js-tiktoken тянул все rank-таблицы (~5.6 MB) на старте.
    this.encoder = new Tiktoken(cl100k);
  }
  // count/countMessages/encode/decode — без изменений
}
```

Keep `estimateTokens` and the rest of the class body unchanged.

- [ ] **Step 2: Typecheck + tests**

Run: `bunx tsc --noEmit`
Run: `bun test tests/token-counter.test.ts` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/llm/token-counter.ts
git commit -m "perf(llm): use js-tiktoken lite + cl100k_base (1.1MB vs 5.6MB)"
```

---

## Task 2: Portable clean script

**Files:** Create `scripts/clean.ts`; Modify `package.json`.

- [ ] **Step 1: Write `scripts/clean.ts`**

```ts
import { rm } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await rm(join(root, "dist"), { recursive: true, force: true });
```

- [ ] **Step 2: Point `build:clean` at it**

`package.json`:

```json
    "build:clean": "bun run scripts/clean.ts",
```

- [ ] **Step 3: Verify**

Run: `bun run build:clean` — Expected: `dist` removed (idempotent).

- [ ] **Step 4: Commit**

```bash
git add scripts/clean.ts package.json
git commit -m "build: portable dist clean (drop Windows-only cmd)"
```

---

## Task 3: Externalize packages in the bundle

**Files:** Modify `package.json`.

- [ ] **Step 1: Update `build:bundle`**

```json
    "build:bundle": "bun build ./src/cli/main.ts --outfile ./dist/main.js --target node --format esm --packages external",
```

- [ ] **Step 2: Verify size**

Run: `bun run build:clean && bun run build:bundle`
Expected: `dist/main.js` ≈ 1.7 MB (was 7.68 MB). `bin/mma.mjs` still runs:
`bun run mma -- --version` from repo root prints the version.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "build: externalize deps in the CLI bundle (7.7MB -> 1.7MB)"
```

---

## Task 4: Skip empty frontend transpiles

**Files:** Modify `scripts/build-frontend.ts`.

- [ ] **Step 1: Drop empty `.ts` outputs**

In the `.ts` branch of `walk`, skip writing when the transpiled JS is empty
(type-only modules such as `core/store/types.ts`):

```ts
    if (entry.name.endsWith(".ts")) {
      const js = transpiler.transformSync(await readFile(full, "utf8"));
      if (js.trim()) await writeFile(dest.replace(/\.ts$/, ".js"), js);
    } else {
      await cp(full, dest);
    }
```

- [ ] **Step 2: Verify**

Run: `bun run build:frontend`
Expected: no `dist/assets/js/core/store/types.js` (0-byte file gone).

- [ ] **Step 3: Commit**

```bash
git add scripts/build-frontend.ts
git commit -m "build(webui): skip empty type-only transpile output"
```

---

## Task 5: Minify the whole dist

**Files:** Create `scripts/optimize-dist.ts`; Modify `package.json` (add devDep esbuild, script, wire `build:prod`).

- [ ] **Step 1: Write `scripts/optimize-dist.ts`**

```ts
// Minify every JS/CSS/JSON artifact in `dist` in place (esbuild). This also
// mangling-obfuscates identifiers. No source maps — nothing to reverse with.
import { readdir, readFile, writeFile } from "fs/promises";
import { dirname, extname, join } from "path";
import { fileURLToPath } from "url";
import { transform } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const LOADERS: Record<string, "js" | "css" | "json"> = {
  ".js": "js",
  ".mjs": "js",
  ".css": "css",
  ".json": "json",
};

async function walk(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    const loader = LOADERS[extname(entry.name)];
    if (!loader) continue;
    const source = await readFile(full, "utf8");
    const result = await transform(source, {
      loader,
      minify: true,
      legalComments: "none",
    });
    await writeFile(full, result.code);
  }
}

await walk(dist);
```

- [ ] **Step 2: Add `esbuild` devDependency + `build:optimize` + reorder `build:prod`**

`package.json`:

```json
  "devDependencies": {
    ...
    "esbuild": "^0.28.1",
    ...
  },
  "scripts": {
    ...
    "build:optimize": "bun run scripts/optimize-dist.ts",
    "build:prod": "bun run 'build:clean' && bun run 'build:bundle' && bun run 'build:frontend' && bun run 'build:copy-assets' && bun run 'build:optimize'",
    ...
  }
```

- [ ] **Step 3: Verify end-to-end**

Run: `bun run build:prod`
Expected: `dist/main.js` ≈ 1.3 MB; total `dist` size ≈ 2.0–2.2 MB; browser assets
minified; `bun run mma -- --version` works; `bun run mma web --no-open --help` prints help.

- [ ] **Step 4: Commit**

```bash
git add scripts/optimize-dist.ts package.json
git commit -m "build: minify dist (js/css/json) via esbuild; add optimize step"
```

---

## Task 6: Docs + final gates

**Files:** Modify `AGENTS.md`, `CHANGELOG.md`.

- [ ] **Step 1: AGENTS.md** — add a short «npm Build Optimization» subsection under
  the WebUI/build notes: external deps, esbuild minify of `dist`, portable clean,
  lite tiktoken, expected sizes.

- [ ] **Step 2: CHANGELOG.md** — `[Unreleased]` → `### Changed`: build optimization entry.

- [ ] **Step 3: Gates**

Run: `bun run quality` (typecheck + frontend typecheck + lint + fallow) — Expected: exit 0.
Run: `bun test` — Expected: all green (3035+).
Run: `bun run build:prod` — Expected: sizes above; smoke `bun run mma -- --version`.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md CHANGELOG.md
git commit -m "docs: npm build optimization notes"
```
