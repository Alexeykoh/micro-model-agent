# Корпоративный слой безопасности — план работ

**Дата:** 2026-10-19 · **Ревизия:** 3 · **Статус:** **исполнен** (W1–W4 слиты в `master`
2026-10-19, merge `41916e2b`; D1/D2 согласованы пользователем 2026-10-19, см. §2).
Открытые хвосты (остаточные векторы, долги) — в [`docs/agents/debt.md`](../agents/debt.md)
и `TODO.md` §1.2; план не переоткрывается, новые пункты — отдельными задачами.

**Источник:** [спека `2026-10-19-corporate-data-policy-design.md`](../specs/2026-10-19-corporate-data-policy-design.md)
(v7). Спека отвечает «что правильно», план — «в каком порядке».

**Что закрываем.** Два класса утечек, которых сейчас не видит ни один гейт:

| Класс | Вектор | Механика | Волна |
|---|---|---|---|
| E1 | V1–V3, V8 | промпт уходит внешнему провайдеру с путями/hostname/home/cwd; санитизации нет | W2 |
| E2 | V4–V5 | API отдаёт абсолютные пути/скрытые файлы/PII клиенту | W3, W4 |
| E2 | V7 | payload framework-webhook уходит наружу с путями | W4 |
| движок | — | общего классификатора/PII нет | W1 |

Ключевые факты, определившие план:
- вызовов `provider.chat(...)` — **13**, поэтому фильтр только в одной точке
  (`ProviderManager.build()`, `manager.ts:193`);
- `ProviderManager` строится в **двух** фабриках — `buildActiveProvider` (`factory.ts:29`)
  и `buildManagedProvider` (`managed.ts:39`, критик/эксперт) → guard нужен **глобальной
  регистрацией**, иначе два пути вне шва;
- **все источники промпта** (включая память — `memory/module.ts`, хвосты `.md` +
  преференсы) сходятся в `LLMProvider.chat`; системный блок несёт `Workspace`/`CWD`
  (`system-prompt.ts:56,116`) — главный вектор;
- существующий `redactContextSecrets` **узкий by design** (`context-log.ts:19-25`) —
  расширять его нельзя;
- `security.pathArgs` (`executor.ts:169`) и `realpath` (`file/paths.ts:40`) уже есть —
  переиспользуем.

---

## 1. Правила исполнения (все волны)

1. **Одна волна — одна ветка от `feat/corporate-data-policy`** (интеграционная ветка;
   имя волны в §3). В `master` не коммитим: туда попадает только итоговый merge после
   совместных тестов.
2. **Гейт сначала красный.** Новый тест предъявляется падающим на текущем коде — **до**
   правки и до allowlist/baseline-записей (правило 7 AGENTS).
3. **Baseline только уменьшается** (`.arch-allowlist.json`, новые baseline-файлы) —
   зафиксированное значение можно лишь сократить.
4. **Каждое исключение — с причиной** в allowlist; запись без обоснования = дефект.
5. **Спека до кода** для смены контракта — уже сделана; при отклонении от неё — правка
   спеки в той же ветке, а не «на словах».
6. **Правило 5 AGENTS:** новое правило → проверка в `tests/arch/*` либо запись в
   `docs/agents/debt.md`.
7. **Конец волны:** `bun test` + `bun run quality` зелёные; обновлён перечень гвардов в
   `AGENTS.md`; для текста, видимого модели/пользователю, — запись в `session.jsonl`/логе.
8. **Playwright — только по явной команде** (правило 8).

**Порядок интеграции:** доки (спека + план) остаются в ветке
`feat/corporate-data-policy` — она **интеграционная**. Каждая волна ветвится от неё и
сливается обратно в неё после зелёных `bun test` + `quality`. Когда все волны влиты и
протестированы вместе — `feat/corporate-data-policy` сливается в `master` одним merge.

---

## 2. Решения

