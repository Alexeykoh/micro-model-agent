# LSP: проверка изменённых файлов из панели

_Дата: 2026-10-29. Ветка: `fix/stress-register`. Закрывает прежний долг
`lsp-project-diagnostics`: панель умела проверять только один файл._

**Статус:** реализовано (`1cf3a648`); гварды `tests/modules/lsp/changed*.test.ts`, `tests/webui-lsp-changed.test.ts` зелёные.

## Решение

Вкладка LSP получает секцию «изменённые»:

- источник списка — `git status --porcelain=v1 -z --untracked-files=all` в корне
  workspace; удалённые и `.mma/` отбрасываются, только файлы с настроенным
  LSP-сервером;
- **лимит 20 файлов** за запрос, проверка **последовательно** (очередь на одном
  тёплом соединении), пер-файловый бюджет 6 с, общий 20 с; при исчерпании —
  `truncated: true`, а не минутное ожидание;
- нет git/репозитория — `ok:false, error:"git-unavailable"`; нет изменений —
  `no-changes`; панель объясняет причину, а не молчит;
- результат — по файлам: диагностики с `строка:колонка`, клик открывает файл на
  строке (тот же `openFileAtLine`, что у одиночной проверки); «чисто: N» для
  файлов без ошибок.

## API

```
POST /api/lsp/check-changed
→ 200 {"ok":true,"files":[
    {"ok":true,"path":"src/a.ts","diagnostics":[…],"ms":640},
    {"ok":true,"path":"src/b.ts","diagnostics":[]}
  ],"truncated":false,"ms":812}
→ 200 {"ok":false,"error":"no-changes","files":[]}
→ 200 {"ok":false,"error":"git-unavailable","files":[]}
→ 503 {"ok":false,"error":"unavailable"}
```

## Инварианты

- **INV-C1.** Список файлов — git рабочего дерева, без обхода всего проекта.
- **INV-C2.** Работа ограничена: ≤20 файлов, общий бюджет; превышение — видимый
  `truncated`.
- **INV-C3.** Ошибка одного файла не отменяет остальные; причина видна в
  строке файла.
- **INV-C4.** Панель не строит пути сама: клик идёт через `openFileAtLine`.

## Тесты

| файл | что держит |
|---|---|
| `tests/modules/lsp/changed.test.ts` | разбор porcelain, фильтр deleted/.mma, лимит |
| `tests/modules/lsp/changed-check.test.ts` | очередь, no-changes, git-unavailable, truncated |
| `tests/webui-lsp-changed.test.ts` | группировка, клик к строке, причина отказа |

## План

1. `listChangedFiles` + `runChangedChecks` + API.
2. Секция «изменённые» в панели.
