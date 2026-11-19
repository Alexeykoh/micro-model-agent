# Дефекты верификации харнесса: план лжёт, аудит противоречит себе

Дата: 2026-11-10. Версия: **0.25.2** (PATCH — правки поведения существующих
контрактов проверки, без новых команд/тулов/ключей; кроме E, см. §9).
Мотивация: живой прогон MMA 0.25.1 (dev-сборка из исходников) на `llama.cpp` →
`qwen3.8-27b`, 4 сессии, ~68 мин, целевой проект `veloman` (Next.js 16 App
Router). Агент довел проект до чистых `npm run build` (39/39 страниц) и
`npm run lint`, но прогон C завершился с **exit code 1**.

Диагноз соседней спеки — [surrender-recovery](./2026-11-10-surrender-recovery-design.md)
— про «агент сдаётся вместо работы». Этот файл — про другое: **агент работал, а
харнесс ему врёт** о результатах его же работы. Шесть дефектов: A (гейт плана
находит чужой файл), B (LSP блокирует корректную запись), C (аудит противоречит
себе), D (проверки не привязаны к шагам), E (тул советует недоступный тул),
F (статический контракт обходит требование поведенческого доказательства).
Пересечения с S1…S6 и порядок — в §7.

Область: `src/modules/execution/*`, `src/modules/lsp/write-check.ts`,
`src/core/agent/{audit-gate,loop-result,constants}.ts`,
`src/tools/{bash-description,process-*}.ts`.

---

## 0. Метод и достоверность

Каждый пункт ниже — не впечатление, а один из трёх видов доказательства:

- **CODE** — прочитан код точки enforcement, указаны `file:line`;
- **LOG** — есть запись в `session.jsonl` / плановом артефакте реального прогона;
- **REPRO** — воспроизведён отдельным зондом (`bun run <probe>.ts`).

Что осталось неподтверждённым, вынесено в §8 и в инварианты не предлагается.

---

## 1. Дефект A — existence-проверка резолвит «любой файл с тем же basename»

**CODE.** `src/modules/execution/auditor.ts:75-109` — `findExistingFile`: сначала
точный `resolve(baseDir, filePath)`, а если его нет — **обход всего поддерева** с
матчем `e.name.toLowerCase() === name` (стр. 98), то есть по basename. `SKIP_DIRS`
(`audit-runners.ts:11-21`) не содержит `src`, поэтому обход находит посторонний
файл.

Используется в четырёх местах:

| Место | Назначение |
|---|---|
| `verifier.ts:66` (`checkFileExists`) | жёсткий гейт `file-exists:` на `plan_step status=done` |
| `step-advance.ts:127` | auto-advance шага по «деливераблам» |
| `final-audit.ts:55` (`autoCloseEvidenceSteps`) | автозакрытие pending-шагов перед аудитом |
| `auditor.ts:172` | финальный аудит файлов done-шагов |

**REPRO.**

```bash
bun run <probe-resolver.ts>
# src/app/definitely-missing/page.tsx
#   реально существует: false | findExistingFile -> ...\src\app\about\page.tsx
# src/components/definitely-missing.tsx
#   реально существует: false | findExistingFile -> null
```

Бьёт только по неуникальным basename (`page.tsx`, `layout.tsx`, `route.ts`,
`index.ts`, `utils.ts`) — ровно по тем, что в реальных проектах встречаются
чаще всего.

**CODE, вторая половина того же дефекта: auto-advance вообще не читает
`step.check`.** В `step-advance.ts` нет ни одного обращения к полю `check`: шаг
закрывается по файловым токенам **описания** (стр. 88) и их существованию
(стр. 127-131), а объявленный контракт не проверяется вовсе. Единственный
потребитель контракта — `verifyCheckContract` из `step-guards.ts:229`, то есть
путь явного `plan_step status=done`.

Отсюда два независимых способа получить ложный `done`:

| Механизм | Что игнорируется | Случаи в прогонах |
|---|---|---|
| fuzzy-резолв basename | точность пути | A:1, B:2 |
| auto-advance без `check` | весь контракт шага | C:2 |