| # | Вопрос | Решение | Куда |
|---|---|---|---|
| **D1** | `pathMode` | `"prefix"` по умолчанию: префикс корня заменяется всегда, workspace-относительный остаток сохраняется; `"full"` — для регулируемого контура | W1 (конфиг), W2 (применение) |
| **D2** | Скрытие путей | **Два списка:** `apiHiddenGlobs` (404 клиенту) и `providerBlockGlobs` (не слать внешнему; дефолт — супермножество `protected-paths ∪ apiHiddenGlobs ∪ секреты`) | W1 (движок), W2 (E1), W4 (E2) |
| **D3** | Шов E1 | `ProviderManager.build()` — единственная точка обёртки; вердикт доверия по распарсенному `host` | W2 |
| **D4** | Контракт движка | `EgressGuard` (§3.1 спеки): `sanitizeChat`/`rehydrateArgs`/`filterClient`, инъекция через bootstrap | W1 |
| **D5** | Токены | Крипто-случайные неперебираемые id; карта на сессию, общая форкам, один писатель; жизнь = окно контекста | W1, W2 |
| **D6** | Логи | `redactContextSecrets` не расширяем; E1-санитизация — **до** snapshot context-log; локальный `session.jsonl` политику не меняет | W2 |
| **D7** | E2-редакция | per-subscriber при сериализации; сохранённое событие не мутируется; второй путь редакции запрещён | W3, W4 |
| **D8** | PII-объём W1 | Email, телефоны РФ/РБ, СНИЛС, ИНН, ОГРН, паспорт РФ, карты (Luhn), IBAN (mod-97), паспорт РБ (серии), дата рождения, IP/MAC. УНП/ID РБ — пониженный confidence (research). NER (ФИО/адреса) — вне W1 | W1 |

D1/D2 **согласованы** пользователем 2026-10-19; открытых решений в плане нет.

---

## 3. Порядок исполнения

| # | Волна | Ветка | Что даёт | Блокирует | Риск |
|---|---|---|---|---|---|
| 0 | docs | `feat/corporate-data-policy` (**интеграционная**) | спека + план как источник волн | все | низкий |
| 1 | W1 | `feat/data-policy-engine` | движок `data-policy` + `EgressGuard` + конфиг | W2–W4 | средний |
| 2 | W2 ⭐ | `feat/data-policy-provider-egress` | E1: наружу к провайдеру ничего не уходит | W3/W4 не блокирует | **высокий** |
| 3 | W3 | `feat/data-policy-api-web` | E2 web: пути/PII не отдаются вебу | — | средний |
| 4 | W4 | `feat/data-policy-api-serve` | E2 serve + 404 + DLP webhook | — | средний |

⭐ — «важнейшее правило» (пресечение на уровне каркаса).

Все ветки W1–W4 ответвляются от `feat/corporate-data-policy` (интеграционной, W0) и
сливаются обратно в неё; `master` — только финальный merge всей ветки.

---

## 4. Детальные волны

### W0 — интеграционная ветка (текущая, `feat/corporate-data-policy`)

- Ветка — **интеграционная**: спека (`d0080405`) и план (`5d830952`) лежат в ней.
- Волны ветвятся **от неё**, а не от `master`; каждая сливается обратно после зелёных
  `bun test` + `bun run quality`.
- В `master` — только финальный merge интеграционной ветки, после совместных тестов.
- **Готово, когда:** доки закоммичены; можно ветвить W1.

---

### W1 — движок `data-policy` (ветка `feat/data-policy-engine`)

**Цель:** классификатор + псевдонимизация/ре-гидратация + путь-политика + конфиг, без
подключения к egress. Чистые функции, тестируемые отдельно.

**Контракт (фиксируем в `types.ts`):**

```ts
type DataClass = "path" | "machine" | "env" | "secret" | "pii" | "file-content";
interface Finding { dataClass: DataClass; kind: string; start: number; end: number;
                    confidence: number; redact: boolean; }
interface EgressGuard { /* §3.1 спеки */ }
```

**Шаги:**

1. `src/modules/security/data-policy/types.ts` — `DataClass`, `Finding`,
   `DataPolicyConfig`, `GuardDiagnostic`.
2. `.../detectors/secrets.ts` — перенос регулярок `data-sanitizer.ts` в общий реестр
   (**без изменения поведения**; старый экспорт остаётся тонкой обёрткой).
3. `.../detectors/paths.ts` — Windows/UNC/POSIX + value-based (workspace/home/cwd);
   нормализация (`~`, `\\`↔`/`, регистр); **URL вырезаются первыми** (Q9).
4. `.../detectors/machine.ts` — `hostname()`, `homedir()`, `env.USER/COMPUTERNAME/…`,
   `platform/type()/release()`.
5. `.../detectors/pii/` — `checksums.ts` (СНИЛС, ИНН, ОГРН, Luhn, IBAN mod-97),
   `rf.ts`, `by.ts` (телефон +375, паспорт-серии РБ, УНП/ID с пометкой research),
   `index.ts` — реестр по `kind`.
6. `.../tokens.ts` — `pseudonymize(text)`/`rehydrate(text)`; **крипто-случайные id**;
   карта на сессию; идемпотентность; hold-back для расщеплённого токена.
7. `.../path-policy.ts` — `apiHiddenGlobs`/`providerBlockGlobs`; матчинг **по `pathArgs`**;
   `realpath`; дефолт-супермножество.
8. `.../guard.ts` — реализация `EgressGuard` (E1-часть `sanitizeChat` может быть заглушкой
   до W2, но интерфейс полный).
