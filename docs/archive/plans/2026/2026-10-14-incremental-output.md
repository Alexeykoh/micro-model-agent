# `append_file` — Wave W-e (incremental output, OO-5) Implementation Plan

> **Статус:** исполнено (2026-10-20) — тул `append_file` (`src/tools/append-file.ts`)
> с `security`-декларацией, регистрация в `src/tools/index.ts` и в FS-write гейтах,
> i18n `file.appended` (en/ru), тест `tests/tools/append-file.test.ts`.
> Чекбоксы проставлены по факту.

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** OO-5 — длинный вывод собирается **инкрементально** в артефакт, а не одним ответом. Добавить тул `append_file`, который дописывает контент в файл (создавая его), с теми же security-проверками, что у `write_file`, — чтобы модель наращивала вывод куском за куском без переполнения окна.

**Base:** ветка `feat/incremental-output` от `docs/architecture-v2`.

**Tech:** Bun + TS strict, vitest, Biome; i18n `t()`; security `writePathAllowlist` + content-scan + file-ops лимит (как в `src/tools/write-file.ts`).

---

## Task 1: `append_file` tool

**Files:** Create `src/tools/append-file.ts`, `tests/tools/append-file.test.ts`; Modify `src/tools/index.ts`, `src/i18n/en.json`, `src/i18n/ru.json`.

- [x] **Step 1: failing test** `tests/tools/append-file.test.ts` — modelled on an existing simple write-tool test; assert:
  - `appendFileTool.name === "append_file"`; `parameters.required` includes `path` and `content`.
  - append to an existing file grows it (previous content preserved + new appended).
  - creates the file (and parent dirs) when missing.
  - `ctx.writePathAllowlist` set to a different path → `success:false` (blocked).

- [x] **Step 2: implement `src/tools/append-file.ts`**
  - `name: "append_file"`, `security: { caps: [{ fs: "write" }], pathArgs: ["path"] }`, `icon: "➕"`, `tags: ["file", "code"]`, `boundedOutput: true`.
  - `description`: "Append content to a file (creating it and parent directories if needed). Use to build a long output incrementally instead of rewriting the whole file."
  - `parameters`: `path` (string), `content` (string), `required: ["path","content"]`.
  - handler (mirror `write-file.ts` policy, minus syntax pre-validation which is meaningless for a partial append):
    - `safeResolvePath(ctx.baseDir, path)`.
    - `writePathAllowlist` check → `t("file.path_not_allowed", {path, reason: t("onboarding.write_restricted")})`.
    - session securityConfig; file-ops limit (`maxFileOperations`); content-scan when `securityConfig.enabled && contentScan.enabled` → `[SECURITY BLOCKED] …`.
    - `mkdirSync(dirname, {recursive:true})` if missing.
    - `appendFileSync(resolved, content, "utf-8")` inside try/catch → `t("file.write_failed", {path, error})`.
    - increment `ctx.fileOperationsCount`; `logFileWrite`.
    - output `t("file.appended", { path, chars: String(content.length) })`.
  - no `as any`.

- [x] **Step 3: i18n** — add `file.appended` to BOTH en and ru (symmetric: `{path}`, `{chars}`); reuse existing `file.write_failed` / `file.path_not_allowed`.

- [x] **Step 4: register** in `src/tools/index.ts` (import + both arrays, next to `writeFileTool`).

- [x] **Step 5: verify** `bun test tests/tools/append-file.test.ts tests/tools/security-decl.test.ts tests/i18n.test.ts`; then `bun test` + `bun run quality` exit 0. No `as any` in `src/`.

- [x] **Step 6: commit** `feat(tools): append_file — incremental artifact output (OO-5)`

---

## Self-Review
- OO-5 (вывод > окна собирается в артефакт) → `append_file` даёт инкрементальную запись; `write_file` остаётся для перезаписи.
- Security parity with `write_file` (scope via `pathArgs`, allowlist, content-scan, ops limit).
- No placeholders; test names/keys consistent.