**LOG, случай 1 (fuzzy-резолв).** Прогон B. План `plan_3bhhfc`
(`.mma/plans/archive/plan_3bhhfc.json`): шаги 11 и 12 несли проверки
`file-exists:src/app/cart/page.tsx` и `file-exists:src/app/checkout/page.tsx`,
оба помечены `done`, **а самих файлов на диске не было** — модель записала
только `cart-view.tsx` и `checkout-form.tsx`, а discovery-имена страниц совпали
по basename с уже существующими `page.tsx`. Модель сама это поймала:

```
«The plan auto-marked 11 as done but the page is missing.»
«src/app/checkout/page.tsx does not exist. … the check might have passed?»
```

Прогон A — то же на шаге каталога: запись
`src/app/catalog/[category]/page.tsx` была заблокирована LSP-чеком (дефект B),
файла нет, шаг ушёл в `done`; в логе: «could it be that the plan tool's check
passed anyway».

**LOG, случай 2 (auto-advance без контракта).** Прогон C: шаги 3
(`file-modified:src/app/contacts/page.tsx`) и 4
(`file-modified:src/app/delivery/page.tsx`) ушли в `done` до того, как модель их
отредактировала — её словами: «both marked as complete, but I only edited
footer. Step 3 (contacts page) was never edited!». `file-modified:` не
проверялся вообще: автопродвижению хватило, что файл существовал (создан раньше)
и непустой.

Итог: **5 ложных терминальных состояний шага** (A:1, B:2, C:2).

**Что правильно.**

1. Existence-контракт обязан проверять **заявленный путь**. Fuzzy-резолв
   допустим только как отдельный, явно помеченный режим («unverified / probably
   this file»), а не как `passed`. Для `file-exists:` — только точный резолв;
   для baseless-токенов (`App.tsx`) fuzzy возможен, но с другим сообщением и
   запретом считать это доказательством шага.
2. Auto-advance обязан уважать объявленный `check`: если контракт жёсткий
   (`file-exists:` / `file-modified:` / `web-build:` / `http:` / `browser:`),
   автопродвижение проходит только когда `verifyCheckContract` не блокирует.
   Иначе существуют два свода правил с разной строгостью, и модель получает
   `done` по более слабому.
3. Auto-advance не должен закрывать шаг, если токены его описания резолвятся в
   файлы, которые этот шаг не трогал. `provablyStale` (`step-advance.ts:44-57`)
   уже идёт в эту сторону, но требует старости **всех** файлов — чего хватает
   не всегда (см. случай 2: `contacts/page.tsx` стар, `contacts.ts` свеж).

**Гейт (правило 5).**

- `checkFileExists("src/app/missing/page.tsx")` при существующем
  `src/app/other/page.tsx` → `passed: false`.
- Шаг с `check: file-exists:src/app/x/page.tsx` при отсутствующем файле и
  присутствующем `src/app/page.tsx` **не** закрывается auto-advance.
- Шаг с `check: file-modified:<файл>` не закрывается auto-advance, если файл не
  менялся с момента создания плана.

**Связь с существующей спекой.** [plan-check-path-scope (A9/A10)](../2026-10-30-plan-check-path-scope-design.md)
уже правил ту же функцию — но по части *политики путей* (`expandPath`, jail,
scope) и явно оставил `findExistingFile` как резолвер. Настоящая спека — вторая
половина той же проблемы: сам fallback по basename. Файловые тесты A9/A10
(`tests/modules/execution/plan-check-outside-base.test.ts`) при правке A должны
остаться зелёными.

---

## 2. Дефект B — LSP pre-write блокирует запись по каскаду `implicit any` от неразрешённых алиасов

**CODE.** `src/modules/lsp/write-check.ts:51-108` — `runPreWriteCheck`
освобождает только **прямую** диагностику резолва алиаса (`isAliasModuleError`,
стр. 41-43, шаблон `Cannot find module '@/…'`); всё остальное считается жёсткой
ошибкой (стр. 87, 93-97).