9. Конфиг: `DataPolicyConfig` в `src/config/types.ts`; ключи `security.dataPolicy.*` в
   `registry-extra.ts`; i18n `en`/`ru` (symmetрично).
10. `docs/agents/debt.md` — записи `DEBT(research-by-checksum)`, `DEBT(at-rest-pii)`.

**Тесты (red-first):**
- `tests/security/pii-rf-by.test.ts` — валид/невалид для каждого checksum.
- `tests/security/data-policy.test.ts` — классификатор; URL не тронут; case/separator-
  корпус; time-budget; идемпотентность.
- `tests/security/tokens.test.ts` — неперебираемость, чужой токен не проходит, split-token.
- `tests/security/path-policy.test.ts` — glob не матчит URL; symlink→hidden; два списка.

**Готово, когда:** unit зелёные; ключи в реестре видны `mma setup`/веб-панели; `bun run
quality` зелёный. **Не подключаем ни к провайдеру, ни к API.**

**Риски:** ложные срабатывания regex на обычном тексте → пороги + per-class disable;
катастрофический бэктрекинг → только линейные паттерны + бюджет.

---

### W2 ⭐ — E1: egress к провайдеру (ветка `feat/data-policy-provider-egress`)

**Цель:** внешнему провайдеру не уходит ни один факт `path`/`machine`/`env`/`pii`/
`file-content`; локально всё работает; плейсхолдеры ре-гидратируются перед тулами.

**Шаги:**

1. `src/modules/providers/sanitizing.ts` — `SanitizingProvider implements LLMProvider`:
   - в `chat()`: `sanitizeChat(messages, tools)` перед вызовом, `rehydrateArgs` на
     `tool_call.arguments` в стриме (с hold-back);
   - image-части вырезаются для `target.trusted === false` без `allowImagesToExternal`;
   - fail-closed: ошибка/бюджет классификатора → типизированная ошибка без отправки.
2. `src/modules/providers/manager.ts` — в `build()` оборачивать провайдера записи, если
   `guard` передан; вердикт по `entry.baseUrl` (host через `new URL`, порт/`[::1]`/регистр).
3. **Инъекция guard — глобальная регистрация** (R17): в слое провайдеров добавить
   `setEgressGuard(factory)` (прецедент `setProviderMemoryApplier`); bootstrap
   (`core/bootstrap/provider-phase.ts`) строит `EgressGuard` из `data-policy` и
   регистрирует его **до** первой сборки провайдера. `ProviderManager.build()` берёт guard
   при сборке. Так покрываются **обе** фабрики — `buildActiveProvider` (`factory.ts:29`) и
   `buildManagedProvider` (`managed.ts:39`, критик/эксперт) — без правки их вызывающих и
   без импорта security из providers.
4. Эффекты конфига: `ConfigStore.set` для `security.dataPolicy.*` → `provider.rebuild`.
5. Порядок с context-log: санитизация до snapshot'а (`core/agent/context-log.ts`).
6. Обновить `docs/agents/observability.md` (fail-open/abort пути).

**Тесты (red-first):**
- `tests/providers/sanitizing-provider.test.ts`:
  - перехват сериализованного HTTP body: external ⇒ нет `hostname`/`homedir`/abs-пути;
  - trusted (loopback) ⇒ пути на месте;
  - **failover localhost→external не течёт**;
  - **критик/эксперт (`buildManagedProvider`) тоже обёрнуты** (R17);
  - сохранение семантики стрима (abort/`done`/`usage`/порядок чанков);
  - image-части вырезаны; fail-closed abort.
- `tests/providers/prompt-sources.test.ts` (R17): системный промпт с
  `Workspace`/`CWD`, статичные/динамические блоки, **блок памяти**, `runOnBuildPrompt`,
  overflow-сводка, `tools`-описания — внешнему без `baseDir`/hostname; индексер `chat`
  не вызывает.
- `tests/arch/egress-guard.test.ts`: инвентарь `fetch(` с причинами + шов сборки
  (allowlist для `cli/commands.ts:211`, `cli/repl-commands.ts:803` с причиной).
- `tests/config/data-policy-effects.test.ts`: ключи → `provider.rebuild`.

**Готово, когда:** live-прогон `bun run mma "<промпт>"` с внешним провайдером
показывает в перехвате тела только токены; `session.jsonl`/context-log фиксируют
санитизированное; `bun test` + `quality` зелёные.

**Риски (высокие):** обёртка ломает стриминг/abort → тест семантики; неверная
ре-гидратация → тест чужого токена; горячий пересбор провайдера не подхватывает guard →
тест эффектов.

---

### W3 — E2 web (ветка `feat/data-policy-api-web`)

