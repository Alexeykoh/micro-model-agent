# Harness bug detection — план работ

**Дата:** 2026-10-15 · **Ревизия:** 5 (после аудита утверждений) · **Статус:** к исполнению,
открытых вопросов нет (решения D1–D8 в §2).

**Источник:** живая сессия `ses_mv8h787b_wuu8g1` и четыре фикса, уже влитых в `master`:
`fix/prompt-overflow-reasoning-strategy`, `fix/compaction-pending-cooldown`,
`fix/critic-timeout-and-diagnostic`, `fix/bash-shell-guidance`.

**Что закрываем.** Четыре дефекта жили в `master` при зелёных `bun test` (~3900) и
`bun run quality`. Все четыре — рассогласование контрактов, а не поломка внутри функции:

| Класс | Дефект | Механика отказа | Волна |
|---|---|---|---|
| A | суммаризатор не передавал `reasoningStrategy` | модель делает не то, тихо и медленно | W3 |
| B | текст тула/промпта противоречил enforcement; `;`-цепочки обходили блок | модель упирается в стену, теряет ходы | W1 |
| C | у after-tool компакции не было cooldown | разбег компакции каждую итерацию | W4 |
| Crit | дефолт таймаута критика ≤ провайдерского дедлайна | диагностика `call_timeout` недостижима | W2 |
| H | заглушки в тестах подменяли то, что проверяют | зелёный тест при сломанном коде | W9 |
| F | fail-open без записи | поломка неотличима от успеха | W10 |
| P | события лога без источника (86%) | событие нельзя связать с автором | W11 |
| S | исходящие вызовы мимо сетевой политики | SSRF | W13 |

Гейты пропустили их по пяти причинам: верификация через заглушки; проверка значений вместо
инвариантов; отсутствие сверки декларации и enforcement; невоспроизводимость emergent-багов
юнит-тестом; отсутствие моста «живая сессия → падающий тест».

---

## 1. Правила исполнения (действуют во всех волнах)

1. **Одна волна — одна ветка от `master`.** Имя ветки указано в волне. В `master` не коммитим.
2. **Гейт сначала красный.** Новый тест предъявляется на строке текущего кода, где он падает,
   **до** появления любых allowlist/baseline-записей.
3. **Baseline только уменьшается.** Счётчики (`.arch-allowlist.json`, новые baseline-файлы)
   фиксируют текущее значение как дату; вырасти они не могут.
4. **Каждое исключение — с причиной.** Запись в allowlist/baseline без обоснования = дефект.
5. **Спека до кода**, если меняется контракт: путь данных, граница модуля, точка enforcement,
   формат события, схема конфига. Флаг «спека» стоит в каждой волне.
6. **Правило 5 AGENTS.md:** новое правило архитектуры сразу получает проверку в
   `tests/arch/*` либо запись в `docs/agents/debt.md`.
7. **Каждая волна заканчивается** `bun test` + `bun run quality` зелёными и обновлением
   перечня гвардов в `AGENTS.md` (сейчас там 10 гвардов).

---

## 2. Решения (закрыты, 2026-10-15)

| # | Вопрос | Решение | Куда идёт |
|---|---|---|---|
| **D1** | Как назначается стратегия reasoning | Трёхслойный резолв: оверрайд для модели → проба/дискавери эндпоинта → пресет. Пресет перестаёт быть единственным источником | W3.1, W3.2 |
| **D2** | Ординал пробы reasoning | Два независимых ординала и требование согласия: (a) отсутствие `reasoning`-чанков, (b) наблюдаемый признак отключения против офлайн-эталона модели. Расхождение → диагностика и статус «не подтверждено»; `openai-effort` пробуется, а не предполагается | W3.2 |
| **D3** | Объём обязательного `source` | Обязателен сразу для всего закрытого союза `type`; `module` обязателен для `module:*`; открытые шаблоны `module_${string}`/`onboarding_${string}` → явный список. Baseline-счётчик стартует с 709/824 и только уменьшается | W11 |
| **D4** | CI и posix | Добавляется лег `quality:posix` (ubuntu-latest) с `tests/arch` + `tests/core` + `tests/tools`; каждый из 30 `skipIf(win32)` несёт причину, список проверяется гейтом. Skip'ы не удаляем — это потеря покрытия | W6 |
| **D5** | `/v1/tasks` на loopback | Токен на loopback остаётся опциональным, но `callbackUrl` идёт через общую сетевую политику; loopback и приватные диапазоны — **deny по умолчанию**, разрешение только явным флагом конфига | W13 |
| **D6** | `pickFor` | Не удаляем: переводим на общий `resolveModelCapabilities`, правим ожидания `tests/providers.test.ts:325, 351-355, 367-369` на трёхслойный приоритет | W3.4, W8 |
| **D7** | Таймаут критика | `CRITIC_TIMEOUT_MS = LLM_REQUEST_TIMEOUT_MS + WRAPPER_OVERHEAD_MS` (запас — именованная константа, 5 000 мс). Границы реестра не меняем: короткий таймаут критика — законный выбор пользователя | W2 |
| **D8** | Fail-open в `path-validator` | Fail-closed: отсутствие `config.security.paths` больше не значит «разрешено всё». BaseDir-проверка и protected-paths не меняются | W9.5, W10 |

Отвергнутые варианты, кратко: прокидывать стратегию по call-site (лечит симптом, повторятся
новые точки); назначать стратегию по типу провайдера (один эндпоинт обслуживает модели с
разными механизмами); удалять `pickFor` с тестами (единственное покрытие роутинга);
ослаблять инвариант таймаута до `>=` (на границе выигрывает внутренний таймаут); оставлять
`source` опциональным для части типов (дыра остаётся там, где атрибуция нужнее всего).

---

## 3. Порядок исполнения

Каждая строка — отдельная ветка и отдельный коммит-набор.

