# Read-only стрик-гард: 16 чтений подряд без единой правки

Дата: 2026-11-08. Мотивация: сессия `ses_mw7z4mav` (правка UI-индикатора обновления,
64 вызова тулов, 0 правок) + ветка `feat/plan-file-modified-check` (первый слой).

## Проблема

`StuckTracker.recordToolSuccess()` затухает `iterationsOnCurrentStep` на **любом**
успехе, включая `read_file` (защита легитимной разведки, напр. чтение 12 файлов
в analytic-шаге). Итог: агент, успешно читающий одно за другим, никогда не
становится «застрявшим» — `isStuck()` не срабатывает, `diagnose` чист, а до
`edit_file` дело не доходит. Первый слой (`file-modified:`) ловит только шаги
с планом и этим check; без плана/без check петля открыта.

## Решение (мягкая директива, не блок)

- `StuckTracker` ведёт `readOnlyStreak`: `recordToolCall` инкрементит его на
  read-only тулах (`read_file`, `list_dir`, `glob`, `grep`, `file_info`,
  `project_map`, `chunk_query`, `web_search`, `web_browse`, `web_fetch`,
  `recall`, `process_list`, `process_log`), любой другой тул сбрасывает в 0.
  Сброс на смену шага (`resetStepState`); `resetStepProgress` стрик не трогает
  (история вызовов там тоже сохраняется).
- Порог `READ_ONLY_STREAK_THRESHOLD = 16` — выше документированной легитимной
  разведки в 12 файлов; ложное срабатывание стоит только мягкой подсказки.
- Новая причина `read-only-streak` в `primaryReason`/`warningKey`/`stuckReason`/
  `recoveryMessage` (приоритет ниже всех остальных) + `FailureType`
  `"read_only_streak"`. Директива `exec.read_only_streak_recovery`: «правь файл
  или задай уточняющий вопрос, дальнейшее чтение без прогресса запрещено».
- `plugin-think.ts`: условие инжекта recovery расширяется на
  `hasReadOnlyStreak()` (тот же кулдаун, что у остальных recovery).

## Что НЕ делаем

- Не блокируем вызовы тулов и не запрещаем чтение: это мягкий nudge через
  существующий recovery-механизм, а не enforcement.
- Не трогаем затухание `iterationsOnCurrentStep` на успехах (легитимная разведка
  по-прежнему прогресс) — стрик независимый счётчик.

## Гварды

- `tests/modules/execution/read-only-streak.test.ts`: стрик растёт на чтениях,
  сброс на `edit_file`/`bash`/`plan`, порог 16, recovery-сообщение после порога,
  смена шага сбрасывает.
- Паритет i18n (`en`/`ru`): `exec.read_only_streak`, `exec.read_only_streak_recovery`.