Если алиас не резолвится, TypeScript теряет типы импорта → каскад
`Parameter 'x' implicitly has an 'any' type` (TS7006) и `Cannot find name 'X'`.
Это следствие той же холодной индексации, но под освобождение оно не попадает и
блокирует запись.

**LOG.** Прогон A — 8 блоков записи, все ложные (в прогоне B — ещё 4):

```
filter-panel.tsx(96,24): error: Parameter 'e' implicitly has an 'any' type.
cart-line.tsx(20,32): error: Parameter 's' implicitly has an 'any' type.
compare-table.tsx(34,34): error: Parameter 's' implicitly has an 'any' type.
page.tsx(10,26): error: Parameter 'c' implicitly has an 'any' type.
```

В той же сессии на других файлах лежат прямые `Cannot find module
'@/lib/schemas/product'` — картина подтверждается: индекс холодный, алиас не
резолвится. `npx tsc --noEmit` при этом чист.

**Побочный эффект, который уже попал в код проекта.** Модель обходит баг явными
аннотациями, которых в коде быть не должно: `(c: Category)`, `(p: Product)`,
`useCartStore((s: { setQty: (id: string, q: number) => void }) => s.setQty)` —
последнее дублирует форму стора, который свои типы уже экспортирует. Дефект
харнесса оседает долгом в проекте пользователя.

**Что правильно.** Если в черновике есть хотя бы одна alias-ошибка резолва,
производные диагностики (implicit any, cannot find name — зависящие от
неразрешённых модулей) помечаются `unverified` и не блокируют запись: та же
логика, что уже применена к самой alias-ошибке (INV-H4). Блокировать нужно только
то, что холодным индексом не объясняется.

**Гейт.** Тест: черновик с `import type { Product } from '@/…'` и `.map((p) => …)`
при неразрешённом алиасе → запись разрешена (unverified). Существующий
`tests/harness-budgets.test.ts:61-64` покрывает только прямой случай
(`isAliasModuleError`), каскад — нет; добавить кейс.

---

## 3. Дефект C — финальный аудит противоречит сам себе и валит прогон при выполненной работе

**LOG.** Прогоны B и C, записи подряд:

```json
{"type":"audit","content":"[✓] Задача выполнена: 11/11 шагов, 6 файлов проверено"}
{"type":"directive","content":"❗ Финальная проверка не пройдена: [✓] Задача выполнена:
 11/11 шагов, 6 файлов проверено. Задача НЕ завершена. Незакрытые шаги: 7.
 src/app/page.tsx: «Более 20 моделей» → products.length. …"}
```

Три таких реджекта (`MAX_AUDIT_RETRIES = 3`, `core/agent/constants.ts:168`) →
`auditFailed` (`audit-gate.ts:107-113`) → `success: false`
(`core/agent/loop-result.ts:88-97`) → **exit code 1** при выполненной задаче,
зелёных build и lint.

**CODE, причина 1 — `summary` и `passed` считаются по разным условиям.**

- `Auditor.audit()`: `passed = missingFiles===0 && leftoverFiles===0 &&
  !testsFailing && !typecheckFailing` (`auditor.ts:238-239`) — **без учёта
  незакрытых шагов**;
- `summary` при отсутствии файловых/тестовых/typecheck-ошибок и `!stepsPending`
  → `exec.audit_pass` «[✓] Задача выполнена…» (`auditor.ts:274-285`);
- `runFinalAudit()` добавляет к `passed` условие `&& pendingSteps.length === 0`
  (`final-audit.ts:131` и `156`), но в `summary` пишет чужое:
  `summary: audit.summary` (`final-audit.ts:136`/`161`).

Итог: `passed=false` при `summary=«[✓] Задача выполнена»`. Сообщение, которое
читают модель и пользователь, содержит два взаимоисключающих утверждения.

**CODE, причина 2 — auto-advance обходит `manual:`-гард.**

- `pendingSteps` — это `isUnconfirmed()` (`final-audit.ts:89-95`): шаг с
  `manual:`-проверкой и **без заметки-наблюдения**;
