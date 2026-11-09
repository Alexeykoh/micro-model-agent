# Спека: Evals MVP (P0, скоpковер + trajectory + CI-гейт)

Дата: 2026-11-09. Ветка: `feat/evals-scorecard` (ветка 1/2 evals:
скоркард + trajectory-чекер + eval-gate в CI; ensemble-судья + staged
rollout — 2/2).
Источник: `TODO.md §3 P0 Evals в контуре`,
[`2026-09-28-production-readiness`](../archive/specs/2026/2026-09-28-production-readiness-design.md) §6.

## Что неправильно

Cert-сценарии гоняются руками, артефактов нет: скоркарда
(success/cost/p95/safety) не считается, trajectory не оценивается,
гейта в CI нет. Статус моделей «последне запускал руками».

## Контракт

1. **Scorecard** (`src/modules/evals/scorecard.ts`, чистая функция):
   входы — bundled `certification/certifications.json` (агрегат всех
   моделей из манифеста), входы — плоские результаты. Вывод:
   `successRate`, `passed/failed/skipped/total`, `perModel` breakdown,
   `safetyFailures` (safety-сценарии со статусом fail/error).
2. **Trajectory-чекер** (`src/modules/evals/trajectory.ts`, чистая функция):
   вход — `session.jsonl` записи; ожидания (`requiredTools`,
   `forbiddenTools`, `requiredOrder`, `needlesInAnswer`),
   выход — `verdict { passed, reasons[] }` + `toolTrace` (порядок вызовов).
   LLM-судья не нужна: чеки детерминированы. Ensemble-судья и human-gold —
   сознательный non-goal волны 1/2 (деньги/считай на бутик).
3. **CI гейт** (`scripts/evals-check.ts`): читает bundled манифест,
   скейк-падает при `successRate < 0.80` или `safetyFailures > 0`.
   `quality.yml` — шаг `Evals gate` после Coverage gate.
   Полный прогнал сценариев с живым провайдером в CI НЕ гейтится
   (private Infra) — и соответствует cert-сертификации.
4. **Faithfulness-хук:** OTel-адаптер принимает `setFaithfulness(ok: boolean)` —
   метрика `gen_ai.faithfulness`. Заполняет волна evals- judges; контракт

## Приёмка

- Тесты оффлайн: scorecard на fixture-manifest (fail-safe), trajectory
  checker (pass/fail/порядок/needles), evals-check script exit codes.
- CI-файл ссылается на шаг; `package.json: evals:check`.
- `bun test tests/evals* tests/arch/` + typecheck зелёные.
