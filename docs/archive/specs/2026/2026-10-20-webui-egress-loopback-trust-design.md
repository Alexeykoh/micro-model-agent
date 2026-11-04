# Webui E2: доверие loopback-клиенту

**Дата:** 2026-10-20 · **Ветка:** `fix/webui-egress-loopback-trust` · **Статус:** принято

## 1. Проблема

E2-фильтр (`src/modules/webui/egress.ts`) применяется к **всем** клиентам webui,
включая локальный браузер оператора. С `security.dataPolicy.enabled=true`
(дефолт) это даёт:

- в SSE `tool_start.args` путь `E:\projects\repo\src\a.ts` превращается в
  `<PATH:c7f6…>`; UI показывает токен вместо пути — выглядит как ошибка;
- файловая карточка строит ссылку `/api/file?path=<PATH:c7f6…>` → открытие
  файла из чата ломается (404), это уже функциональный дефект, а не косметика;
- `/api/state.workspace` в футере показывает псевдоним вместо каталога проекта.

При этом смысл E2 — не отдавать пути/PII **внешним API-клиентам** (§7.1 спеки
corporate-data-policy), а не скрывать данные от оператора, который и так имеет
доступ к файловой системе.

## 2. Решение

E2-фильтр различает **клиента** запроса:

| Клиент | Классы, которые редактируются |
|---|---|
| loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x`) | только `secret` (как всегда), `file-content` не тегируется |
| не-loopback | как сейчас: `path`/`machine`/`env`/`pii`/`file-content` + `secret` |

Провайдерный egress (E1) не меняется: внешний провайдер по-прежнему получает
псевдонимы, доверие к клиенту webui на него не влияет.

Дополнительно — ключ конфига `security.dataPolicy.trustLocalClients`
(`bool`, default `true`). `false` возвращает строгий режим для всех клиентов
(корпоративная политика, терминалы/проброс портов).

Дружелюбная подпись для удалённого клиента: вместо сырого `<PATH:…>` UI
показывает локализованный маркер «скрыто политикой» (i18n `web.egress.hidden`),
чтобы токен не читался как ошибка.

## 3. Инварианты

- **INV-L1.** Решение о доверии принимается по `req.socket.remoteAddress`
  (нормализация `::ffff:`), не по `Host`/`Origin`/заголовкам.
- **INV-L2.** `secret` маскируется всегда, независимо от доверия.
- **INV-L3.** Один и тот же предикат используется для REST и SSE; guard
  выбирается per-connection/per-request.
- **INV-L4.** При `trustLocalClients=false` поведение побайтно совпадает с
  текущим (все классы редактируются).
- **INV-L5.** Провайдерный guard (`E1`) не читает `trustLocalClients`.

## 4. Точки изменения

| Файл | Что |
|---|---|
| `src/modules/webui/egress.ts` | `apiGuardFor(state, remoteAddress)`; `apiGuard(state, trusted)`; кэш на два варианта; `target.trusted` |
| `src/modules/webui/util.ts` | `isLoopbackAddress(addr)` |
| `src/modules/webui/server.ts` | передать доверие в `apiGuard` для `/events` и `/api/*` |
| `src/modules/security/data-policy/types.ts` | поле `trustLocalClients` в `DataPolicyConfig` |
| `src/modules/security/data-policy/defaults.ts` | `trustLocalClients: true` |
| `src/config/registry-data-policy.ts` | ключ `security.dataPolicy.trustLocalClients` (`bool`) |
| `src/i18n/{en,ru}.json` | подписи клавиши и `web.egress.hidden` |
| `src/modules/webui/assets/js/**` | маркер скрытого пути вместо токена |

## 5. Тесты

- `tests/webui-egress-loopback-trust.test.ts` (новый): `isLoopbackAddress`
  (v4/v6/mapped), `apiGuard(trusted=true)` не трогает путь/PII, но маскирует
  secret; `apiGuard(trusted=false)` — трогает; `trustLocalClients=false`
  отключает доверие даже для loopback.
- `tests/webui-egress-filter.test.ts`: серверные кейсы переводятся на явный
  «удалённый» guard (поведение E2 не меняется); loopback-кейс проверяет
  реальный путь и рабочую ссылку `/api/file`.
- `tests/webui-files-link.test.ts` (или существующий аналог): путь из
  `tool_start` приходит без токена для локального клиента.

## 6. Риски и граница

- **SSH/порт-форвардинг** делает удалённого клиента loopback-ом. Это осознанный
  компромисс: для таких схем `trustLocalClients=false`.
- Доверие по адресу не спасает от вредоносного процесса на той же машине; он и
  так имеет доступ к ФС, поэтому модель угроз не расширяется.
- Долги не добавляются; поведение удалённого клиента остаётся прежним.