- требование заметки живёт только в `requireManualEvidence`
  (`step-update.ts:52`), то есть только на пути `plan_step`;
- auto-advance зовёт `tracker.updateStepStatus(step.id, "done")`
  (`step-advance.ts:205`), а тот меняет только статус
  (`tracker.ts:37-40`) — заметки нет;
- для сравнения: `autoCloseEvidenceSteps` (`final-audit.ts:75-78`) заметку
  ставит — этот путь, наоборот, чрезмерно мягкий.

Это прямое нарушение **INV-G2** из
[turn-runtime-gate](../2026-10-28-turn-runtime-gate-design.md): «`manual:` без
`verify_evidence` не подтверждает шаг; запись создаётся в том же месте, где шаг
переводится в `done`». Место другое, записи нет.

**Лог указывает именно на auto-advance:** в архивном `plan_m8e0x7` шаг 7 —
`status=done`, `check=manual:…`, `note=""` (пусто). Модель получала отказ
`plan_step step=7` («нужен note с наблюдением»), но шаг всё равно был закрыт —
через `plan_step` это невозможно.

**Цепочка провала прогона C целиком:**

1. Шаг 7 по описанию — правка `page.tsx`, но проверкой ему досталось `manual:`
   (дефект D).
2. `plan_step step=7 status=done` отклонён: `manual:` требует заметки.
3. Модель удалила пять svg → auto-advance увидел текущий шаг 7, резолвнул его
   файл и закрыл без заметки.
4. Финальный аудит: `isUnconfirmed(шаг 7)` → `pendingSteps=[7]`,
   `passed=false`, а `summary` — «[✓] Задача выполнена: 11/11».
5. Три реджекта → `auditFailed` → exit 1.

**Что правильно.**

1. `summary` и `passed` обязаны вычисляться из одного условия. Если есть
   неподтверждённые шаги — summary обязан это говорить (как уже делает
   `exec.audit_pending`), а не печатать «[✓] Задача выполнена».
2. `step-advance` не имеет права закрывать шаг с `manual:`-проверкой (и вообще с
   `check`, требующим наблюдения) без заметки: либо шаг не закрывается, либо
   заметка ставится автоматически — как в `autoCloseEvidenceSteps`.
3. Сообщение реджекта самодостаточно: не «[✓] выполнена» + «не пройдена», а
   список причин.

**Гейт.** Тест на согласованность: для любого результата `runFinalAudit`
`passed === true` ⇒ `summary` без признака незавершённости; наличие
`pendingSteps` ⇒ непустой список причин в `summary`. Второй тест: auto-advance не
закрывает `manual:`-шаг без заметки.

---

## 4. Дефект D — проверки плана не сверяются с шагами (приняли сдвинутый массив)

**LOG.** Архивный план `plan_m8e0x7` (прогон C):

| Шаг | Описание | Проверка |
|---|---|---|
| 7 | `src/app/page.tsx: «Более 20 моделей» → products.length` | `manual:пять svg в public/ удалены` |
| 8 | `Удалить public/next.svg, …` | `command:npm run build` |
| 9 | `npm run build — чисто` | `command:npm run lint` |
| 10 | `npm run lint` | `manual:active.json обновлён` |

Проверки сдвинуты на один относительно шагов.

**CODE.** `parseChecks` (`plan-parse.ts:38-64`) принимает массив `checks` как
есть и сверяет только **длину** (при несовпадении — авто-ремонт по индексу,
стр. 52). Семантической привязки «проверка относится к файлам этого шага» нет ни
в `parseChecks`, ни в `PlanCreator.createPlan`, ни в `plan_step`.

**Следствие.** Поведенческий шаг (правка `page.tsx`) получил `manual:` — то есть
требование заметки-наблюдения, которого он не предполагался. Дальше — цепочка C.
**D — триггер, C — механизм провала.**

