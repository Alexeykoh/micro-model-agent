# Спека: MCP OAuth 2.1 per-user + spec-синк (P1 supply-chain 2/2)

Дата: 2026-11-09. Ветка внутри `dev_0_25_0`. Источник: `TODO.md §3 P1
MCP/plugin supply-chain`, доки `docs/plugins.md` и `docs/agents/modules.md`.

## Есть

- allowlist (`mcp.allowedServers`), DLP-egress на MCP, rate-limit на сервер;
- HTTP-транспорт получает заголовки из конфига (`headers: {Authorization}`) — токен
  юзера кладётся вручную.

## Контракт

1. **OAuth-конфиг записи MCP-сервера:** `oauth: { authorizationUrl, tokenUrl,
   clientId?, scope?, tokenFile? }` в `MCPServerConfigEntry`.
   Токен хранится в `tokenFile` (plain JSON `{access?, expiresAt?, refreshToken?}`),
   при истечении — refresh на `tokenUrl` (client-credentials/refresh-token grant,
   Bun.fetch с timeout 15с), новый токен пишется атомарно.
2. **Аутентификация:** при `oauth` задан и красный заголовок `Authorization`
   не прописан — транспорт подставляет `Bearer <accessToken>`;
   при 401 один refresh + повтор.
3. **Per-user границы:** токен файла — процессно локальный (silo-модель:
   1 процесс = 1 пользователь), глобальная описанность в доки —
   per-user OAuth оформлен через файл токена, предоставленный внешним
   IdP (auth code flow вне процессов MMA — вне скоупа).
4. **Spec-синк MCP (доки):** `docs/agents/tools.md` + `docs/plugins.md`
   и сайт `gh-pages/docs.html` (#mcp): oauth-конфиг, rate-limit, integrity-манифест.

## Приёмка

- Тесты: refresh и подпись headers, горячий 401-повтор, отсутствие конфига не ломается;
  `<project>`/`~/.mma` пути токен-файла резолвятся сквозь jail;
  `bun test tests/mcp*` зелёный.
