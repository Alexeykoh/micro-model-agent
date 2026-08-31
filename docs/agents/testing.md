# Testing & Certification

## Тестирование агента из консоли (agent-driven)

Агент (opencode) может тестировать MMA напрямую через терминал, без интерактивного REPL:

```bash
# Одноразовый прогон: без AGENTS.md, выход сразу после ответа, песочница
bun run mma "<промпт>" --no-agents-md --exit-on-complete -d <путь-к-песочнице>
```

- **Песочница:** всегда тестируй внутри `_testing/` в корне проекта (например `_testing/<case-name>/`), никогда в корне или в `src/`. Папка `_testing/` добавлена в `.gitignore`.
- **`--no-agents-md`** — не грузить AGENTS.md в системный промпт (иначе агент получит инструкции проекта и поведёт себя иначе, чем в чистой среде).
- **`--exit-on-complete`** — завершиться сразу после первого финального ответа; интерактивные тулзы (`question`/`approve`) не блокируют stdin, а возвращают ошибку.
- **`-d <dir>`** — рабочая директория агента (туда он создаёт файлы).
- Каждый прогон создаёт сессию в `~/.mma/sessions/<id>/` (`meta.json` + `history.jsonl` + `session.jsonl`). После прогона можно смотреть:

  ```bash
  bun run mma session list
  bun run mma session show <id>
  ```

**Правила тестового прогона:**

1. Новый тест-кейс = новая подпапка `_testing/<case-name>/`.
2. Промпт формулируй конкретно: что создать, с каким содержимым, куда.
3. Оценивай результат по фактам (файлы на месте, содержимое корректно, exit code), а не по словам агента.
4. Если тестируешь фикс/фичу — сначала `bun test` + `tsc --noEmit`, потом прогон MMA.
5. **⚠️ Глобальный пакет перехватывает прогоны вне репо.** Если запускать `bun run mma` / `mma` из директории без `package.json` проекта (например, из песочницы в `%TEMP%`), bun резолвит **глобально установленный** `mma` (`%APPDATA%\npm\node_modules\micro-models-agent`, версия может быть старой — см. `mma --version` в выводе). Правки в `src/` при этом **не выполняются вообще** — фикс «не работает», хотя он корректен. Всегда запускай из корня репо и указывай песочницу через `-d <path>`; проверяй строку `Environment: ... mma <версия>` — она должна совпадать с `package.json` репо.

## Наблюдения за маленькими моделями

> **Журнал:** [docs/small-model-observations.md](./docs/small-model-observations.md)

При обнаружении систематической особенности поведения маленьких моделей (Qwen3.5-9B и подобных) —
например, «модель создаёт файлы через bash вместо `write_file`» — **обязательно** запиши наблюдение
в `docs/small-model-observations.md`: симптом, где проявилось (сессия/сценарий сертификации),
реакция harness (существующий механизм или новый фикс), статус. Не исправляй такое поведение
точечным костылём без фиксации в журнале: паттерны повторяются между сессиями и сценариями,
и знание о них должно пережить рефакторинги. Формат записи описан в самом файле.

## Model Certification

> **Spec:** `docs/specs/2026-08-05-model-certification-design.md` — offline harness that runs test scenarios through the real agent against a (model, provider) pair.

**Status:** Implemented.

Purpose: distinguish "this model works with MMA on this backend" from "untested". A certification is **not** a general endorsement — it states that on a specific provider URL the model ran the suite and passed N/M repetitions.

- **Commands:** `mma model certify <name> [--provider-url <url>] [--tags core,security,image,network,browser,moe] [--scenarios <ids>] [--reps N] [--force] [--clean]`, `mma model cert-status <name>`, `mma model cert-list`, `mma model uncertify <name>`.
- **Targeted re-run:** `--scenarios <ids>` (comma-separated, case-insensitive) runs only those scenarios and MERGES the fresh results into the existing certification entry — previous results for non-rerun scenarios are preserved verbatim (`mergePartialResults()` in `cli.ts`). A partial run does NOT require `--force` (it's an incremental update); a full-suite re-run still does. Unknown ids abort with the list of available scenarios.
- **Per-rep timeout:** default 300s; override via CLI `--timeout <ms>` (run-level) or per-scenario `timeoutMs` (YAML + `CertScenario`, validated >= 1000). Priority: `scenario.timeoutMs` → `opts.timeoutMs` → 300_000. Scenario 3.5 ships with `timeoutMs: 600_000` — slow local reasoning models (~30-45s per LLM call, ~12 iterations) complete the task correctly but miss the old default (see docs/small-model-observations.md).
- **Audit gate vs exit-on-complete:** the harness runs the agent with `--exit-on-complete`; its fast-exit on a hallucination-retry-flagged first response does NOT bypass the final audit gate when a plan is active (`agent.ts`) — otherwise a model that answers "done" without finishing the plan passes silently.
- **Tags:** `core` (default, no external deps), `security` (requires config, applied per-scenario), `image`, `network`, `browser`, `moe`.
- **Per-scenario config:** scenarios can declare `config:` overrides that are deep-merged into the base config and written to the sandbox as `<sandbox>/.mma/config.json`. The spawned process reads it via `MMA_CONFIG_DIR` env var. This enables security/MoE/LSP testing without requiring the user's global config to have those features enabled.
- **Manifest:** **global** `~/.mma/certifications.json` — entries keyed by `(model, providerUrl)`, recording `mmaVersion`, suite summary, and per-scenario results. Certifications are machine-scoped (model+provider), not project-scoped: marks are visible from any working directory. A bundled copy ships with the package (`certification/certifications.json` in the repo → copied to `dist/certification/` by `scripts/copy-assets.ts`) and is synced into the global manifest at every startup (`syncGlobalManifest()` in `manifest.ts`, called from `bootstrap.ts`): on a package update the bundled entries overwrite their keys; user-local certifications for other keys are preserved. A snapshot file (`~/.mma/certifications.synced.json`) prevents rewrites between updates. Legacy per-project manifests (`<project>/certification/certifications.json`, git-tracked) are still read and merged into every display lookup (`readMergedManifest`); `uncertify` cleans both stores.
- **Checkmarks:** `mma model list` and REPL `/model` show `✔` (certified on this provider, MMA version matches), `○` (certified on an older MMA version — re-run `--force`), `·` (not certified).
- **Harness mechanics:** spawns `bun src/cli/main.ts` per scenario rep with `--no-agents-md --exit-on-complete -d <sandbox>`, injecting `(model, provider)` via the existing env overrides (`MMA_MODEL`, `MMA_PROVIDER_BASEURL`, `MMA_PROVIDER_APIKEY`, `MMA_CONTEXT_WINDOW`). Fact-checks: files, exit code, output substring (`outputContains` for security scenarios). M/N tally per scenario (default 2/3).
- **Source:** `src/modules/certification/` (`types`, `scenarios`, `loader`, `fact-checker`, `runner`, `manifest`, `cli`). It is an offline tool independent of the agent loop — never part of the system prompt or context.
- **Scenarios:** builtin in `scenarios.ts` (ported from `docs/testing/scenarios.md`); user-defined YAML in `<project>/.mma/certification/scenarios/*.yaml`. Image fixtures in `docs/testing/fixtures/`.