**Что правильно.** Контракт «checks идут 1:1 к steps» (объявлен в
`i18n/ru.json:322`) должен быть проверяемым: путь из `file-exists:` /
`file-modified:` обязан встречаться среди файловых токенов описания шага;
`command:`/`manual:` — сверяться с типом шага. Несовпадение — не принимать
проверку (или помечать `unverified`), а не молча смешивать.

**Гейт.** Тест: `checks: ["file-exists:src/a.ts"]` на шаге «Создать src/b.ts» →
отказ/пометка, а не принятый план. presently этот контракт — правило без
проверки, что прямо противоречит правилу 5.

---

## 5. Дефект E — `bash` советует `process_wait`, доступный только если промпт пользователя сказал «фоновый»

**CODE.** `src/tools/bash-description.ts:6-10` советует модели безусловно:
«manage them with process_list, process_log, process_wait, process_kill …
prefer a single process_wait over polling». При этом:

- `process_wait` — `tags: ["shell"]` (`process-wait.ts:26`);
- `process_log` — `tags: ["shell"]` (`process-log.ts:18`);
- `defaultTags: ["file", "code"]` (`config/defaults.ts:58`);
- у `bash` теги `["shell", "code"]` (`bash.ts:64`) — сам доступен через `code`,
  `process_*` — нет;
- отбор по пересечению тегов: `filter-tools.ts:15`.

**REPRO.** Зонд по реальным промптам прогонов:

```
prompt-recon.md  → infer=["document"]
prompt-impl-a.md → infer=["research","document","vision","image"]   ← shell НЕТ
prompt-impl-b.md → infer=["research","shell","document","vision","image"]
prompt-impl-c.md → infer=["research","shell","document"]
```

Автосужение (`auto-tags.ts:62-83`, `SHELL_RE` стр. 42-43) работает, но
триггерится словами **пользователя** (`process_`, `фонов`, `background`,
`docker`, `депло`…). В промпте A таких слов не было → тег не предпосеян →
`process_wait` недоступен. В B и C было «фоновую сборку» → тег появился сам.

**LOG.** Прогон A: `[redirected to tool "process_wait"]` → «process_wait
недоступен» → модели приходится вызывать `enable_tools shell`, чтобы дождаться
собственной сборки.

**Что правильно.** Либо `shell` входит в `defaultTags` (тулы процессов — часть
базового цикла кодовой задачи), либо описание `bash` не ссылается на
незагруженные тулы и явно говорит, что для ожидания нужен `enable_tools shell`.

**Гейт.** Тест: все имена тулов, упомянутые в описаниях тулов из `defaultTags`,
доступны в `defaultTags ∪ alwaysOn`.

---

## 6. Дефект F — `file-exists:` обходит требование «поведенческий шаг доказывается поведением»

**CODE.** Гейт, запрещающий закрывать поведенческий/UI-шаг статическим
доказательством, живёт в `checkDoneEvidence` (`plan-checks.ts:252-265`,
«волна 21» из [turn-runtime-gate](../2026-10-28-turn-runtime-gate-design.md)):

```ts
if (classifyCheck(parsed) === "static" && isBehaviorStep(target.description)) {
  return { note: "", blocked: { … plan.check_need_behavior … } };
}
```

Но `verifyCheckContract` (`step-check-contract.ts`) для `file-modified` выходит
на стр. 23-38, а для `file` — на стр. 39-55, **не доходя** до вызова
`checkDoneEvidence` (стр. 56-66). При этом `classifyCheck` сам относит
`file`/`file-modified` к `"static"` (`plan-checks.ts:121-123`), и существующий
гвард это фиксирует: `tests/execution/verify-evidence-class.test.ts:45` —
`file-exists:src/a.ts` → `"static"`.

**Что правильно.** Требование поведенческого доказательства обязано применяться
и к файловым контрактам (это и есть **INV-G1**: требование живёт в точке
исполнения, а не только в тех контрактах, которые до него доходят):
`isBehaviorStep(описание) && classifyCheck(check) ===
"static"` → шагу нужен `http:` / `browser:` / `web-build:` / `command:` с
тестами, либо `manual:` с наблюдением. Иначе волна 21 закрыла дыру
«сборка зелёная, страница пустая» только для `command:`, а самый частый
контракт (`file-exists:`) остался снаружи.