| # | Волна | Ветка | Что даёт | Блокирует |
|---|---|---|---|---|
| 1 | W13 | `fix/outbound-policy-ssrf` | закрывает SSRF в двух точках | — |
| 2 | W5 | `feat/session-diagnose` | инструмент поиска патологий по логам | — |
| 3 | W10 | `test/fail-open-observability` | гейт по `observability.md` + `LLMJudge` перестаёт молчать | — |
| 4 | W9 | `test/double-honesty` | дубли перестают создавать иллюзию покрытия | — |
| 5 | W12 | `test/style-rules-inventory` | правила без гвардов (35 `as any`, швы фаз) | — |
| 6 | W7 | `test/replay-harness` | сценарии на фикстурах W5 | W5, W9.4 |
| 7 | W1 | `test/guidance-enforcement` | декларация ↔ enforcement | — |
| 8 | W2 | `test/timeout-relations` | инвариант обёртки над дедлайном | D7 |
| 9 | W11 | `feat/session-provenance` | `source` обязателен, атрибуция логов | — |
| 10 | W8 | `test/default-single-source` | дефолты и capabilities — один источник | D6 |
| 11 | W4 | `test/compaction-cooldown-invariant` | инвариант «нет разбега компакции» | — |
| 12 | W6 | `test/debt-signature-triage` | долг, триаж, posix-лег CI | D4 |
| 13 | W3 | `feat/reasoning-strategy-single-source` | стратегия reasoning из capabilities + проба | D1, D2, D6 |

Почему такой порядок: W13 — правка поведения, тянуть нельзя; W10 и W9 — самые дешёвые
красные результаты и они бьют по корню (пока двой подменяет enforcement, любой гейт уровня
петли проверяет заглушку); W7 требует фикстур из W5 и списка непокрытых путей из W9.4; W3
последняя, потому что меняет контракт провайдера.

---

## 4. Волны

### W13. Исходящие вызовы мимо сетевой политики (класс S)

**Файлы.** `src/modules/security/audit-notifier.ts` (fetch на строке 234),
`src/modules/service/runtime/webhook.ts` (fetch по `opts.url`, строка 63),
`src/modules/service/api/tasks-api.ts` (`callbackUrl` из тела, строка 240),
`src/modules/security/network-validator.ts` (`isUrlAllowed` — существующая политика),
`src/modules/service/server.ts:23` (токен только для non-loopback).

**Что сделать.**
- [x] Спека `docs/specs/<дата>-outbound-policy-design.md`: политика исходящих вызовов.
- [x] Обе точки проводят URL через `isUrlAllowed`; loopback и приватные диапазоны — deny,
      разрешение только явным флагом конфига (D5).
- [x] Логировать отказ как `Diagnostic` с `source`/`operation`/`cause` (INV-14).

**Гейт** `tests/arch/outbound-policy.test.ts`: ни один `fetch(` в `src/` не принимает URL, не
прошедший через политику; легитимные исключения (провайдеры, `models.dev`, `native-context`,
`provider-context` — конструируют URL из конфига) перечислены явно.

**Красная точка сейчас:** `audit-notifier.ts:234`, `webhook.ts:63`.
**Критерий выхода:** гейт красный до правки; тест, что `/v1/tasks` с `callbackUrl` вида
`http://127.0.0.1:PORT/` отклоняется. **Спека:** да. **Триггер:** новая исходящая HTTP-команда.
**Отклонение от плана:** политика вынесена в отдельный модуль `outbound-policy.ts`, а не
переиспользует `isUrlAllowed` напрямую: она fail-closed и не зависит от
`security.network.enabled` (D5). Попутно вынесены `audit-webhook.ts` (очередь ретраев) и
`api/submit-body.ts` (разбор тела) — иначе гейт размера файлов не проходил.

### W5. Вскрытие сессии — инструмент поиска