**Цель:** `mma web` не отдаёт клиенту абсолютные пути, скрытые файлы, PII.

**Шаги:**

1. `src/modules/webui/server.ts` — единый `applyEgressFilter` в диспетчере (JSON + SSE),
   **per-subscriber** (INV-D7).
2. `src/modules/webui/session/forward.ts` — SSE `tool_start.args`/`tool_end.output` через
   `guard`; `scrubToolArgs`/`clipToolOutput` → тонкие обёртки (второй путь запрещён).
3. Типизированные DTO на чувствительных endpoint: `state.ts` (`workspace`,
   `instructions.files`), `settings-api.ts` (`source`, plugin `path`, `failures[].path`),
   `config-api.ts`, `history-api.ts`, `log-api.ts`.
4. Сканировать и **тела** значений (`/api/file` может вернуть конфиг с путями) — R5.
5. Гейт: карта токенов никогда не сериализуется клиенту.

**Тесты:** `tests/webui/egress-filter.test.ts` — `/api/state`, `/api/skills`,
`/api/plugins`, SSE без abs-пути/PII; сохранённое событие неизменно (INV-D7); `/api/*` не
отдаёт карту токенов; содержимое `/api/file` сканируется.

**Готово, когда:** живой осмотр веба (по явной команде) не показывает абсолютных путей;
тесты зелёные.

**Риски:** SSE-редакция задевает локальный UI/REPL — INV-D7 и тест события.

---

### W4 — E2 serve + путь-политика + DLP webhook (ветка `feat/data-policy-api-serve`)

**Цель:** `/v1/*` и SSE очищены; скрытый путь → 404; payload framework-egress без путей.

**Шаги:**

1. `modules/service/runtime/event-bridge.ts` + хендлеры `/v1` — через `guard`.
2. `modules/webui/file/paths.ts` + `files-api.ts` + `file-api.ts` — скрытый
   `apiHiddenGlobs` ресурс → **404** (неотличимо от несуществующего, INV-D6); исключение из
   листинга; по каноническому пути.
3. `modules/security/audit-notifier.ts`, `modules/service/runtime/webhook.ts` — DLP payload
   (V7), в связке с `outbound-policy`.
4. Тест изоляции session→map токенов (1 тенант = 1 процесс).

**Тесты:** `tests/service/*` (результаты/SSE без путей); path-hiding 404; webhook payload
без путей; изоляция тенантов.

**Готово, когда:** `/v1/*` и SSE чисты; hidden → 404; webhook чист; зелёный quality.

---

## 5. Гейты и baseline

| Гейт | Что держит | Волна |
|---|---|---|
| `tests/arch/egress-guard.test.ts` | инвентарь `fetch(` + шов сборки | W2 |
| `tests/security/data-policy.test.ts` | классификатор, токены, path-policy | W1 |
| `tests/security/pii-rf-by.test.ts` | контрольные суммы РФ/РБ | W1 |
| `tests/providers/sanitizing-provider.test.ts` | E1 body/стрим/failover/критик | W2 |
| `tests/providers/prompt-sources.test.ts` | все источники промпта через chat (R17) | W2 |
| `tests/webui/egress-filter.test.ts` | E2 web | W3 |
| `tests/config/data-policy-effects.test.ts` | эффекты конфига | W2 |
| `tests/service/*` (расширение) | E2 serve + webhook | W4 |

Все новые allowlist/baseline — **только уменьшаются**; каждая запись с причиной.
Перечень гвардов в `AGENTS.md` пополняется по мере волн.

---

## 6. Долг и остаточные риски (переносим из спеки §14)

- `DEBT(at-rest-pii)` — PII в `session.jsonl`/memory открыто; привязать к
  `sessionEncryption`. Триггер: политика контура.
- `DEBT(research-by-checksum)` — контрольные суммы УНП РБ и ID РБ; до этого
  пониженный `confidence`. Триггер: W1.
- **Остаточные векторы (вне плана):** поисковый запрос `tools/web-search.ts:66`,
  payload `modules/mcp/client.ts`. Отдельная задача.
- **Остаточный риск обхода:** base64/split известного значения.
- **DNS-подмена trust:** документировать; рекомендовать IP/CIDR.
- **NER (ФИО/адреса)** — вне плана.

---

## 7. Что не делаем

- Не расширяем `redactContextSecrets` путями (сломает context-log/`session.jsonl`).
- Не трогаем `ToolExecutor.execute()` как точку enforcement тулов (DLP дополняет).
- Не заводим вторую точку редакции в вебе/service (все — через `guard`).
- Не гоняем Playwright/e2e без явной команды.
- Не запускаем W2–W4 до зелёного W1 (движок — общая база).
