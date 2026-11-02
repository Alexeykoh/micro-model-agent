# DLP: прозрачность редакции и покрытие egress

**Дата:** 2026-11-02 · **Ветка:** `feat/dlp-transparency-and-coverage` · **Статус:** реализовано
(U20/U21/U22 — код, тесты, живой прогон; волна 2 «покрытие egress» — §6, отдельные задачи)

**Связанные документы:**
[corporate-data-policy](./2026-10-19-corporate-data-policy-design.md) ·
[architecture v2](./2026-10-12-architecture-v2-design.md) ·
[STYLE](../design/ui/STYLE.md) ·
TODO §1.2 (остаточные векторы), §1.11 (U20–U22)

---

## 1. Проблема

DLP-движок (`modules/security/data-policy`) уже редактирует egress к провайдеру (E1)
и к API-клиенту (E2), но пользователь видит только **агрегат**: «сколько значений и
каких классов». Из этого нельзя ответить ни на один практический вопрос:

1. **Что именно ушло провайдеру?** Состав промпта (`system → messages → tools`) и
   параметры вызова нигде не зафиксированы; `context_log` — opt-in и не про запрос.
2. **Где именно вычищено значение?** Ни сообщения, ни поля, ни диапазона: при
   разборе инцидента непонятно, из какого тула/сообщения ушёл путь.
3. **Что поймала защита прямо сейчас?** `audit.jsonl` пишется, но нотификатор
   по умолчанию выключен и не отдаёт событие в UI; исторические записи не поднимаются.

Отдельно: пять известных путей обхода (payload `web_search`, MCP-клиент, hidden-сегмент
в `tool_start.args`/`tool_end.output`, base64/split, DNS-подмена trust) описаны в TODO
§1.2 и `docs/agents/debt.md`, но не закрыты.

## 2. Цели

| ID | Цель | Проверка |
|---|---|---|
| **G1** | Trace показывает **снимок исходящего запроса** (после проекции, до сети) с кнопкой «копировать JSON» | `tests/llm/request-snapshot.test.ts`, `tests/webui/llm-request-snapshot.test.ts` |
| **G2** | Бейдж DLP разворачивает **позиции** редакции: сообщение/тул, поле, диапазон, чем заменено | `tests/security/dlp-hits.test.ts` |
| **G3** | Вкладка «Безопасность» — живой журнал отловов (block / DLP / approval / SSRF) с бэкфиллом | `tests/webui/security-log.test.ts` |
| **G4** | Ни в одном новом поле нет оригиналов и token id | тесты G1–G3 |

## 3. Инварианты (нормативно)

- **INV-DLP-T1** — снимок запроса снимается **после** `sanitizeChat` и **до** `fetch`;
  в нём не может быть того, чего нет в теле запроса.
- **INV-DLP-T2** — `EgressHit.replacement` — только метка (`[PII]`, `‹PATH›`), не
  псевдоним с id (`<PATH:abc>`); оригинал и token id не покидают процесс.
- **INV-DLP-T3** — позиции и события капнуты: `hits` ≤ 24 на ход (+`hitsTruncated`),
  security-буфер ≤ 200 на сессию, снимок ≤ 64 000 символов с честными маркерами.
- **INV-DLP-T4** — сбор снимков **ленивый**: подписчиков нет — снимок не строится
  (провайдер не платит за выключенную функцию).
- **INV-DLP-T5** — все три поверхности **fail-open**: сбой журнала/SSE/снимка не
  роняет ход и не отменяет вызов модели (INV-15: отказ пишется, но не молчит).
- **INV-DLP-T6** — security-журнал наполняется из `logAudit` **независимо** от
  конфига `AuditNotifier` (по умолчанию выключенного).
- **INV-DLP-T7** — историческая совместимость: записи `egress_turn` без `hits`,
  `session.jsonl` без `llm_request` и старые `audit.jsonl` рендерятся как раньше.

## 4. Контракты

### 4.1 Позиция редакции — `EgressHit`

`modules/security/data-policy/types.ts`

```ts
interface EgressHit {
  dataClass: DataClass;
  kind: string;
  surface: "message" | "tool";
  messageIdx?: number;   // surface: "message"
  role?: string;
  tool?: string;         // surface: "tool"
  field?: string;        // "content", "description", "arguments.path"
  start: number;         // код-поинты исходной строки
  end: number;
  replacement: string;   // "[PII]" | "‹PATH›" — без id
  preview?: string;      // только секреты, маскированный отпечаток
}
```

Источник: `projectText` возвращает `redactions` (диапазон + метка), `projectDeep`
и `projectToolDefs` вызывают sink с локатором. Guard капнул 64 хитов на вызов,
журнал хода — 24 на ход (`MAX_TURN_HITS`), избыток в `hitsTruncated`.

Расширение агрегата:

```ts
interface EgressTurnSummary {
  // …существующие поля
  hits?: EgressHit[];
  hitsTruncated?: number;
}
```

### 4.2 Снимок запроса — `LlmRequestSnapshot`

`src/llm/request-snapshot.ts` (новый). Шов — **множественная подписка**, не одна
глобальная функция:

```ts
subscribeRequestSnapshots(fn: (snap: LlmRequestSnapshot) => void): () => void
captureRequestSnapshot(body, meta): LlmRequestSnapshot | undefined
```

Точка съёма — `buildRequestBody` в `openai-compat` (`streamOnce` и
`doNonStreaming`), т.е. **post-DLP** тело. Форма:

