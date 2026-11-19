# `git push` под outbound-политикой (оплата долга `git-push-egress-ungated`)

## Проблема

`git push` (тул `git`, спека git-workflow §9.6) — исходящая сетевая операция,
но не проходит через `outbound-policy`/egress-гейт: адрес назначения не
проверяется, содержимое отправляемых объектов не сканируется на секреты.
Веб-контур (`git-api.ts`) — только GET, пишущих роутов нет, поэтому правится
только тул `git`.

## Решение

Перед `push` (и `push --force` после approve) в хендлере тула:

1. **Адресат.** Из argv извлекается remote (`git push [opts] [<remote> ...]`):
   имя или URL. Имя резолвится через `git remote get-url <name>`, URL
   проверяется как есть (поддерживаются `ssh://`, `git@host:` — как
   `https://host/`, `https://`). Проверка — `checkOutboundUrl(url, source,
   { networkConfig: ctx.config.security.network, operation: "git.push" })`:
   приватные/loopback-адреса и denied-домены блокируются, пока не поднят
   `allowPrivateOutbound`. Нет remote/не разрешается — отказ с причиной,
   не fail-open.
2. **Содержимое.** Дифф диапазона `merge-base...HEAD` против push-базы
   (`@{push}` или `origin/HEAD`, фолбэк — пустой диапазон) сканируется
   `detectSecrets()`. Находки блокируют push с указанием класса, не значения.
   Дифф читается через `git diff --no-color <base>...HEAD` в `git-core`.
3. Веб-роуты (`git-api.ts`) не меняются: push там нет. DEBT-маркер в `git.ts`
   снимается.

## Проверка

`tests/tools/git-push-egress.test.ts` (чистые хелперы + интеграция тула на
временном git-репо): push на приватный host блокируется, на публичный —
разрешён (fake remote URL), секрет в незапушенном коммите блокирует push,
чистый коммит проходит.
