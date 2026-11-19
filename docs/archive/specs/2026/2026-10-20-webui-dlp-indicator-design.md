# Webui: индикатор DLP-редакции за ход

**Дата:** 2026-10-20 · **Ветка:** `feat/webui-dlp-indicator` · **Статус:** принято

## 1. Задача

DLP (`security.dataPolicy.*`) редактирует исходящий к провайдеру вызов, но
оператор этого не видит: в чате нет следа, что путь/PII/секрет были заменены.
Нужен индикатор **на каждый ответ агента** (ход):

- бейдж в футере хода с числом отредактированных значений;
- клик открывает попап: классы, виды PII, назначение (внешний/локальный провайдер);
- бейдж виден и при `0` редакций, пока политика включена;
- данные сохраняются в `session.jsonl` и восстанавливаются при переоткрытии.

Оригиналы значений и token id не показываются и не персистятся.

## 2. Контракт данных

### 2.1 Диагностика guard'а

`GuardDiagnostic` получает (все поля — метаданные, без оригинала):

| Поле | Смысл |
|---|---|
| `sessionId?: string` | сессия, к которой относится вызов |
| `target?: EgressTarget` | `kind`/`trusted`/`host` цели |
| `stats?: Partial<Record<DataClass, number>>` | счётчики по классам за вызов |
| `tokens?: Array<{ dataClass; kind; token }>` | псевдонимы для дедупликации |

`token` — уже выданный псевдоним (`<PATH:…>`, `[SECRET]`, `[FILE]`). Он нужен
только журналу хода; в SSE, историю и логи не попадает.

### 2.2 Агрегат хода

```ts
interface EgressTurnSummary {
  total: number;                                  // уникальные значения
  stats: Partial<Record<DataClass, number>>;      // по классам
  kinds: Partial<Record<DataClass, string[]>>;    // виды (email, phone, …)
  targets: Array<{ kind: "provider"; trusted: boolean; host?: string }>;
}
```

Правило счёта (R-DLP-2):

- токенизированные классы — уникальные `token`;
- `secret`/`file-content` (без id) — max по `(class, kind)` **за вызов**, затем
  сумма по видам. Это не даёт title-gen удвоить один и тот же секрет;
- несколько провайдеров за ход схлопываются в уникальные `targets`;
- внутренние id паттернов секретов (`secret:0`) наружу не выходят:
  `kinds.secret = ["secret"]`. Иначе E2-редактор webui принимает их за секрет
  и переписывает прямо в истории/SSE (`[SECRET]`), ломая виды и дедуп.

## 3. Маршрутизация

- `ProviderManager.build()` передаёт `sessionId` (из `getSessionId()`) в
  `getEgressGuard({ type, baseUrl, sessionId })`.
- Фабрика `createProviderEgressFactory` штампует `sessionId` в диагностику и
  вызывает `noteTarget(sessionId, target)` — назначение известно даже на чистом
  ходе.
- Журнал (`src/modules/security/data-policy/turn-journal.ts`) — process-global,
  ключ `sessionId`:
  - `beginTurn(sessionId)` — открыть пустой бакет (перезаписывает старый);
  - `recordTurn(diag)` — учитывать только `outcome === "redacted"`,
    `target.kind === "provider"` и активный бакет;
  - `endTurn(sessionId)` — вернуть `EgressTurnSummary | undefined` и удалить бакет.
- Диагностика E2 (`filterClient` webui) в журнал не попадает: у неё нет
  `target.kind === "provider"` и своего sink.

Это закрывает долг `egress-diagnostics-parallel` (sink был глобальным и в
параллельных сессиях указывал на последнюю созданную).

## 4. Жизненный цикл хода

- `runRunnerTurn` вызывает `beginTurn(sessionId)` перед `runAgent.run`, только
  если `security.dataPolicy.enabled`.
- На `turn_end` (форвардер):
  1. `endTurn(sessionId)` → агрегат;
  2. запись `egress_turn` в `session.jsonl`;
  3. `egress` добавляется в SSE-событие `turn_end`.
- Чистый ход: `total: 0`, но запись и бейдж создаются.
- Политика выключена: бакет не открывается, события нет, бейджа нет.
- Падение до `turn_end`: бакет отбрасывается (`endTurn` без записи).

## 5. История

- `SessionLogEntry`: тип `egress_turn` + поле `egress?: EgressTurnSummary`.
- `history-api` маппит его в `HistoryEntry { kind: "egress", egress }`.
- Replay рисует тот же бейдж, что и live.

## 6. UI

- `feed/egress.ts` — `egressBadge(summary)`:
  - компактная кнопка: жёлтая иконка щита + подпись `DLP` (без счётчика в
    строке; число отредактированных — в `title`/`aria-label`), классы
    `dlp-badge` (+ `clean` при 0);
  - клик → `openSubDialog(t("web.dlp.title"), details)`;
  - details: total, строки классов с ненулевыми счётчиками, виды PII,
    назначение (host + external/local).
- Live: `onTurnEnd` добавляет бейдж в футер (рядом с метриками).
- History: `history.ts` case `"egress"` добавляет бейдж.
- i18n en/ru: `web.dlp.*` (badge, title, total, empty, class.*, destination,
  external, local, kinds). Симметрия ключей — `tests/i18n.test.ts`.

## 7. Инварианты

- **INV-DLP-1.** Ни оригиналов, ни token id нет в SSE/истории/логах; только
  `EgressTurnSummary`.
- **INV-DLP-2.** Счёт детерминирован: уникальные токены; секреты — max per kind.
- **INV-DLP-3.** Диагностика одной сессии не попадает в агрегат другой.
- **INV-DLP-4.** `enabled: false` ⇒ нет ни журнала, ни события, ни бейджа.
- **INV-DLP-5.** E2-фильтрация webui не учитывается в бейдже.

## 8. Тесты

- `tests/security/egress-turn-journal.test.ts`: дедуп токенов, max секретов,
  маршрутизация по sessionId, пустой ход, target без редакций, игнор E2.
- `tests/providers/egress-session-routing.test.ts`: `sessionId` из
  `getSessionId()` доходит до диагностики через фабрику.
- `tests/webui-dlp-indicator.test.ts`: `egress_turn` → `kind: "egress"`;
  `egress` в `turn_end`; `enabled: false` — ничего.
- Гейты: `tests/arch/debt-register.test.ts` (запись удалена), `bun test`,
  `bun run quality`.

## 9. Вне рамок

- Список конкретных значений/фрагментов (только агрегаты). Частично снято
  спецификацией [2026-10-22-dlp-secret-preview-design.md](./2026-10-22-dlp-secret-preview-design.md):
  для секретов показываются тип и маскированный отпечаток, оригинал — нет.
- Удалённые изображения (`stripImageParts`) в счётчик не входят — отдельная
  задача, если понадобится.
- Экспорт отчёта DLP за сессию.
