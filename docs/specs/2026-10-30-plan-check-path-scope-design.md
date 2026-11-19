# Спека: резолв путей проверок плана (A9/A10)

Дата: 2026-10-30 · Ветка: `fix/plan-check-path-scope`

## Проблема

`StepVerifier.checkFileExists` резолвил путь сам (`findExistingFile`) мимо
`path-validator`, поэтому проверка плана не знала про `security.paths.enabled`.
Живой дефект: `file-exists:%USERPROFILE%/.mma/config.json` → «файл ещё не
существует» вместо проверки пути. `path-validator` дополнительно применял jail
`baseDir` до ветки `enabled:false`, из-за чего выключатель конфига не снимал
ограничение (описание ключа: «Ограничивать файловые операции рабочей папкой»).

## Контракт

### Резолв пути проверки

1. `expandPath` раскрывает `~`, `%VAR%` (Windows) и `$VAR`/`${VAR}` без запуска
   shell. Неизвестная переменная остаётся как есть.
2. `resolveCheckPath` передаёт раскрытый путь в `isPathInScope` — тот же
   валидатор и тот же вердикт, что у тулов (INV-9/10).
3. Scope субагента (`read_only_files`/`allowed_files`) применяется всегда,
   независимо от `enabled`.
4. `securityConfig === undefined` у `StepVerifier` — легаси-режим без jail
   (юнит-тесты создают верификатор без конфига); в рантайме конфиг приходит из
   `ExecutionModule` → `config.security.paths`.

### Поведение по `security.paths.enabled`

| Значение    | Jail baseDir / symlink              | denied/allowed | Scope     | Путь вне baseDir в `file-exists:`                     |
| ----------- | ----------------------------------- | -------------- | --------- | ----------------------------------------------------- |
| `true`      | действует                           | действуют      | действует | отказ: «путь вне рабочей папки, ограничение включено» |
| `false`     | снят                                | не действуют   | действует | проверяется обычно (файл найден/не найден)            |
| `undefined` | действует (fail-closed, как раньше) | — (нет секции) | действует | отказ (fail-closed)                                   |

Те же правила применяются к `isPathWritable`, `validateWorkdir` (cwd `bash`) и
`ToolExecutor` (`checkToolPath` → `ctx.config.security?.paths`). Защищённые пути
(`protected-paths.ts`) остаются always-on и от `enabled` не зависят.

### Причины отказа

При включённом ограничении причина явная: «Path/Workdir is outside the base
working directory (path restriction enabled)», а не «файл не существует».
Верификатор оборачивает её в i18n-ключи `verify.path_outside_base` /
`verify.path_blocked`; `plan_step` показывает причину рядом с `plan.check_failed`.

### `command:`-проверки

`command-exit-0:`/`command:` исполняют команду через shell в `baseDir` и сами
пути не резолвят и не валидируют — это self-certified проверка. Путь в команде
проверяет сама команда; `path-validator` к ней не применяется.

## Проверки

- `tests/modules/execution/plan-check-outside-base.test.ts` — раскрытие путей,
  вердикт верификатора, `plan_step` вне baseDir при `enabled` true/false.
- `tests/security/path-validator.test.ts` — jail под управлением `enabled`,
  scope при `enabled:false`.
- `tests/tools/enforcement-path.test.ts` — `ToolExecutor` при `enabled:false`.
- `tests/tools/bash-scope.test.ts` — workdir `bash` при `enabled:false`.