```ts
interface LlmRequestSnapshot {
  ts: string; requestId: string; sessionId?: string;
  providerHost?: string; model: string; stream: boolean;
  params: { maxTokens?; reasoningEffort?; reasoning?; temperature?; streamUsage?; toolChoice? };
  system: string;                    // склеенные role:"system"
  messages: { role; text; clipped? }[];
  tools: { name; description?; descriptionClipped? }[];
  truncated: boolean;
}
```

Адресаты: webui (`request-forward.ts`) пишет `llm_request` в `session.jsonl`
раннера-владельца и шлёт SSE `llm_request`; Trace рендерит строку «запрос»,
клик — поп-ап. Бэкфилл — через `/api/sessions/:id/log` (`llm_request` в
`TRACE_LOG_TYPES`).

### 4.3 Событие защиты — `SecurityEvent`

`modules/security/security-events.ts` (новый):

```ts
interface SecurityEvent {
  ts: string;
  class: "block" | "dlp" | "approval" | "ssrf" | "network";
  severity: "low" | "medium" | "high" | "critical";
  summary: string; action: string; success: boolean;
  sessionId?; tool?; path?; command?; url?; reason?; details?;
}
```

Наполнение:
- `logAudit` → `securityEventFromAudit` (block/approval/упавший network; блок с URL — SSRF);
- DLP-диагностика (`egressDiagnosticSink`) → `aborted`/`degraded`/`redacted` с секретами.

Транспорт: кольцевой буфер на сессию (200) + `subscribeSecurityEvents`; webui
переиздаёт SSE `security` и отдаёт историю `GET /api/sessions/:id/security`
(слияние `audit.jsonl` + буфер, дедуп по `ts/action/цель`).

## 5. Поверхности (что видит пользователь)

| # | Где | Что |
|---|---|---|
| **U20** | Trace → строка «запрос» → поп-ап | модель, хост, параметры; `system` (свёрнут), сообщения с индексами и ролями, тулы, маркер усечения, «копировать JSON» |
| **U21** | Бейдж DLP → «Где именно» | строка на находку: `сообщение N · role · field[start–end] → [PII]`; клик открывает снимок запроса на этом сообщении; `+N ещё` |
| **U22** | Сайдбар → «Безопасность» | свежее сверху, время / глиф класса / суть; фильтры по классам; непрочитанное на иконке; клик — детали (время, класс, тул, путь, URL, причина, сессия) |

Стиль — по `STYLE.md`: без boxed-панелей, глифы классов текстовые, quiet by default.

## 6. Волна 2: покрытие egress (вне объёма этой итерации)

Закрываются отдельными ветками после приёмки прозрачности:

| Вектор | Как | Статус |
|---|---|---|
| payload `web_search` | запрос через guard перед DuckDuckGo (цель `api`, external) | ✅ `projectOutboundText`, `tests/security/outbound-projection.test.ts` |
| `modules/mcp/client.ts` | payload MCP-тулов через `filterClient` | ⏳ нужен taint-контракт |
| hidden-сегмент в SSE args/output | field-aware матчинг `apiHiddenGlobs` по `args.path`/выходу | ✅ `projectText` разворачивает путь до конца, `tests/security/api-hidden-globs.test.ts` |
| base64/hex/percent/split | детекторы закодированных и «склеенных» значений | ✅ `detectors/encoded.ts` + `detectors/joined.ts` (полныйwidth, гомоглифы, zero-width, JSON-экранирование); гейты `dlp-adversarial`, `dlp-canary` |
| DNS-подмена trust | документировать IP/CIDR allowlist (поддержка уже есть в `hostMatchesEntry`) | ✅ спека 2026-10-19, §«Остаточное» |
| CLI-уведомление о редакции | долг `dlp-cli-redaction-notice` | ✅ строка после хода (`takePassiveEgress`) |

## 7. Не-цели

- Шифрование at-rest (`at-rest-pii`), taint-трекинг (`file-content-taint`),
  NER-детекция ФИО — крупные отдельные контракты, остаются в `debt.md`.
- Виртуализация Trace/журнала (U14) — не часть DLP.
- Изменение самой политики редакции: правила классов не трогаются.

## 8. Риски

| Риск | Смягчение |
|---|---|
| Снимок раздувает `session.jsonl` | кап 64k, по сообщению 8k, «обрезано» честно |
| Секреты в снимке | снимок post-DLP; для доверенного провайдера путь остаётся, но E2 фильтрует ответ API |
| Шум security-журнала | буфер 200, DLP-событие только для необратимых/аварийных случаев |
| Циклы импортов (security ↔ core) | `security-events` не импортирует ничего; `AuditLike` — структурный тип |

## 9. Проверки

- `tests/security/dlp-hits.test.ts` — позиции, локатор, дедуп/кап, отсутствие оригиналов.
- `tests/llm/request-snapshot.test.ts` — форма, капы, ленивость, изоляция подписчиков.
- `tests/webui/llm-request-snapshot.test.ts` — `llm_request` в журнал + SSE, отписка.
- `tests/webui/security-log.test.ts` — классификация, буфер, бэкфилл без дублей.
- `tests/webui-assets.test.ts` — порядок `TABS` = порядок кнопок в `index.html`.
- `tests/i18n.test.ts` — паритет ключей и плейсхолдеров ru/en.
