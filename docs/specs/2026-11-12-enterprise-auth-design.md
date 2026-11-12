# Enterprise Auth: домен → сервер — Design Spec

**Status:** Draft (2026-11-12)
**Ветка:** `docs/enterprise-auth-simple`
**Тип:** контракт auth/identity для enterprise-надстройки, additive к service API v1
**References:**
идеи [MMA Enterprise](../ideas/2026-11-05-mma-enterprise.md) §4/§10,
[Enterprise как отдельная версия](../ideas/2026-11-09-mma-enterprise-separate-version.md) §6–§7,
спека [agent service API](./2026-10-08-agent-service-api-design.md) §10–§11,
[W2 enforcement](./2026-10-13-w2-enforcement-design.md)

---

## 1. Цель

Дать ответ на один вопрос: пользователь вошёл в корпоративный ПК,
запустил агента — как агент и сервер понимают, кто он и что ему можно.

Простыми словами:

1. Вход в ПК — ещё не вход в MMA.
2. Клиент входит через компанию (`mma login` → браузер → IdP).
3. IdP выдаёт подписанную записку — короткоживущий токен.
4. Каждый запрос к серверу идёт с этой запиской (`Bearer`).
5. Сервер проверяет записку, превращает группы в права, пишет `actor` в аудит.

Спека фиксирует формат записки, точки проверки и разделение
identity (кто) / policy (что можно). Без этого — общий токен на всех,
роли «на словах», аудит без `actor` (см. «что нельзя назвать enterprise»).

## 2. Non-goals

- Не строим control plane целиком (пользователи, workspace, квоты, биллинг).
- Не вводим pooled-мультитенантность: изоляция = процесс (1 тенант = 1 процесс, silo).
- Не делаем OBO/Kerberos к шарам и credential broker — только граница и формат пропуска (§8).
- Не меняем петлю агента, тулы, enforcement, формат `session.jsonl` (только добавляем поля).
- Не храним пароли, не ходим в AD напрямую.

## 3. Контекст: что уже есть

| Что | Где | Роль в спеке |
| --- | --- | --- |
| `service.token` — общий `Bearer` | `src/modules/service/server.ts`, `service.*` | заменяется на identity-токен + внутренний токен (§5) |
| `X-Mma-Tenant/Principal/Run/Tier/Scopes` | service API §10.2 | остаются, но `Principal` резолвится из auth, не из тела |
| `service.tenant` + `403 tenant-mismatch` | `tests/service/tenant-authz.test.ts` | сохраняется, тенант — свойство процесса |
| `session.jsonl` + `service_task` | service runtime | добавляется `actor` (§6) |
| `ToolExecutor.execute()` | W2 | единственная точка применения policy, не меняется |

AD и IdP — разные вещи: AD хранит аккаунты, IdP переводит их в OIDC-токены.
MMA доверяет только IdP и в AD напрямую не ходит.

## 4. Поток (нормативный)

```text
ПК (доменный вход) → CLI `mma login --server https://mma.corp`
  → браузер → IdP (SSO, +MFA) → OIDC-токены → CLI (OS credential store)
  → каждый /v1-запрос: Authorization: Bearer <access> → ingress → control plane/runtime
  → проверка → роли → policy → исполнение → аудит с actor
