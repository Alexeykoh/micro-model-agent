# План выполнения оставшихся работ — 2026-08-31

> **Статус:** исполнено частично (сверка 2026-10-20) — волны 0–1 закрыты (baseline,
> DI-швы вместо `vi.mock`), волна 2 (аудит B–E) частично — открытые находки перечислены
> в [`TODO.md`](../../../TODO.md) §1.3, волна 3 закрыта, волна 4 — этапы 1, 3, 5 закрыты
> (раздутые файлы — долг `split-bloated-files`), волна 5 — контр-агент сделан,
> литература открыта. Чекбоксы проставлены по факту. **Не сделано:** pre-commit хука
> (в `.githooks/` только `pre-push`); часть хардкодов и строк мимо `t()` (этап 4).
> Пункт «git push master» неактуален — по правилам AGENTS.md в `master` не пушат.

> Составлен по результатам сверки TODO.md с кодом (HEAD `a82d115`, v0.57.2).
> Порядок волн — критический путь. Волны 2–4 можно перемешивать, но SPO и чистку
> файлов в одних областях (stuck-detector, repl) не делать одновременно.

## Волна 0 — Стабилизация базы (блокер для всего остального)

1. [x] **Baseline:** `bun test` + `tsc --noEmit` — **1782 pass / 0 fail / 1 skip**, tsc чисто
       (старые «53 fail» уже были закрыты предыдущими фиксами)
2. [x] **53 падения тестов:**
   - [x] Root cause: `vi.mock` в Bun глобален на процесс — мок модуля в одном тест-файле
         подменял импорты во всех остальных файлах воркера. Последние 8 падений
         (moe-replan/moe-abort) шли из `agent-moe-write.test.ts` (vi.mock agent-moe)
         и `subagent.test.ts` (vi.mock Agent). Фикс: DI-швы
         `AgentDeps.runWithMoEOverride` + `ToolContext.agentFactory`
   - [x] Bridge/read_file/plan-guard и прочие — уже закрыты предыдущими фиксами
3. [ ] **Git push** master на origin (HEAD `a82d115`)

## Волна 1 — MoE Completion (Wave 3–5) → релиз 0.58.0 (MINOR) ✅ ЗАКРЫТО

Релиз 0.58.0, коммит `f069fba` (2026-08-31).

1. [x] **Plan 3.2** — OrchestratorClient через ProviderManager (per-entry
       contextWindow/retry/rateLimits + failover; legacy {type,baseUrl,apiKey} работает;
       `orchestrator.contextWindow` — глобальный фолбэк)
2. [x] **Plan 3.1** — динамические эксперты из `config.experts` в PLAN_SYSTEM_PROMPT
       (`ExpertConfig.description`, фолбэк — tool_tags)
3. [x] **Plan 4.2** — observability: moe_plan/moe_subtask/moe_replan/moe_verify в session.jsonl
       (+ `session show`), usage breakdown по expert_tag, реальный sessionId
4. [x] **Plan 5.1 Task 1** — StepVerifier.verifySubtaskCriteria (file-exists,
       substring-in-file, command-exit-0); LLM-only критерии → warning
5. [x] **Plan 5.1 Task 2** — selective re-plan: `executePlan({skipIds, carriedResults})`
6. [x] **Plan 5.2** — cert suite tag=moe (5.1-moe-basic, 5.2-moe-parallel-waves,
       5.3-moe-read-after-write), спека Draft → Implemented, раздел MoE в AGENTS.md
7. [x] Релиз 0.58.0 + CHANGELOG

## Волна 2 — Аудит: Waves B–E (файловый обход)

1. [ ] **Wave B:** tools/ (write/edit/read-file, subagent, web-*, browser)
2. [ ] **Wave C:** execution module (module.ts, plan-tool, stuck-detector, auditor, verifier)
3. [ ] **Wave D:** session/logger/i18n/ui (repl.ts, repl-commands, renderer, line-editor)
4. [ ] **Wave E:** security + processes + providers + mcp/pipelines/indexer/skills/plugins
5. [ ] **Task 12** — FactualCheck rescan (низкий приоритет, параллельно)
6. [ ] Релиз PATCH по мере закрытия находок

## Волна 3 — System Prompt Optimization (план 2026-08-27)

1. [ ] Wave 1: реструктуризация ядра + дедуп
2. [ ] Wave 2: DONE CONDITIONS + STOP + session start protocol
3. [ ] Wave 3: failure classification в StuckDetector
4. [ ] Wave 4: FORBIDDEN patterns (решить autoPlan vs always)

## Волна 4 — Чистка кода (этапы 1–5)

1. [ ] **Этап 1:** удалить `verify-tools.ts`, убрать `tsconfig-paths` из devDeps,
       разорвать 2 цикла в browser/, suppress-конфиг examples в `.fallowrc.json`
2. [ ] **Этап 2 (остаток):** repl.ts, line-editor.ts, stuck-detector.ts, module.ts
3. [ ] **Этап 3:** test-harness из интеграционных тестов (~1000 строк), `bootstrap()` (438),
       `console.*` в repl-commands
4. [ ] **Этап 4:** хардкоды → конфиг (таймауты, пути, строки мимо `t()`, реестр `MMA_*`)
5. [ ] **Этап 5:** русские комменты ~110 файлов, послойно (core → llm → tools → modules → cli/ui)
6. [ ] **Перед релизом:** CI gate (fallow), Biome/ESLint, аудит `as any`, глухие `catch {}`,
       README/docs актуализация, pre-commit hook, `fallow security`

## Волна 5 — Бэклог

- [x] Контр-агент для проверки выполнения (переработать §RLM/verifier из docs/literature.md)
- [x] Мелочи бэклога по мере надобности

## Verification

После каждой волны: `bun test` зелёный относительно baseline, `tsc --noEmit` чисто.
Релизы — по правилам MINOR/PATCH из AGENTS.md + запись в CHANGELOG.md.