**Почему это видно на нашем прогоне.** Все UI-шаги плана `plan_3bhhfc` имели
`file-exists:`/`file-modified:` — критерии приёмки SPEC §11 (persist корзины
после перезагрузки, работа фильтров, лимит сравнения) харнесс проверить не мог
и не требовал: достаточно, что файл с таким именем есть.

**Гейт.** Тест в `tests/execution/verify-evidence-class.test.ts`: шаг
«Создать src/app/catalog/page.tsx» с `file-exists:src/app/catalog/page.tsx`
→ `blocked` с `plan.check_need_behavior` (падает до правки).

---

## 7. Связь с surrender-recovery (S1…S6)

Соседняя спека лечит другую беду, но мы сцеплены с ней в двух местах — и оба
работают **против** неё, если порядок не соблюсти.

| Задача S1…S6 | Что берёт у меня | Риск, если сделать раньше |
|---|---|---|
| **S5** (критик видит незакрытые шаги) | переиспользует `isUnconfirmed` (`final-audit.ts:89-95`) | улики строятся на источнике, который врёт: из-за A шаги `done` при отсутствующих файлах, из-за C-причины-2 `manual:`-шаги закрыты без заметки. Критик начнёт ставить `critical` по выдуманному состоянию плана |
| **S6** (аудит на форс-финале) | вызывает `auditGate.evaluate` | включает механизм, который даёт «[✓] Задача выполнена» + «проверка не пройдена» и `exit 1`. S6 умножает число мест, где мой C валит успешную работу |

**Порядок:** дефекты **A и C должны попасть в `dev` до S5 и S6**. Иначе S6
добавит отказов, а S5 научит критика верить лживому состоянию плана.

**B, D, E, F** с S1…S6 не пересекаются. Тематически рядом стоит только **S1/S2**
(недоступность инструмента) и мой **E**: оба про «харнесс даёт модели совет,
который она не может выполнить», но S1/S2 — про недоступный `cmd.exe` и ложный
хинт про workdir, E — про тул, которого нет в активном наборе. Правки
несовместимы по файлам (`bash-process.ts` против `bash-description.ts`),
пересечения по коду нет; держать их в разных ветках.

**F** примыкает не к этой волне, а к
[turn-runtime-gate](../2026-10-28-turn-runtime-gate-design.md) — и нарушает её
инварианты напрямую:

- **INV-G1** требует, чтобы «требование доказательства жило в `verify` (точке
  исполнения), а не в промпте и не в хендлере `plan_step`». Для файловых
  контрактов оно не срабатывает вообще (дефект F) — то есть точка исполнения
  часть контракта не видит.
- **INV-G2** требует, чтобы `manual:` без `verify_evidence` не подтверждал шаг и
  чтобы запись создавалась «в том же месте, где шаг переводится в `done`».
  Auto-advance переводит в `done` в другом месте и без записи (дефект C,
  причина 2) — инвариант уже нарушен, и S5 строит на этом улики.

Правок самих инвариантов не требуется: F — доделка уже объявленного правила
(волна 21 закрыла дыру «сборка зелёная, страница пустая» для `command:`, а
`file-exists:` остался снаружи), править надо в `verifyCheckContract`, рядом
с A.

**Что не переносим к себе из surrender-recovery:** пункт §Проблема-4 про
`planSummary` одной строкой и fail-open критика, неотличимый от «ок», — это их
S5, я его не дублирую.

---

## 8. Что НЕ подтверждено (в инварианты не выносим)

- **Засорение `NOTES.md`** — в логах видно, что за прогон дописывается ~15
  строк вида `path:line — id: '…'` вместо знаний, но кто пишет (модель или
  механизм компакции/ledger) — не разобрал. Нужен прогон с трассировкой
  записи в notes.