```

1. `mma login` — device-flow: CLI показывает ссылку+код, пользователь подтверждает в браузере.
2. Токен хранится в системном хранилище (Credential Manager / Keychain / secret service), не в файле/ENV.
3. Политика приезжает отдельно подписанным пакетом (`GET /v1/me`, `GET /v1/policy`), см. §7.
4. Отзыв: короткий TTL access-токена + проверка `disabled` на каждый запрос + kill-switch версий policy.

## 5. Контракт identity

### 5.1 Токены

- Формат: стандартный OIDC `access_token` (JWT) + опц. `refresh_token` только в CLI.
- Обязательные claims: `iss`, `aud`, `exp`, `sub` (стабильный, immutable — `objectGUID`/IdP subject, не email), `groups` (малые целевые группы вида `MMA-Finance`).
- Валидация на сервере на каждый запрос: подпись (JWKS issuer), `iss/aud/exp`, `nbf` с допуском часов, отзыв/отключение пользователя.
- Часы: требуется NTP; рассинхрон → `401 invalid_token`, не fail-open.

### 5.2 Заголовки

```text
Authorization: Bearer <access_token>   // обязателен, если задан issuer; иначе legacy service.token
X-Mma-Tenant: <id>                     // сверяется с service.tenant процесса
X-Mma-Run / X-Mma-Tier / X-Mma-Scopes  // audit-метки / сужение, прав не повышают
```

Правила:

- `Principal` (user id) резолвится только из `sub` токена, никогда из тела/prompt.
- Чужой/неизвестный тенант → `403 tenant-mismatch` до маршрута (как сегодня).
- Нет/просрочен токен → `401`; есть токен, но нельзя → `403`; оба — `application/problem+json`.

### 5.3 Маппинг групп → роли

- Источник: группы IdP (OIDC-claim или SCIM-копия), не прямой LDAP-запрос.
- Таблица `группа → роль MMA → workspace`, одна группа = одна понятная роль; роли не складываются автоматически.
- Роли: `org_admin/security_admin/workspace_admin/builder/user/auditor/service/agent/guest` (смысл — в идее §6).
- RBAC задаёт базу, ABAC сужает (отдел, класс данных, устройство, время).

## 6. Аудит и сессии

- Каждая запись `service_task` в `session.jsonl` получает `actor: { sub, groups, role, workspace }`.
- Без валидного `actor` tenant-маршрут не исполняется (исключение — `GET /health|/ready|/openapi.json|/docs`).
- Fail-open запрещён: недоступен IdP/JWKS → `401/503` + запись с причиной, не «работа по старым правилам» сверх TTL.

## 7. Пакет политики (что можно)

Отделён от identity-токена: identity отвечает «кто», пакет — «что можно».

| Поле | Смысл |
| --- | --- |
| `version`, `workspace` | версия и область применения |
| `ttl` | срок доверия без обращения к серверу; истёк → только чтение |
| `tools.allow/deny`, `models.allow`, `dlp.mode`, `limits` | allowlist, DLP, квоты |
| `signature` (Ed25519) | подпись control plane; ключ и ротация — вне спеки, компрометация → kill-switch |

Клиент проверяет подпись+TTL до применения. Подмена/просрочка → read-only или отказ + событие в аудит. Флаги `--model/--allow-tool/--no-dlp/--policy/--quota` управляемую политику не переопределяют. Ключ подписи и его хранение — открытый вопрос §10.

## 8. Границы и thin/hybrid

- **Thin:** инструментов на клиенте нет; DLP и enforcement — на сервере. Для чувствительных данных.
- **Hybrid:** инструменты на клиенте, но policy подписана; критичные действия перепроверяются на сервере.
- Граница задаётся на workspace, не на усмотрение пользователя.
- Честная оговорка: root на своей машине может пропатчить клиент — абсолютной защиты нет; поэтому сервер никогда не доверяет клиенту, только токену и своей политике.
- OBO/Kerberos к шарам и broker пропусков — вне спеки; граница: файловый сервер даёт права по ACL, MMA — только короткий пропуск, склейка «человек ↔ учётка» — в аудите шары.

## 9. Тестирование и гейты

- `tests/service/tenant-authz.test.ts`: расширить — `401` без/с просроченным токеном, `403` на чужой тенант/роль, `sub` только из auth, `actor` в `session.jsonl`.
- `tests/arch/session-provenance.test.ts`: `actor` обязателен на tenant-маршрутах.
- `tests/docs-link-check.test.ts`: ссылки спеки резолвятся (docs-only критерий готовности).
- Живой прогон пилота: `mma login` → запрос → отзыв пользователя → `401/403`, запись в аудите.

## 10. Открытые вопросы

1. Где живёт ключ подписи policy, ротация и поведение при компрометации.
2. Точный набор ABAC-атрибутов v1 (минимум: отдел, класс данных, устройство?).
3. Thin по умолчанию или hybrid для пилота; grace period для офлайн-клиентов.
4. LiteLLM vs свой model gateway — кто владеет ключами (вне auth, влияет на учёт).

## 11. Волны

| Волна | Содержание | Готовность |
| --- | --- | --- |
| 0. Пилот | OIDC на reverse proxy, read-only, аудит в файл | вход и отзыв проверены на одном отделе |
| 1. Identity | SSO, маппинг групп → роли, `actor` | уволенный теряет доступ сразу |
| 2. Policy | подписанные пакеты с TTL, thin/hybrid | подмена отклоняется и пишется в аудит |

Дальше — лимиты/gateway (волна 3) и файлы/broker (волна 4) отдельными спеками.
