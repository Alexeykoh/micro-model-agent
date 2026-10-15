# Политика исходящих вызовов (outbound policy)

**Дата:** 2026-10-15 · **Волна:** W13 плана `docs/plans/2026-10-15-harness-bug-detection-plan.md`
· **Статус:** утверждена (решение D5)

## 1. Проблема

Два исходящих HTTP-вызова в каркасе идут мимо сетевой политики:

| Сайт | Что принимает | Статус |
|---|---|---|
| `src/modules/security/audit-notifier.ts:234` | `config.webhookUrl` | `fetch` без проверки |
| `src/modules/service/runtime/webhook.ts:63` | `callbackUrl` из тела `/v1/tasks` | `fetch` без проверки |

`isUrlAllowed` применяется только в `ToolExecutor.execute()` — то есть к вызовам,
инициированным **моделью**. Вызовы, инициированные **каркасом** (webhook нотификатора,
push-доставка Job-объекта), проходят мимо: значение приходит из конфига или тела HTTP-запроса,
то есть из недоверенного источника для `mma serve` без токена.

Следствие: `POST /v1/tasks {"input":"…","callbackUrl":"http://127.0.0.1:9200/…"}` заставляет
процесс выполнить произвольный POST на loopback/internal — blind SSRF с подписью тела.

## 2. Решение (D5)

Единая точка решения для исходящих вызовов каркаса: `checkOutboundUrl` /
`fetchOutbound` в новом модуле `src/modules/security/outbound-policy.ts`.

Политика **не зависит** от `security.network.enabled`: этот флаг описывает вызовы,
инициированные моделью, и его выключение не должно молча открывать внутреннюю сеть для
каркаса. Политика исходящих вызовов fail-closed:

1. схема — только `http:`/`https:`;
2. loopback и приватные диапазоны (`isIpPrivate`) — **deny по умолчанию**;
3. явный флаг конфига `security.network.allowPrivateOutbound` (default `false`) снимает
   пункт 2 **и** дефолтные deny-записи loopback-адресов (`127.0.0.1`, `::1`,
   `localhost` в `deniedDomains`) — иначе флаг был бы недостижим. Прочие доменные
   записи deny/allow пользователя флаг не трогает;
4. `deniedDomains`/`allowedDomains` из `security.network` применяются всегда, когда
   `security.network.enabled` (иначе флаг доменов не имеет смысла).

Токен на loopback для самого сервиса (`server.ts`) не меняется — он про серверный
интерфейс, а не про исходящие вызовы.

## 3. Контракт

```ts
/** Источник URL для исходящего вызова каркаса (INV-13). */
type OutboundOrigin = "module:audit" | "module:service" | Source;

interface OutboundPolicyOptions {
  /** Доменная политика и флаг allowPrivateOutbound. */
  networkConfig?: NetworkSecurityConfig;
  /** Операция для диагностики: "audit.webhook", "service.callback". */
  operation: string;
  /** Куда записать отказ (INV-14). */
  onDiagnostic?: (diag: Diagnostic) => void;
}

function checkOutboundUrl(url: string, opts: OutboundPolicyOptions): NetworkValidationResult;
function fetchOutbound(url: string, init: RequestInit, opts: OutboundPolicyOptions): Promise<Response>;
```

`fetchOutbound` бросает `OutboundPolicyError` (с `reason`) до сетевого вызова; отказ
**не ретраится** — повтор заведомо обречён и только множит попытки во внутреннюю сеть.

Отказ эмитится в `onDiagnostic` объектом `Diagnostic`
(`source`/`operation`/`kind: "blocked"`/`cause`) — без расширения союза
`DiagnosticEvent`: этот союз принадлежит W10.2, а не W13.

## 4. Точки подключения

| Файл | Что делаем |
|---|---|
| `src/modules/security/audit-notifier.ts` | `sendToWebhook` → `fetchOutbound`, `operation: "audit.webhook"`, sink в `defaultOutputBus` |
| `src/modules/service/runtime/webhook.ts` | `deliverWebhook` получает `networkConfig`/`onDiagnostic`; проверка до первой попытки, при отказе `{ok:false, attempts:0, blocked:true}` без ретраев |
| `src/modules/service/api/tasks-api.ts` | `parseSubmitBody` отклоняет `callbackUrl`, не прошедший политику → 422 (отказ виден синхронно, а не после ретраев) |
| `src/config/{types,security}.ts`, `registry-extra.ts`, `i18n/{en,ru}.json` | ключ `security.network.allowPrivateOutbound` |

## 5. Гейт

`tests/arch/outbound-policy.test.ts`:

- скан `src/**` на `fetch(`; каждый сайт либо проходит через `fetchOutbound`/
  `fetchValidated`, либо перечислен в allowlist **с причиной**;
- allowlist по файлам: провайдеры (`src/llm/*`), `models.dev`, `native-context`,
  `provider-context` (URL конструируются из конфига модели), `mcp/client`,
  `updater/*`, `setup/discovery.ts` — каждый с причиной; остальные причины
  недопустимы, запись без причины = падение гейта;
- поведенческая часть: `callbackUrl` вида `http://127.0.0.1:PORT/` отклоняется
  `/v1/tasks`; аудитотправитель не делает сетевого вызова на отказ.

## 6. Что не меняется

- `isUrlAllowed`/`fetchValidated` и их семантика (модельные вызовы, INV-10);
- `service.token` для loopback-интерфейса;
- ретраи webhook: политика не меняет их число, только отсекает заведомо обречённые попытки.