- **Критик «отклонил черновик, но вердикт не исполнен»** — в прогоне A модель
  дважды получала «критично» и выдавала по сути тот же текст. Код
  `critic-gate.ts` читал поверхностно; считаю это наблюдением, а не дефектом,
  и отношу к S5 (у критика просто не было улик, чтобы потребовать конкретику).
- **«Модель медлит»** — метрики настоящие (68 мин, ~6 млн токенов на ~20
  файлов), но причинность не разделена: заметная часть возни — прямое
  следствие B (блокировки записи) и C (перепроверки уже проверенного). Вывод
  «модель слабая» без починенных A/C/D некорректен.

---

## 9. Классификация и приоритеты

**PATCH (0.25.2)** для A, B, C, D, F — правки поведения существующих контрактов
проверки, без новых команд/тулов/ключей. **E** формально тоже PATCH по коду, но
если решать его через `defaultTags`, это смена дефолта существующего ключа
конфига (`tools.defaultTags`) — поведение по умолчанию меняется у всех
пользователей; если через правку описания тула — остаётся чистым PATCH.
Рекомендую начать с правки описания.

| Приоритет | Дефект | Почему |
|---|---|---|
| **P0, до S6** | C | Валит прогон при выполненной работе: exit 1, сообщение-противоречие, перезапуск — десятки минут и миллионы токенов |
| **P0, до S5** | A | Ложный `done`: и модель, и аудит верят, что файл создан. Прямое нарушение правила 5 и INV про единственную точку enforcement |
| **P1** | F | Волна 21 задала правило «UI-шаг статикой не доказывается», но оно не действует на самый частый контракт — `file-exists:`. Пока F жив, A и D легко проходят как «доказанные» |
| **P1** | D | Триггер C: сдвинутые проверки превращают обычный шаг в `manual:`-ловушку |
| **P1** | B | Блокирует запись корректного кода и оставляет долг в проекте пользователя |
| **P2** | E | Трение, но self-несогласованность харнесса |

Ветки — по одной на дефект (правило 3): `fix/plan-check-fuzzy-resolve`,
`fix/lsp-alias-cascade-block`, `fix/audit-summary-consistency`,
`fix/plan-checks-step-binding`, `fix/bash-description-tool-availability`,
`fix/plan-check-behavior-gate`.

**Гварды (правило 5).** По тесту на дефект, каждый обязан **падать до правки**:

| Дефект | Файл |
|---|---|
| A | `tests/modules/execution/plan-check-fuzzy-resolve.test.ts` |
| B | `tests/modules/lsp/alias-cascade-block.test.ts` |
| C | `tests/core/audit-summary-consistency.test.ts` |
| D | `tests/modules/execution/plan-checks-binding.test.ts` |
| E | `tests/tools/bash-description-availability.test.ts` |
| F | расширить `tests/execution/verify-evidence-class.test.ts` (кейс `file-exists:` на UI-шаге) |

Правки A и F касаются одного вызова `verifyCheckContract`, поэтому F логично
делать в той же ветке, что и A, если правило 3 позволит слить две правки одной
точки; иначе — последовательно A → F, чтобы F не пришлось реанимировать
закрытые моделью шаги.

---

## 10. Как проверялось (воспроизведение)

```bash
# Дефект A — резолвер находит посторонний файл
bun run <probe-resolver.ts>
# Дефект B — все блоки записи из сессии
bun run <probe-blocks.ts> <session.jsonl>
# Дефект C — записи аудита и директив
bun run <probe-audit.ts> <session.jsonl>
# Дефект E — подсев тегов на реальных промптах
bun run <probe-tags.ts>
```

Зонды и логи прогона: `C:\Users\Alexe\AppData\Local\Temp\opencode\mma-veloman\`
(одноразовые, в репозиторий не входят). Плановые артефакты:
`C:\Users\Alexe\Desktop\mma_test\.mma\plans\archive\` (`plan_hdpo14`,
`plan_3bhhfc`, `plan_m8e0x7`). Полный журнал наблюдений:
`C:\Users\Alexe\Desktop\mma_test\.mma\AGENT-OBSERVATIONS.md`.
