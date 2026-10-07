# Plugin draft quality & styling — план

> Спека: [docs/specs/2026-10-07-plugin-draft-quality-design.md](../specs/2026-10-07-plugin-draft-quality-design.md).

**Goal:** малая модель не может записать синтаксически битый черновик, а вид
сгенерированного файла причёсан; провал загрузки возвращается модели с причиной
и откатывает битый файл.

## Task 1: синтаксис и нормализация в `drafts.ts`
- [x] `validateDraftCode(code)` — `Bun.Transpiler` поверх `async (ctx,args)=>{…}`
      (Bun-only, иначе `null`).
- [x] `normalizeDraftCode(code)` — CRLF→LF, dedent, ≤1 пустая строка, trim EOL,
      финальный `\n`.
- [x] `validateDraftSpec` вызывает `validateDraftCode`.
- [x] `renderDraft` вставляет нормализованное тело с индентом 2 пробела.
- [x] Тесты: `validateDraftCode` (валид/битый), `normalizeDraftCode`, вид шаблона.

## Task 2: обратная связь по загрузке
- [x] `DraftHost.lastError(name)` + реализация в `draft-host.ts`.
- [x] `define_capability`: `failed>0` → `success:false`, `draft.capability_load_failed`,
      `host.remove(name)`.
- [x] `mma plugins drafts approve`: печатает причины провала.
- [x] i18n `draft.capability_load_failed` (en+ru).

## Task 3: контракт в описании тула
- [x] `define_capability.description`: формат хендлера, доступные `ctx`/`args`,
      «без импортов/топ-левел», синтаксис-чек, откат при провале загрузки.

## Task 4: гейт
- [x] `bun test`, `typecheck`, `typecheck:frontend`, `lint`, `fallow audit`.