**Файлы.** `src/modules/session/` (чтение `session.jsonl`, `app.jsonl`, `audit.jsonl`,
`meta.json`), каталог команд `src/core/commands/catalog.ts`, хендлеры CLI
(`src/cli/repl-commands*.ts` — через handler-map, правило #17).

**Что сделать.**
- [x] Команда `mma session diagnose <sessionId>` с обязательным `--json`.
- [x] Сигнатуры: обрезка/суммаризация системного промпта; серия компакций без прогресса
      леджера; серия `critic_degraded` одного рода; повторные падения одного тула; `claim_retry`
      и пустые/короткие ответы; `SECURITY BLOCKED` одного паттерна ≥ N.
- [x] Каталог сигнатур — в `docs/agents/observability.md` (INV-15), не в `debt.md`.
- [x] Обезличенная фикстура сессии `ses_mv8h787b_wuu8g1` в `tests/fixtures/`.

**Гейт** `tests/core/session-diagnose.test.ts`: фикстура обязана дать ≥5 сигнатур; проверяется
**структура** (`signatures[].kind/count`), а не stdout.

**Критерий выхода:** прогон на реальном «плохом» логе с ожидаемым выводом. **Спека:** да
(новая команда). **Релиз:** MINOR (`CHANGELOG.md` + `package.json`).
**Отклонение от плана:** `--json` — глобальный флаг программы (`-j, --json`), а не
`requiredOption` подкоманды: commander не проверяет mandatory у опции, одноимённой
глобальной, и второй `--json` означал бы две галочки на один флаг. Проверка явная.

### W10. Fail-open не молчит (класс F)

**Файлы.** `src/core/hallucination/llm-judge.ts:78-79`, `src/core/agent/hallucination-claims.ts:26-27`,
`src/core/bootstrap/provider-phase.ts:252-253` и `:65,193`, `src/core/agent/loop-nudges.ts:25-26`,
`src/core/hallucination/factual.ts:222`, `src/core/agent/artifact-resolve.ts:76,83`,
`src/core/context/ledger-absorb.ts:22`, `src/core/agent/context-log.ts:122`,
`src/core/environment.ts:136-137`, `src/core/bootstrap/tool-context.ts:36-45,67-75,79-86`,
`src/output/types.ts:21-26` (`DiagnosticEvent`), `docs/agents/observability.md`.

**Что сделать.**
- [x] **W10.1** Внедрить в `LLMJudge` sink диагностик (образец — `ToolContext.onDiagnostic`),
      эмитить `hallucination_judge_degraded` с `cause`/`operation`; то же для потери claims в
      `hallucination-claims.ts`.
- [x] **W10.2** Гейт «каждая сигнатура `observability.md` подтверждена тестом». Сигнатуры —
      ровно члены союза `DiagnosticEvent` (5 штук).
- [x] **W10.3** Каждый пункт таблицы молчащих `catch` (ниже) — либо диагностика, либо строка
      в `observability.md`, либо запись в `debt.md`.
- [x] **W10.4** Каждый sink `ToolContext` получает тест, который реально его вызывает.
- [ ] **W10.5** (D8) `path-validator.ts:74,90` — fail-closed вместо `allowed: true`; проверить
      все production-точки сборки `ToolContext`. → **вынесено в долг**
      `path-validator-fail-open` (`docs/agents/debt.md`): смена затрагивает все точки
      сборки `ToolContext`, включая тестовые и CLI-пути, и в W10 не проверяема;
      триггер — W9 (шаг W9.5).

Молчащие `catch` (возврат — на строку ниже указанной): `provider-phase.ts:252→253` (reasoning
тихо выключен, при этом транзиентный `null` логируется тем же текстом, что и definitive
`false`), `provider-phase.ts:65,193`, `loop-nudges.ts:25→26`, `factual.ts:222`,
`artifact-resolve.ts:76,83`, `ledger-absorb.ts:22`, `context-log.ts:122`, `environment.ts:136→137`,
`ledger.ts:60` (уже помечен `FAIL-OPEN (INV-15)`, учтён долгом `ledger-write-diagnostics`).

**Гейт** `tests/arch/observability-coverage.test.ts` (каждая сигнатура `DiagnosticEvent` подтверждена тестом) + `tests/core/llm-judge-degraded.test.ts` (сбой провайдера → `pass` + диагностика).
**Красная точка сейчас:** `admission_degraded` реализован в 7 местах `src/`, описан как
INV-15-сигнал (строка 24 `observability.md`), и **не встречается в тестах ни разу** из 5 сигнатур
подтверждены 4.

**Критерий выхода:** гейт красный на текущем коде; `llm-judge` при падении провайдера даёт
`pass` **и** диагностику. **Спека:** да для W10.1 и W10.5. **Триггер:** новый `catch` с
«безопасным» возвратом, новая сигнатура.

### W9. Дубли не создают иллюзий (класс H)

**Файлы.** `tests/core/agent.test.ts` (`createMockDeps` на строках 12-120, 61× `new Agent(deps as any)`),
`tests/arch/module-boundaries.test.ts:97-101` (`scanModules`), `tests/helpers/`.

**Что сделать.**
- [x] **W9.1** Расширить `scanModules()` на `src/core/**` (переиспользовать
      `findForeignHandlerCalls`, allowlist пуст).
- [x] **W9.2** `createMockDeps(): AgentDeps` без `as any`; baseline-гейт на число `as any`/
      `as unknown as` в `tests/core/**` (729 сейчас, в `tests/core` — 192).
- [x] **W9.3** Дубль `ContextManager` (14 методов против 43 реальных) — либо `satisfies`, либо
      явный список «осознанно не покрыто» с причиной на каждый из 29 отсутствующих.
- [x] **W9.4** Список путей `src/core/agent/*`, недостижимых из-за заглушек
      (`needsCompaction: () => false`, пустые `getToolDefinitions`, `criticOverride`) — это вход
      для W7.
- [ ] **W9.5** (D8) fail-closed — см. W10.5 → долг `path-validator-fail-open`.
- [x] **W9.6** Каждый тест с seam (`criticOverride` — все 4 теста `agent-critic`,
      `finalAudit` — 9 в `execution-plan-fixes`, `agentFactory` — 12) получает парный тест на
      реальный путь либо попадает в перечень непокрытых гейтов.

**Отклонение:** baseline кастов — **138**, а не 192 из плана. Плановое число получено
`git grep -c` (строки, а не вхождения); в этой волне касты сняты (193 → 138), и гейт
считает именно вхождения.

**Гейт** расширение `tests/arch/module-boundaries.test.ts` (скан `src/core/**` на `.handler(`) + `tests/arch/double-honesty.test.ts` (baseline `as any` в `tests/core/**`, полнота дублей, список непокрытых путей петли).
**Красная точка сейчас:** `src/core/agent/loop-llm.ts` вызывает `tools/x.handler(...)` (фикстура
гейта); `new Agent(deps as any)` сверх baseline. Гейт W9.1 на текущем коде **зелёный** — в
`src/core` ноль вызовов `.handler(`, — это держит ноль, а не имитация проверки.

**Критерий выхода:** гейт красный на фикстурах; в `tests/core` одна проверка `mockExecutor.execute`
заменяется набором на реальный путь. **Спека:** нет. **Триггер:** правка `tests/core/**`, новый seam.
**Фактически:** дубль `ContextManager` покрывает **14 методов против 43** реальных; таблица
`UNCOVERED_CONTEXT_METHODS` разделяет отсутствующие на «петля зовёт, дубль молчит» (16 —
самый опасный класс) и «петля не зовёт». Снято 55 кастов, `new Agent(deps as any)` → `new Agent(deps)`.

### W12. Правила без гвардов

**Файлы.** `src/core/agent.ts` (10 кастов `as unknown as *Host` на строках 301, 313, 318, 324, 328,
429, 486, 494, 499, 504), `src/config/config.ts:115,220,326,327,384`,
`src/config/utils.ts:17,19,20`, `src/config/domains.ts:55,124`, `docs/agents/code-style.md`.

**Что сделать.**
- [x] `tests/arch/style-rules.test.ts` по образцу `debt-register`: правила из `code-style.md`
      без гварда ↔ baseline-запись с причиной (только уменьшается).
- [x] `as unknown as *Host` в `src/core/agent.ts`: каждый шов объявлен с причиной, необъявленный —
      красный. Список фаз — константа, чтобы правило нельзя было обойти переименованием.
- [x] 25 молчаливых `.catch(...)` — бюджет на файл с причиной в гейте. Эталон —
      `llm-judge.ts` (единственный сайт с комментарием-обоснованием).
- [x] `as any` в `src/` — baseline-счётчик в `style-rules.test.ts` (тестовый остаётся в W9.2).

**Гейт** `tests/arch/style-rules.test.ts` (правила `code-style.md` ↔ гвард/baseline; счётчики кастов, `*Host`-швов и молчаливых catch).
**Красная точка сейчас:** 36 `as any`/`as unknown as` в `src/` (10 из них — швы фаз), 25 молчаливых
catch. **Критерий выхода:** гейт красный на необъявленном шве/касте/catch. **Спека:** нет.

**Отклонение от плана (записано при исполнении).** План требует **убрать** 10 кастов
`as unknown as *Host`, заменив `this` на явные объекты-литералы («компилятор проверит каждое
поле»). Это **невыполнимо и было бы регрессом**: `PromptPhaseHost`, `TurnRunHost`,
`ProviderPhaseHost` — это буквально «мутабельный вид `Agent`» (так и написано в их JSDoc):
фаза пишет `overflowHintBlock`, `shutdownRequested`, `abortController`, `systemPromptAdded`,
`overflowResolved`, `probePassed`, `lastProbeIdentity` **обратно в Agent**. Литерал с
`overflowHintBlock: this.overflowHintBlock` скопировал бы скаляр, и запись потерялась бы
молча — компилятор как раз перестал бы ловить это. Правильный инвариант: каст **объявлен с
причиной**, а новый (не «живой вид») краснеет. Это и реализовано (`HOST_CASTS`).
Второе: baseline живёт **в гейте** (как `UNCOVERED_CONTEXT_METHODS` в W9), а не в отдельном
`.arch-style-baseline.json` — repo-паттерн «объявленная таблица один в один», меньше
подвижных файлов. Третье: проверка `*Host` положена в `style-rules.test.ts`, а не в
`module-boundaries.test.ts`: границы модулей и стиль — разные контракты.
Четвёртое: молчаливых catch оказалось **25**, а не 23 (`lsp/check-tool.ts` — проба пути,
`lsp/connection.ts` — best-effort диагностика); учтены бюджетом.
Пятое: счётчик `as any` в `src` **не слит** с тестовым из W9.2 — они измеряют разные области
(`src` vs `tests/core`); слияние потеряло бы сигнал «где» ценой «одного числа».

### W7. Replay-харнесс

**Файлы.** `tests/integration/*.integration-test.ts` (или новый `tests/replay/`),
`vitest.integration.config.ts`, `package.json` (подключение к гейту),
`src/modules/certification/scenarios.ts` (образец сценарного набора), `MMA_CONFIG_DIR` для изоляции.

**Что сделать.**
- [x] Детерминированный replay обезличенной фикстуры против mock-провайдера.
- [x] **Подключить набор к гейту** отдельной задачей: сейчас `test:integration` не вызывается
      ни в `bun test`, ни в `quality`, ни в CI — тесты там не защищают.
- [x] Инварианты: ≤ `ceil(N/cooldown)` компакций на N итераций; ни одного `SECURITY BLOCKED`
      одного паттерна дважды подряд; ≤ K падений одного тула до срабатывания `stuck-detector`;
      число LLM-вызовов на итерацию ≤ 1 + (критик/субагент); байты system-prompt не меняются
      без смены конфига; при `template-kwarg` в теле запроса есть
      `chat_template_kwargs.enable_thinking=false`.

**Гейт** инварианты поверх replay в `tests/replay/*.test.ts` (или `tests/integration/*.integration-test.ts`) + **подключение набора к гейту** отдельной задачей. Сейчас `test:integration` не вызывается ни в `bun test`, ни в `quality`, ни в CI — тесты там не защищают.
**Критерий выхода:** каждая фикстура W5, упавшая на сигнатуру, имеет хотя бы один красный
инвариант. **Спека:** нет. **Триггер:** новая сигнатура без инварианта.
**Отклонение:** инвариант компакции сформулирован как «интервал между соседними
after-tool компакциями ≥ кулдауна», а не как `≤ ceil(N/cooldown)` на N итераций.
Формулировка из плана на этой фикстуре **зелёная**: 20 компакций на 97 итераций при
кулдауне 3 — это 32 потолка, запас есть, и инвариант не проверял ничего. Реальный
дефект C2 виден в интервалах: 72→73 и 96→97, интервал 1 при кулдауне 3. Тест на
потолок оставлен отдельно (он проверит W4), а на фикстуре зафиксирован **намеренно
красный** `KNOWN-RED`: он держит цену дефекта и делает невозможным «починку», сломав
кулдаун.

### W1. Декларация ↔ enforcement (класс B)

**Файлы.** `src/modules/security/command-validator.ts` (список на строке 25, применение на 217),
`src/modules/security/security-policies.ts:93,251,346`, `src/config/security.ts:94`,
`src/tools/bash.ts:577`, `src/core/system-prompt.ts:112-117,186`.

**Что сделать.**
- [x] **W1a** Для каждого оператора из блок-листа проверить `validateCommand()`: команда с ним
      реально блокируется; и обратно — пример из декларации (`bash.ts:577`,
      `system-prompt.ts:186`) заблокирован. Это и есть дефект B3.
- [x] **W1b** `bash.ts:577` и `system-prompt.ts:112-117` вручную дублируют платформенный факт:
      обе строки обязаны называть `cmd.exe`, `PowerShell` — только в негативном контексте.
- [x] **W1c** Один список операторов: сейчас `security.ts:94` (10 элементов без `&`),
      `command-validator.ts:25` (те же 10 без `&`), `security-policies.ts:93` (11 с `&`).
- [x] Детектор отрицания (`blocked|do NOT|never|not work`) + allowlist декларативных строк —
      без него скан падает на корректном тексте, где `| > >> ; &&` перечислены как запрещённые.

**Гейт** `tests/arch/guidance-enforcement.test.ts`: три независимые части W1a (декларация ↔ поведение `validateCommand`), W1b (один платформенный факт), W1c (один список операторов).
**Фактически:** B3 в коде **уже исправлен** — `echo a; echo b`, `echo a && echo b`,
`echo a | wc -l` блокируются. Расхождения, которые гейт вскрыл, — в списках: политики
`security-policies.ts` запрещают одиночный `&`, которого нет в дефолте (`DECLARED_DIVERGENCES`),
а записи `2>`/`2>>` **мертвы**: их ловит `>`/`>>` раньше в том же списке, и имя мёртвой
записи не появится ни в одной причине отказа (`SHADOWED_OPERATORS`). Обе таблицы обязаны
быть объявлены, и гейт падает на устаревшей записи в них.
**Красная точка сейчас:** фикстуры «`use &&`» (bash.ts) и «`Windows (PowerShell)`»
(system-prompt.ts), расхождение трёх списков по `&`.
**Критерий выхода:** гейт зелёный на текущем коде **без** post-factum allowlist. **Спека:** нет.

### W2. Инварианты таймаутов (класс Crit)

**Файлы.** `src/config/timeouts.ts` (реестр), `src/config/defaults.ts:33`,
`src/modules/critic/client.ts:42`, `src/config/registry.ts:315-327` (границы),
`tests/modules/critic/client-budget.test.ts:166` (тест достижимости `call_timeout`).

**Что сделать.**
- [x] Структурно: дефолт `critic.timeoutMs` **ссылается** на `LLM_REQUEST_TIMEOUT_MS`, а не
      повторяет число (иначе гейт тавтологичен).
- [x] D7: `CRITIC_TIMEOUT_MS = LLM_REQUEST_TIMEOUT_MS + WRAPPER_OVERHEAD_MS` (5 000 мс,
      именованная константа), обёртка строго длиннее внутреннего дедлайна.
- [x] Гейтить и границы реестра: «дефолт в порядке, но `min: 1000` разрешает поломанное
      значение» — тоже дефект.
- [x] Таблица «обёртка одного запроса → внешний дедлайн» (critic, judge галлюцинаций,
      browser-мост). Походовые бюджеты (`subagent.timeoutMs = 180000`, `defaults.ts:205`) в неё
      **не** входят: это бюджет хода, для него инвариант не определён.
- [x] Поднять тест достижимости `call_timeout` из `client-budget.test.ts` в общий паттерн.

**Гейт** `tests/arch/timeout-relations.test.ts` (структурная ссылка дефолта + запас `WRAPPER_OVERHEAD_MS` + достижимость `call_timeout`).
**Красная точка сейчас:** равенство дефолта и внутреннего дедлайна (одна константа).
**Отклонения от плана, оба в пользу плана:** (1) инвариант обёртки **не применён**
к `hallucination.judge` (15 с) — там таймаут намеренно короче провайдерского
дедлайна, это fail-open по решению; решение записано в `INTENTIONAL_SHORT_DEADLINES`,
и гейт падает, если судья вдруг станет длиннее (тогда запись станет ложью).
(2) границы реестра **не подняты** до провайдерского дедлайна — по D7 короткий
таймаут критика законный выбор пользователя; гейт проверяет лишь нижнюю границу.
Тест достижимости `call_timeout` переведён на дефолт с фейковыми часами
(125 с реального ожидания не влезли бы в 5-секундный лимит; `advanceTimersByTimeAsync`
в раннере Bun-vitest отсутствует). Проверено: с возвратом `timeoutMs =
LLM_REQUEST_TIMEOUT_MS` краснеют **оба** теста — и гейт, и тест достижимости.
**Критерий выхода:** красный на `timeoutMs: LLM_REQUEST_TIMEOUT_MS - 1`, на `60000` и на
подмене дефолта литералом. **Спека:** да (D7). **Триггер:** правка любого `*timeoutMs` дефолта.

### W11. Provenance в `session.jsonl` (класс P)

**Замер на реальной сессии:** 824 записи, **115 с `source` (14%)**, 709 без, `module` — 0.
Без provenance ровно доминирующие типы: `tool_call` (116), `tool_result` (116), `context` (111),
`tool_defs` (111), `llm_usage` (111), `assistant` (108), `reasoning` (108).

**Файлы.** `src/modules/session/store.ts` (`SessionLogEntry`, `source?: string`; открытые шаблоны
на 46-47), `src/core/session-logger.ts` (21 вызов), `src/core/bootstrap/tool-context.ts` (3),
`src/core/bootstrap/session-runner-scope.ts` (2), `src/output/session-sink.ts` (2),
`src/core/bootstrap/{agent-phase,context-factory,modules-phase,session-phase,session-runner}.ts`,
`src/modules/service/api/tasks-api.ts`.

**Что сделать.**
- [x] D3: `source` обязателен для всего закрытого союза `type`; `module` обязателен для
      `module:*`; шаблоны `module_${string}`/`onboarding_${string}` → явный союз (сейчас любая
      опечатка проходит компиляцию, а префикс `module_` не совпадает с `module:<name>` из `Source`).
- [x] Гейт `tests/arch/session-provenance.test.ts`: доля записей без `source` по типам из
      закрытого союза сверх baseline не растёт; baseline = 709/824, только уменьшается.

**Гейт** `tests/arch/session-provenance.test.ts` (доля записей без `source` сверх baseline не растёт).
**Красная точка сейчас:** 86% записей без `source`.
**Критерий выхода:** на фикстуре W5 атрибуция 100%. **Спека:** да (контракт схемы лога).
**Триггер:** новое событие в `session.jsonl`.

**Отклонение от плана (в пользу плана).** Критерий «на фикстуре W5 атрибуция 100%»
недостижим и не должен быть достигнут: фикстура — **исторический** снимок, записанный
старым кодом, ретроактивно проставить `source` нельзя (это была бы фальсификация данных,
а не проверка). Более того, сам обезличиватель (`scripts/build-session-fixture.ts`)
вырезал `source`/`module` из whitelist — фикстура теряла атрибуцию **по построению**,
и по ней вообще нельзя судить о provenance. Поэтому:

1. инвариант проверяется **на писателях**, а не на замороженных данных: тип делает
   `source` обязательным (компилятор), а гейт статически сканирует все литералы
   `appendLog({...})` в `src/**` и требует `source:` в каждом;
2. критерий выхода переформулирован: **прогон через `SessionLogger` всех типов
   закрытого союза даёт 100% атрибуцию** (runtime-часть гейта), плюс `module:*`
   обязан нести `module` без префикса;
3. обезличиватель починен (сохраняет `source`/`module`/`origin`) и это
   проверяется тем же гейтом — отдельным `it`.

**Находка, которой не было в плане.** Поле `source` использовалось для **трёх разных
смыслов**: provenance (INV-13), origin измерения usage (`llm_usage`: `"api"|"estimate"`)
и origin reasoning-политики (`reasoning_control`). Именно поэтому типизировать его было
нельзя, и `llm_usage` писал в `source` значение `"api"`, не входящее в `Source`. Разведено:
provenance — `source: Source`, происхождение числа/решения — `origin?: string`. Поле
добавлено в обезличиватель как безопасное.

### W8. Единые источники правды

**Файлы.** `src/core/bootstrap/config-phase.ts:33` (`overrideCooldown: 3`),
`src/config/defaults.ts:217` (`overrideCooldown: 5`), `src/modules/providers/manager.ts:90-113`
(`pickFor`), `tests/providers.test.ts:325,351-355,367-369`.

**Что сделать.**
- [x] Гейт `tests/arch/default-single-source.test.ts`: секции конфига в
      `src/core/bootstrap/**` и `src/core/agent/**` нельзя собирать из литералов — только
      спредом из `DEFAULTS`/базового конфига.
- [x] D6: `pickFor` переведён на общий `resolveModelCapabilities` (читал
      `registry.get(type)?.capabilities` напрямую, игнорируя пробу и оверрайд — второй источник
      правды по capabilities); ожидания в `tests/providers.test.ts` дополнены трёхслойным приоритетом.

**Гейт** `tests/arch/default-single-source.test.ts` + правка `tests/providers.test.ts` под трёхслойный приоритет `pickFor`.
**Красная точка сейчас:** хардкод `overrideCooldown: 3` в `config-phase.ts:33`;
расхождение приоритетов у `pickFor`. **Критерий выхода:** гейт красный на текущем коде.
**Спека:** нет. **Триггер:** новый дефолт в `defaults.ts`.

**Отклонение от плана (записано при исполнении).** Плановая формулировка гейта —
«числовые литералы, совпадающие со значением из `DEFAULTS`, запрещены» — **неверна**:
в `DEFAULTS` есть `0,1,2,3,5,…`, и такие литералы встречаются в bootstrap/agent
**316 раз** (проверено скриптом); гейт был бы шумным и отключённым через день.
Сверка по *имени ключа* тоже даёт ложные срабатывания (`turn-run.ts maxTokens: 48` —
это лимит одного LLM-вызова, а не `DEFAULTS.maxTokens`). Настоящий инвариант — иной:
**секция конфига собирается от `DEFAULTS`, а не переписывается литералами**. Гейт
проверяет структурно: объектный литерал, присвоенный секции (верхнеуровневый объектный
ключ `DEFAULTS`), обязан содержать спред; иначе он молча разойдётся с дефолтом —
ровно это и произошло (`overrideCooldown: 3` против 5, потеря `baseline`).
Невакуозность гейта подтверждается позитивным контролем (синтетическая фабрикация
ловится, спред — нет).

### W4. Нет разбега компакции (класс C)

**Файлы.** `src/core/agent/compaction.ts:96,169` (предикаты), `src/core/agent/constants.ts:34`
(`FORCED_COMPACTION_COOLDOWN = 3`), `src/config/defaults.ts:89`
(`contextBudget.overflowCooldown = 3`), `src/core/agent/loop-state.ts` (счётчики итераций).

**Что сделать.**
- [x] Тест на **предикатах**, а не сценарий: синтетический loop-state, N итераций с заведомо
      переполненным контекстом, утверждение «число срабатываний ≤ `ceil(N/cooldown)`».
      Детерминированно (cooldown — счётчик итераций, не часы), попадает в `bun test`.
- [x] Сценарный уровень отдан в W7 — `tests/integration/*` сейчас вне гейта, там тест не защищает.
- [x] Сигнал «no ledger progress» остаётся **наблюдательным** (не backoff): он пишет
      `context_degraded`, поведение компакции не меняет. Запись в `debt.md` не нужна —
      решение принято, а не отложено.

**Гейт** `tests/compaction-cooldown-invariant.test.ts` (предикаты `compaction.ts:96,169`, синтетический loop-state).
**Красная точка сейчас:** предикат без cooldown (состояние до фикса C2).
**Критерий выхода:** красный до фикса, зелёный после. **Спека:** нет.
**Триггер:** правка `compaction.ts`, `constants.ts`, `context/manager.ts`.

**Отклонение от плана (записано при исполнении).** Обе посылки плана оказались неверны.
(1) Фикс C2 **уже в коде** (`c9144879 fix(context): give after-tool (pending) compaction
a cooldown`, предок ветки), предикат `pendingFallbackDue` уже считает кулдаун — «красная
точка сейчас» устарела. (2) Формула «`≤ ceil(N/cooldown)`» **невыполнима** при текущей
схеме: у компакции ДВА независимых клока — `overflowCooldown` (config) и
`FORCED_COMPACTION_COOLDOWN` для quality/pending. На синтетике «все семейства должны
каждую итерацию» (N=30, кулдаун 3) они чередуются: **20 срабатываний при потолке 10**,
интервалы `1,2,1,2,…` — overflow на итерации N и quality на N+1 дают интервал 1, хотя
каждый кулдаун соблюдён. Это и есть остаток дефекта класса C — тот же рисунок, что у
after-tool до C2, только **поперёк** семейств; в фикстуре W7 он виден как интервалы
72→73 и 96→97.

**Решение (структурное).** Введён **один общий клок** `LoopState.lastCompactionIteration`:
`compactIfNeededV2` не запускает НИ одного семейства ближе `FORCED_COMPACTION_COOLDOWN`,
и клок двигается как при плановых компакциях (`tryOverflowV2`/`tryFallbackV2`), так и при
реактивной (context-length) в `loop-llm.ts`. Семейные кулдауны сохранены — общий
дополняет, а не заменяет. Итог на синтетике: 10 срабатываний, интервалы `3`. Гейт
красный до правки (снятие `compaction.ts`+`loop-state.ts` даёт 20>10 и gap 1), зелёный
после. Фикстура W7 не трогается: она историческая (ДО фикса), её KNOWN-RED держит цену
дефекта и остаётся красным намеренно.

### W6. Долг, триаж и платформы

**Файлы.** `tests/arch/debt-register.test.ts`, `docs/agents/debt.md`,
`.github/workflows/quality.yml`, `package.json`.

**Что сделать.**
- [x] Каждый fail-open путь получает либо проверку, либо запись в `debt.md` (правило 9) —
      закрыто гейтом W10 `tests/arch/observability-coverage.test.ts` (замкнутый `DiagnosticEvent`,
      каждый член обязан иметь тест, доки не считаются покрытием).
- [x] Расширить `debt-register.test.ts`: каждая сигнатура из W5 имеет тест либо запись долга.
- [x] D4: лег `quality:posix` (ubuntu-latest) с `tests/arch` + `tests/core` + `tests/tools`;
      каждый условный пропуск несёт причину, список проверяется гейтом. Причина, почему не
      оставить как есть: релиз собирается под 5 платформ (`release.yml:20-32`), а posix-поведение
      не проверяет никто.
- [x] Каждый новый файл в `tests/arch/` внесён в перечень гвардов `AGENTS.md`.
- [x] Новые общие хелперы используются ≥ 2 местами, иначе `fallow dead-code --fail-on-issues`
      (шаг CI) завалит сборку.

**Гейт** `tests/arch/debt-register.test.ts` (расширение: сигнатура ↔ тест) + `tests/arch/platform-skips.test.ts` (у каждого условного пропуска есть причина); `quality:posix` добавлен в `.github/workflows/quality.yml`.
**Спека:** нет. **Триггер:** новый тест/гейт, изменение CI.

**Отклонение от плана (записано при исполнении).** (1) Плановый гейт `win-only-manifest.test.ts`
назван так, что обещает «30 `skipIf(win32)`»; в гейтовом дереве их **13** — остальные
`skipIf` это интеграционные (`shouldSkip`, живой LLM) и env-условия (CI, симлинки,
Chromium). Гейт назван `platform-skips.test.ts` и покрывает ВСЕ условные пропуски
(`skipIf`/`skip`/skip-хелперы вида `? it : it.skip`/инлайновые `platform() !== "win32"`),
а не только win32: узкая формулировка пропустила бы `webui-smoke` и guard в
`lsp-command.ts` (гейт их и поймал на первом прогоне). (2) Триаж сигнатур реализован как
**явная таблица** `SIGNATURE_COVERAGE` (сигнатура → файл теста + причина) со сверкой в обе
стороны, а не как «где-то в тестах есть строка»: два вида (`tool_failure_repeat`,
`prompt_block_dropped`) до этой волны прямого теста не имели — они добавлены в
`tests/core/session-diagnose.test.ts`, а не спрятаны за долг. (3) posix-полоса добавлена,
но локально на Windows **не запускалась**: её верифицирует сам CI (ubuntu-latest) с
гейтовым подмножеством; host-специфичные отличия объявлены в манифесте пропусков, поэтому
полоса не «тихо-зелёная» на заглушках.

### W3. Стратегия reasoning — одна точка назначения (класс A)

**Файлы.** `src/modules/providers/presets.ts:37,69` (статический `prompt-tag`),
`src/modules/providers/manager.ts:246` (`reasoningStrategyForProvider`) и `:90-113` (`pickFor`),
`src/modules/providers/capabilities.ts:33` (`resolveModelCapabilities` — образец трёх слоёв),
`src/modules/reasoning/probe.ts` (проба: на 46 возвращает `true` до сетевого вызова, ординал на
49/55/58 — «нет `reasoning`-чанков»), `src/llm/openai-compat.ts:100` (`normalizeReasoningEffort`),
`src/core/prompt-overflow.ts`, `src/core/context/chunk-query.ts:147,188`,
`src/tools/chunk-query.ts:101`, `src/modules/critic/client.ts:162`, `src/core/agent/turn-run.ts:123`.

**Спека:** [2026-10-15-reasoning-strategy-design.md](../specs/2026-10-15-reasoning-strategy-design.md)
(INV-R1…R5). **Что сделать.**
- [x] **W3.1** Стратегия приходит в провайдер **один раз при сборке** и применяется ко всем
      вызовам; call-site её не знает и не может забыть. Не прокидывать по каждому месту.
- [ ] **W3.2** D1: `reasoningStrategy` резолвится трёхслойно, как `vision`/`tools`: оверрайд
      модели → проба/дискавери эндпоинта → пресет. `prompt-tag` — только там, где вендор его
      документирует; для эндпоинтов, документирующих `chat_template_kwargs` или
      `reasoning_effort: "none"`, фолбэк — `template-kwarg`.
- [ ] **W3.2** D2: проба получает два независимых ординала (отсутствие `reasoning`-чанков и
      наблюдаемый признак против офлайн-эталона), расхождение → диагностика и «не подтверждено»;
      `openai-effort` пробуется, а не предполагается.
- [ ] **W3.3** Нормализация `"none"` становится стратегии-зависимой (`openai-compat.ts:100`
      сейчас выкидывает `"none"` глобально). Требует различать strict-OpenAI (не принимает
      `"none"`) и локальные эндпоинты, документирующие выключатель — делается вместе с W3.2/D1.
- [ ] **W3.4** Shared-хелпер `tests/helpers/recording-provider.ts`: пишет `ChatOptions` всех
      вызовов по умолчанию; `fakeProvider` в `tests/core/prompt-overflow.test.ts` переводится на
      него, касты (`as unknown as LLMProvider`, `provider2 as any`) исчезают.
- [ ] **W3.4** Таблица «сайт → допустимо/почему» для `reasoningEffort` без `reasoningStrategy`
      (пять существующих мест выше): по умолчанию недопустимо, каждое исключение — с причиной.
- [ ] **W3.4** D6: `pickFor` — см. W8.

**Красная точка сейчас:** фикстура «пресет назначает стратегию, которую эндпоинт не принимает»;
новый LLM-вызов без стратегии.
**Гейт** `tests/arch/llm-call-options.test.ts` (стратегия совпадает с документированным механизмом) + `tests/core/reasoning-strategy-resolve.test.ts` (трёхслойный приоритет).
**Критерий выхода:** красный на пресете, назначающем стратегию, которую эндпоинт не принимает;
красный на новом LLM-вызове без стратегии; красный на фикстуре «стратегия не совпадает с
документированным механизмом для этой модели». **Спека:** да (контракт опций провайдера).
**Регресс:** `tests/core/prompt-overflow.test.ts:138-167` уже закрывает A1 — не переписывать,
а перенести проверку на общий хелпер.

**Долг:** `DEBT(reasoning-hard-switch)` — статическая стратегия пресета и глобальная
нормализация `"none"`; оплачивается этой волной.

---

## 5. Definition of done (на каждую волну)

1. Гейт/тест добавлен, **падал бы до правки** — предъявлена конкретная строка.
2. Файл нового гейта внесён в перечень гвардов `AGENTS.md`.
3. `bun test` зелёный, `bun run quality` зелёный (включая `fallow`).
4. Для изменений поведения — спека в `docs/specs/` (помечено в волне) и запись в
   `CHANGELOG.md` при релизном уровне MINOR (W5).
5. Долг либо оплачен, либо занесён в `docs/agents/debt.md` с критерием выхода и триггером.
6. Общая проверка: `mma session diagnose` прогнан минимум на одном реальном «плохом» логе.

---

## Приложение A. Замеры (как воспроизвести)

Все числа плана получены 2026-10-15 на `master`:

```bash
bun test                                            # 3906 pass, 8 skip, 442 файла
bun test --coverage --coverage-reporter=lcov        # покрытие по файлам
npx --yes fallow@2.88.0 health                      # сложность, CRAP, unit size
npx --yes fallow@2.88.0 dupes --top 15              # клоны (все — в тестах)
npx --yes fallow@2.88.0 security                    # кандидаты SSRF/cmd (unverified)
bun test tests/arch                                  # 14 pass
bun run quality                                      # exit 0
```

Точечные замеры:

```powershell
Get-ChildItem -Recurse src -Filter *.ts | Select-String "fetch\("            # исходящие вызовы
Get-ChildItem -Recurse src/core -Filter *.ts | Select-String "catch" -Context 0,2  # молчащие fail-open
Get-ChildItem -Recurse src -Filter *.ts | Select-String "as any|as unknown as"     # 35
Get-ChildItem -Recurse tests -Filter *.ts | Select-String "new ToolExecutor"       # где реальный исполнитель
Get-Content "$env:USERPROFILE\.mma\sessions\<id>\session.jsonl" | ConvertFrom-Json |
  Group-Object { if ($_.source) { "with" } else { "without" } }                      # provenance
```

**Ключевые цифры для гейтов:** `as any`/`as unknown as` — 35 в `src/`, 729 в тестах (192 в
`tests/core`); `new Agent(deps as any)` — 61; `.catch(() => {})` — 23; non-null assertions — 128;
`.handler(` в `src/core` — 0; `admission_degraded` — 0 в тестах при 7 в `src`; сигнатур в
`observability.md` — 5, подтверждено тестами 4; гвардов в `AGENTS.md` — 10; платформ релиза — 5;
покрытие `loop-llm.ts` 86.8%, `agent.ts` 90.6%, `bootstrap/tool-context.ts` 61.4%,
`hallucination/llm-judge.ts` 97.6%; дубль `ContextManager` — 14 методов против 43; `skipIf` — 30.

**Ловушка метода:** 25 файлов ядра не упоминаются в тестах по имени, но покрыты транзитивно
через `Agent.run()`. Выводы о покрытии делать по lcov, не по grep. Дыры покрытия лежат не в ядре,
а в webui и CLI: `utils/sleep.ts` 0%, `webui/settings/model-cache.ts` 0%,
`webui/assets/md-copy.ts` 2.1%, `feed/question.ts` 4.8%, `plugins/format.ts` 4.9%,
`cli/repl-commands-skills.ts` 5.1%, `settings/editors.ts` 5.1%.

## Приложение B. Аудит утверждений (рев. 5)

Каждое утверждение с `file:line` прогнано против дерева, все числа пересчитаны. Подтверждено
**38 из 38** утверждений с `file:line`. Исправлено в рев. 4–5 четыре расхождения:

| Было | Факт |
|---|---|
| дубль `ContextManager` — 17 против ~35 | **14 против 43** |
| `pickFor` — «нигде не вызывается» | вызывается из тестов `providers.test.ts:325,351-355,367-369`: правка начинается с тестов |
| «все 38 `appendLog` идут через `SessionLogger`» | **21 из 38**; 9 файлов пишут напрямую |
| «петля ни разу не проходит через реальный `ToolExecutor`» | исключение — `tests/core/subagent-parallel-e2e.test.ts:66`, но петля там через seam `agentFactory` |
| `44 skipIf` | **30** (44 — счётчик `skipIf|describe.skip|win32` вместе) |
| W2 «строго `>`» без решения | закрыто решением D7 |

## Приложение C. Что не проверено (и потому не в плане)

- `modules/webui` как территория: покрытие измерено, код не разобран — 6 кастов, 30 `skipIf`.
- Онбординг и `mma setup` — пользовательский слой, тестов меньше всего.
- Достижимость `/v1/tasks` из браузера (blind SSRF): нужен разбор тела запроса.
- posix-поведение: CI только windows, локально windows — выводы сделаны чтением конфигурации.
- Поддержка `reasoning_effort: "none"` конкретными облачными моделями: не сверялась.
