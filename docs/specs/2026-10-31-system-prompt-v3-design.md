# Системный промпт v3: контракт, факты, бюджет

_Дата: 2026-10-31. Ветка: `spec/system-prompt-v3`. Статус: Draft (на ревью)._

Уточняет и заменяет практику «добавим ещё одну директиву в `buildSystemInfo`».
Опирается на [architecture v2](./2026-10-12-architecture-v2-design.md) (INV-6, INV-16,
INV-17), [prompt caching](./2026-09-17-prompt-caching-budget.md) и
[реестр долгов](../agents/debt.md).

## 1. Что наблюдается

Сессия `ses_mvw18wjm_oklrydqoqzupcqlp` (31.10.2026, 32K, `qwen3.8-27b-uncensored`):

```
systemTokens 2893
  core system     1897  included
  skills          3443  excluded  "budget: 3443 tok did not fit"
  project map     1690  excluded  "budget: 1690 tok did not fit"
  memory           417  included
  browser           80  included
  hidden tools     114  included
```

Ядро — 105 строк / ~1919 токенов (`estimateTokens`), это ~59% системного бюджета
на 32K (`contextWindow 32768 × contextBudget.systemPrompt 0.1 = 3277`). На 16K
бюджет 1638 — ядро уже больше бюджета, но блок `essential: true`, поэтому
`PromptBuilder` всё равно его включает.

В этом же репозитории `AGENTS.md` — ~24.4K символов (~6.1K токенов). После ядра
на 32K остаётся ~1.3K, то есть проектные инструкции гарантированно уходят в
суммаризацию/обрезку. Модель получает общие правила и почти не получает
проектные.

Отдельно: каталог скиллов — один блок. У пользователя ~130 `SKILL.md`; на 32K
блок не влезает и выбрасывается целиком. `load_skill` при этом говорит, что
«список в системном промпте — источник истины». Списка нет.

Это не набор случайных багов. Это отсутствие контракта: в одном статическом
блоке смешаны инварианты, факты окружения, политика безопасности и допущения
конкретно про MMA/Bun. У них разные владельцы, времена жизни и источники правды.

## 2. Цели

1. **Контракт.** У промпта есть явные секции, владельцы, времена жизни,
   приоритет и бюджет. Новое правило не добавляется «в общий текст», а получает
   секцию и проверку.
2. **Факты вместо догадок.** Каждое утверждение о среде (Bun, shell, MCP, LSP,
   autoPlan, доступные тулы) берётся из факта, а не из константы в промпте.
3. **Согласованность.** Промпт не обещает того, чего не делает enforcement, и не
   дублирует описание тула в другой формулировке.
4. **Предсказуемая деградация.** На 32K проектное (AGENTS.md, карта, скиллы)
   деградирует по явному приоритету и с уведомлением модели, а не молча.
5. **Проверяемость.** У каждого инварианта есть гейт: бюджет, платформа,
   доступность тулов, отсутствие противоречий.

## 3. Не-цели

- **Не реализуем token flow для `approve`.** Это отдельный контракт поверхности
  (DEBT `approve-marker-not-authoritative`). В этой спеке промпт перестаёт
  обещать то, чего enforcement не делает; долг остаётся в реестре.
- **Не меняем политику безопасности** (protected paths, blacklist, SSRF).
- **Не переписываем содержимое скиллов.**
- **Не локализуем весь промпт на русский.** Канон модельного текста — английский.
- **Не добавляем новые тулы** ради промпта (кроме, возможно, поиска по скиллам —
  см. §6.2).

## 4. Контракт: секции, владельцы, времена жизни

### 4.1 Секции

| ID | Секция | Владелец | Время жизни | Приоритет | Бюджет |
|---|---|---|---|---|---|
| `identity` | кто агент, язык ответа | core | сессия | critical | ≤ 30 |
| `environment` | workspace, OS/shell, runtime, дата, активные категории тулов | core + env facts | сессия/сутки | high | ≤ 120 |
| `scope` | что просили, read-only vs change, артефакты, стоп/вопрос | core | статика | critical | ≤ 210 |
| `safety` | недоверенный веб, protected paths, security restrictions | core + security | конфиг/сессия | critical | ≤ 180 |
| `workflow` | осмотр → план → действие → проверка → отчёт | core | статика | high | ≤ 160 |
| `narration` | что говорить пользователю по ходу | core | статика | normal | ≤ 80 |
| `done` | условия завершения и «спроси, если» | core | статика | high | ≤ 120 |
| `memory` | предпочтения и хвост памяти | memory | сессия | normal | динамика |
| `instructions` | AGENTS.md (проект, `.mma`, глобальный) | agents-md | сессия | high | динамика |
| `project-map` | карта проекта | indexer | ход (снимок) | normal | динамика |
| `skills-catalog` | имена + одна строка описания | skills | сессия | normal | ≤ 240 (32K) |
| `loaded-skills` | тела загруженных скиллов | skills | ход | low | динамика |
| `plan` | активный план и шаги | execution | шаг | critical | динамика |
| `session` | id/имя/модель/окно | session | сессия | low | ≤ 40 |
| `model` | активная модель | core | ход | low | ≤ 30 |
| `plugin-capabilities` | тулы плагинов | plugins | сессия | low | динамика |
| `hidden-tools` | скрытые тегами тулы и как их включить | tools | теги | low | ≤ 120 |
| `overflow-note` | что сжато/выброшено | core | сессия | high | ≤ 80 |

Жёсткие цели для статического ядра: **≤ 900 токенов (target), ≤ 1000 (hard cap)**.
Сумма `identity + environment + scope + safety + workflow + narration + done` —
это и есть ядро. Всё остальное — отдельные блоки.

### 4.2 Приоритет при конфликте

1. Безопасность и enforcement (нельзя обойти, даже если пользователь просит).
2. Явный запрос пользователя.
3. Проектные инструкции (`AGENTS.md`).
4. Дефолтное поведение харнесса.

Если два правила конфликтуют и приоритет неочевиден — **спросить**, а не
угадывать. Промпт должен содержать эту фразу один раз, а не выводить её из
десяти частных правил.

### 4.3 Времена жизни и порядок

- `static` — не меняется в рамках сессии, кроме смены конфига.
- `session` — стабильно на сессию (id, модель, окно, AGENTS.md).
- `turn` — пересобирается на ход, внутри хода заморожено (карта).
- `step` — может меняться внутри хода (план, загруженные скиллы, hidden tools).

Порядок в собранном промпте — **стабильный префикс сначала, волатильное в
конце**. Это не то же самое, что `priority`: priority решает, что войдёт в
бюджет, а порядок решает, что попадёт в KV-кеш.

```
identity → environment → scope → safety → workflow → narration → done
→ memory → instructions → project-map → skills-catalog
→ session → model → plugin-capabilities → hidden-tools → overflow-note
→ plan → loaded-skills
```

`plan` и `loaded-skills` — в хвосте, потому что меняются внутри хода. Сейчас
блок плана — `essential: true` и стоит до AGENTS.md/карты/истории: каждый
`plan_step` инвалидирует prefix-cache. `frozenMapBlock` решает это только для
карты.

## 5. Факты: один вход вместо констант

`buildSystemInfo(config, baseDir, profileCompressed)` не может знать, есть ли
Bun, какой shell, подключён ли MCP, включён ли LSP, какие теги активны. Но
именно это он утверждает. Вводится явный вход:

```ts
type ToolPresence = "present" | "missing" | "unknown";

export interface PromptEnvironmentFacts {
  baseDir: string;
  platform: "win32" | "linux" | "darwin";
  shell: "cmd" | "powershell" | "bash" | "zsh" | "sh" | "unknown";
  runtime: "bun" | "node";
  /** Наличие команды в PATH, а не рантайма самого MMA. */
  tools: { bun: ToolPresence; git: ToolPresence; python: ToolPresence };
  project: {
    packageManager?: "bun" | "npm" | "pnpm" | "yarn";
    testCommand?: string;
    typecheckCommand?: string;
    languages: string[];
  };
  mcp: { configured: string[]; connected: string[] };
  lsp: { enabled: boolean; hasServer: boolean };
  activeToolTags: string[];
  autoPlan: boolean;
  security: AppConfig["security"];
  now: { iso: string; timeZone: string; utcOffset: string };
}
```

Правила:

- **Bun.** Строка «Bun is available» появляется только при
  `tools.bun === "present"` **и** `project.packageManager === "bun"` (или
  `bun.lock`/`bun.lockb`). Иначе — «Use the project's own runtime and test
  command», без `bun test` в примерах.
- **Shell.** Windows-блок появляется при `shell === "cmd"`, а не при
  `platform === "win32"`. На Git Bash/PowerShell — соответствующий текст.
- **MCP.** Статическая строка «MCP servers are available» удаляется. Источник
  правды — MCP-блок; он различает configured/connected.
- **LSP.** `lsp_check` упоминается как проверка записи только при
  `lsp.enabled && lsp.hasServer`; иначе — «if LSP is unavailable, verify with the
  project's own command».
- **autoPlan.** Секции `plan`/`plan_step`/`PLAN QUALITY` не появляются при
  `autoPlan === false`.
- **Дата.** Локальное время с явным offset/timezone, а не UTC без метки.
  Обновляется при смене суток/хода; это единственное стабильное поле, которое
  может менять префикс, поэтому стоит в конце `environment`.
- **Тестовая команда.** Берётся из `project.testCommand`, а не хардкодится
  `bun test`. Если команда неизвестна — «use the project's own check», а не
  выдуманная.

`profileCompressed` остаётся, но только для пользовательских предпочтений; факты
среды — из `EnvironmentReport` (+ module health + active tags).

## 6. Доступность тулов и деградация

### 6.1 Блок не рекламирует скрытый тул

У `PromptBlock` появляется `requiresTags?: string[]` (или эквивалент). Правило:

- Если тег активен — блок включается как есть.
- Если нет — блок **не** говорит «у тебя есть X». Он либо опускается, либо
  заменяется одной строкой: «X доступен через `enable_tools` (тег Y)».
- Статическая строка `TOOLS:` удаляется. Вместо неё — сгенерированная строка
  активных категорий: `Active tool categories: file, code. Others: research,
  browser, shell, vision, image, memory.` (или ничего, если схемы говорят сами).

Это закрывает: `browser`-блок «You have a headless browser tool» при скрытом
`browser`; `web_*`/`process_*`/`remember` в `TOOLS`; `MCP`-строку при
неподключённых серверах.

Связанная правка (тот же контракт, отдельный файл): `tool.tags_blocked` должен
говорить «call `enable_tools` with tag X», а не только «not enabled by current
tool tags». Иначе модель не знает выхода.

### 6.2 Скиллы: каталог и тела — разные блоки

- `skills-catalog` — имена + одно короткое предложение (не 120 слов). Цель ≤ 240
  токенов на 32K; при переполнении — «N more: `find_skills`/`load_skill`».
- `loaded-skills` — отдельный блок, `priority: low`, в хвосте.
- `load_skill` принимает не только точное имя, но и запрос (`query`) или
  появляется `find_skills`: модель должна найти скилл, даже если каталог
  сокращён.
- Если `loaded-skills` не влезает — модуль **не** считает скилл загруженным
  молча: `load_skill` возвращает «loaded, but not included in the system prompt
  due to budget» и/или блок получает `degraded.reason`. Сейчас `load_skill`
  рапортует успех, а блок выбрасывается целиком.

`skills.budget` (0.15) должен быть согласован с системным бюджетом: загруженные
скиллы не могут быть больше остатка системного промпта. Решение: `loaded-skills`
получает `min(skills.budget, systemBudget - used)`, а не независимые 15%.

### 6.3 Уведомление о деградации

`PromptBlock.degraded` уже есть, но ни один модуль его не выставляет. В v3:

- module `getSystemPromptBlock()` возвращает `degraded` при неполном блоке
  (карта пересобирается, память обрезана, скиллы не влезли, MCP не подключён);
- `PromptBuilder` синтезирует `overflow-note` (essential, ≤80) со списком:
  `block — reason` (напр. `skills catalog — budget: 3443 tok did not fit`);
- `resolvePromptOverflowOnce` продолжает сжимать `instructions`/`project-map`,
  но уведомление теперь общее и не только для `kind`-блоков;
- `/sysprompt` и `context`-событие в `session.jsonl` показывают причину
  (поле `reason` уже есть — нужно, чтобы оно заполнялось).

## 7. Что именно меняется в тексте

| # | Сейчас | v3 | Гейт |
|---|---|---|---|
| 1 | `GENERAL KNOWLEDGE (... weather, prices ...)` | Устойчивые факты; живые данные — отдельное `LIVE DATA` + web. Уже сделано в `fix/weather-grounding-guidance` (`2026-10-31-live-data-grounding-guidance-design.md`); здесь не дублируем. | `system-prompt-knowledge-guidance.test.ts` (ветка weather) |
| 2 | `PROTECTED PATHS ... via approve` | «Do not attempt. Explain the risk and ask the user to change the path or grant access.» Пока DEBT не оплачен, `approve` не обещаем. | тест: в промпте нет «approve» рядом с protected |
| 3 | `Runtime: Bun is available` | Только при факте `tools.bun=present` + Bun-проект; иначе — команда проекта. | `facts`-тест: missing → нет строки |
| 4 | `bash` description «shell is cmd.exe» на любой ОС | Описание строится из `facts.shell`; на POSIX — POSIX-текст. | тест на 3 платформы |
| 5 | `PLAN QUALITY ... needs 1:1 checks` + `plan_step` при `autoPlan:false` | Вся plan-секция только при `autoPlan`; формулировка согласована с `plan`: checks recommended, 1:1 для create/behavior. | тест `autoPlan:false` → нет `plan_step`/`PLAN QUALITY` |
| 6 | `TOOLS: ... web/browser/process` + `browser`-блок при скрытых тулах | §6.1: блоки и строка gated by tags. | тест: скрытый тул не рекламируется |
| 7 | `DONE ... each verification reports clean` | «No NEW failures vs baseline»; baseline — из startup-check/пользователя. | тест: строка про baseline |
| 8 | `FORBIDDEN ... see VERIFY` | Ссылка на существующую секцию (`VERIFY EVERY WRITE` / `DONE`), либо убрать ссылку. | тест на dangling-ссылки |
| 9 | `VERIFY EVERY WRITE ... call lsp_check` безусловно | «If the result has [LSP errors]/[Project typecheck failed] — fix; if LSP is enabled and no marker — `lsp_check` once; if disabled — project check.» | тест: LSP off → нет `lsp_check` |
| 10 | `MCP servers are available` (статическая) | Удалить; MCP-блок — единственный источник. | тест: нет статической строки |
| 11 | `Date: <UTC>` | Локальное время + offset/timezone. | тест формата |
| 12 | retry: «2x», «2+», «twice», «3rd time» | Одно guidance-правило: «after 2 different approaches fail — stop and ask»; число — новая константа `RETRY_GUIDANCE_ATTEMPTS = 2`, не четыре разных формулировки. Runtime-пороги (`MAX_CONSECUTIVE_FAILED_BATCHES`, `HARD_STOP_FAILED_BATCHES`) — отдельные и в промпте не цитируются. | тест: одно число, совпадает с константой |
| 13 | narration: «every batch» + «no more than 3» | Одно правило: «one line before the first batch and at least every N silent batches», N = `NARRATION_DIRECTIVE_AFTER_SILENT_BATCHES`. | тест: N совпадает с константой |
| 14 | `ARTIFACTS ... ONLY when explicitly asks for a file` | «Chat answers: no files. Change requests: edit the project as needed.» | тест: есть оба режима |
| 15 | `Read-only ... never modify` + baseline `bun test` | Read-only = no writes; baseline — read-only проверка, но команда проекта. | тест: нет «bun test» как универсальной |
| 16 | `WORK RULES install deps/framework init` | Только для «new project/app»; не универсальное правило. | тест: нет greenfield-правила в общем блоке |
| 17 | `Runtime verification` (164 tok, dev server/MMA_CONFIG_DIR) | В проектное AGENTS.md или скилл `verify-runtime`; в ядре — одна строка «runtime bug → reproduce». | бюджет ядра |
| 18 | смешанный язык (core EN + session/hidden RU) | Модельный текст — EN; `session`/`hidden tools`/`skill hint` получают EN-варианты. | тест: нет RU в core; EN-ключи для модельных блоков |
| 19 | `You are MMA v2` | `You are MMA` (без версии) или версия из `package.json`, если она нужна. | тест: нет хардкода `v2` |

## 8. Язык

- **Модельный текст — английский.** Модели лучше следуют английским
  инструкциям; смесь EN/RU в одном промпте — шум.
- **Пользовательский текст — через `t()`** как сейчас (REPL, веб, ошибки).
- **Динамические модельные блоки** (`session.info_full`, `tools.hidden_header`,
  `skill.prompt_hint`) получают английские варианты; локаль пользователя не
  должна менять язык системного промпта.
- **Русские ключевые слова в core удаляются.** Классификация «read-only»/«живые
  данные» живёт в коде (`auto-tags`, turn guidance), а не в списке слов внутри
  английского правила. Исключение — `AGENTS.md` проекта, там язык выбирает
  проект.

## 9. Бюджет и приоритет деградации

На 32K (`budget = 3277`) целевое распределение:

| Блок | Доля остатка после ядра | 32K |
|---|---:|---:|
| core (identity+environment+scope+safety+workflow+narration+done) | — | 900 (hard cap 1000) |
| instructions (AGENTS.md, сжатый) | 40% | ~950 |
| project-map | 35% | ~830 |
| skills-catalog | 10% | ~240 |
| plan/session/model/plugins/hidden/overflow | 15% | ~355 |
| loaded-skills | входит в эти 15%, не сверх | `min(skills.budget, remaining)` |

Доли считаются от `budget - core`, а не от всего окна: ядро фиксировано, иначе
оно съедает бюджет, который должен достаться проекту. На 64K доли те же, но
карта упирается в свой `indexer.mapTokenBudget` (1500), а AGENTS.md получает
больше. На 16K остаток после ядра — ~738 токенов; это мало для полноценной
карты, поэтому на 16K проектное сжимается/опускается с уведомлением, а не
молча.

Если сумма обязательных (`essential`) блоков превышает бюджет:

1. сжимаются `instructions`/`project-map` (как сейчас);
2. затем сокращается `skills-catalog` (имена);
3. затем выбрасываются `plugin-capabilities`/`hidden-tools`/`session`/`model`;
4. ядро не режется автоматически — его размер держит гейт, а не рантайм.

На 16K ядро должно уложиться в 1000, иначе гейт падает: 16K — это минимальный
поддерживаемый размер, и «ядро больше бюджета» — дефект, а не норма.

`essential` больше не означает «влезет любой ценой»: если `sum(essential) >
budget`, пишется `prompt_degraded` (или `context_degraded`) с причиной, а
`/sysprompt` показывает перерасход.

## 10. Тесты и гварды

Новые/переписанные:

- `tests/core/system-prompt-contract.test.ts`:
  - ядро ≤ 1000 токенов; 32K/16K/64K — `sum(essential) ≤ budget`;
  - каждая секция ровно один раз; нет дублей ключевых правил;
  - нет рекламы скрытых тулов (по `activeToolTags`);
  - `autoPlan:false` → нет `plan_step`/`PLAN QUALITY`;
  - `tools.bun=missing` → нет «Bun is available»/`bun test`;
  - `shell=bash` → нет `cmd.exe`;
  - `shell=cmd` → есть `cmd.exe`;
  - protected paths не обещают `approve` (пока DEBT не оплачен);
  - retry-число совпадает с `RETRY_GUIDANCE_ATTEMPTS`, narration-N — с
    `NARRATION_DIRECTIVE_AFTER_SILENT_BATCHES`; runtime-пороги в промпте не
    цитируются.
- `tests/core/prompt-budget.test.ts`: 32K/16K/64K, ожидаемый порядок блоков,
  `skills-catalog`/`project-map` не выбрасываются молча, `overflow-note`
  перечисляет причины.
- `tests/core/prompt-snapshot.test.ts` + snapshot: полный промпт для
  фиксированного `PromptEnvironmentFacts`; диффы видны в ревью.
- `tests/arch/prompt-guidance.test.ts`: каждое имя тула в промпте существует и
  либо видимо, либо явно gated; каждая ссылка на секцию существует.
- `tests/core/system-prompt-line-length.test.ts`: проверять **собранный** промпт
  с заполненным security (сейчас тест отключает security и не ловит 524-символьную
  строку blacklist).
- `tests/tools/security-decl.test.ts` / `tests/tools/executor*.test.ts`:
  `tool.tags_blocked` называет тег и `enable_tools` (если входит в волну).

Существующие substring-тесты (`toContain("DONE CONDITIONS")` и т.п.) переводятся
на семантические проверки + snapshot; иначе любая правка текста ломает тесты, а
противоречия не ловятся.

## 11. Волны

- **W0 — спека + падающие гварды.** Эта ветка: спека, тесты, которые падают на
  текущем поведении (бюджет, скрытые тулы, `autoPlan:false`, платформа,
  protected/approve). Код не меняем.
- **W1 — P0.** Факты (`PromptEnvironmentFacts`), gating по тегам, Bun/shell/MCP/
  LSP, plan-секция, protected/approve wording, уведомление о недоступном туле.
- **W2 — бюджет/деградация.** Компактный каталог скиллов, split catalog/loaded,
  `degraded` + `overflow-note`, порядок блоков под prefix-cache, ядро ≤ 900.
- **W3 — дедуп/язык/тесты.** Перенос tool-specific правил в описания тулов,
  английские модельные блоки, snapshot/семантические тесты, обновление
  `docs/agents/*` и feature-history.

Каждая волна — отдельная ветка от `master` после мержа предыдущей (правило 3).

## 12. Открытые вопросы (решить на ревью)

1. **`approve` / protected paths:** меняем только текст (не обещаем) или в этой
   же работе платим DEBT (`token flow`)? Предложение: только текст, DEBT — отдельно.
2. **`remember`/`recall`:** добавляем подсказку «enable_tools memory» или делаем
   их `alwaysOn`? Предложение: подсказка, политику тулов не трогаем.
3. **Системный бюджет:** оставляем `0.1` и сжимаем блоки или поднимаем дефолт до
   `0.15` на 32K? Предложение: `0.1` + сжатие; `0.15` — opt-in для тех, кому нужен
   полный AGENTS.md.
4. **`skills-catalog`:** имена+1 строка или только имена? Предложение:
   имя + первые ~10 слов; полный текст — `load_skill`.
5. **`Runtime verification`:** в AGENTS.md проекта или в скилл `verify-runtime`?
   Предложение: скилл/AGENTS.md, в ядре одна строка.
6. **Дата:** обновлять на каждый ход (ломает prefix-cache раз в сутки) или
   оставить на bootstrap? Предложение: обновлять при смене суток, блок — в конце
   `environment`.

## 13. Ссылки

- `src/core/system-prompt.ts` — статический блок.
- `src/core/prompt-builder.ts`, `src/core/agent/prompt-phase.ts` — сборка/бюджет.
- `src/core/bootstrap/workspace-phase.ts` — единственный вызов `buildSystemInfo`.
- `src/core/environment.ts` — `EnvironmentReport` (факты для `PromptEnvironmentFacts`).
- `src/modules/skills/module.ts`, `src/tools/load-skill.ts` — каталог/загрузка.
- `src/modules/indexer/module.ts`, `src/modules/indexer/map-report.ts` — карта.
- `src/modules/browser/module.ts`, `src/modules/memory/module.ts`,
  `src/modules/mcp/tool-shape.ts` — модульные блоки.
- `src/tools/executor.ts` (`tool.tags_blocked`), `src/tools/path-enforcement.ts`
  (protected paths).
- `docs/agents/debt.md` — `approve-marker-not-authoritative`.
- `docs/specs/2026-09-17-prompt-caching-budget.md` — prefix stability.

## 14. Статус реализации

- **W1 (P0) — сделано** в ветке `feat/system-prompt-facts`:
  `PromptEnvironmentFacts` + `collectPromptFacts`; Bun/shell/LSP/autoPlan по фактам;
  gating блоков по `requiresTags` (browser); удалены статические `TOOLS`/MCP-строки;
  protected paths больше не обещают `approve`; plan-секция только при `autoPlan`;
  `plan_step` убран из runtime-блока; `bash`-описание по платформе; тесты
  `system-prompt-facts`, `prompt-facts`, `prompt-block-tags`, `bash-description-platform`.
- **W2 — частично** в ветке `feat/system-prompt-budget`: каталог и тела скиллов
  разделены (`getPromptBlocks`), каталог — имена (≤40 + «N more»), `load_skill`
  принимает `query` для поиска, `plan`/`loaded-skills` уходят в `tail`,
  `omittedBlocksNote` сообщает о выброшенных по бюджету блоках. Остаток W2:
  ядро ≤900, `degraded` для карты/памяти, полный budget-гейт.
- **W3 — не начата:** компактное ядро/дедуп с описаниями тулов, английские
  модельные блоки, snapshot/семантические тесты, обновление `docs/agents/*`.
- **Зависимость:** живое правило `LIVE DATA` для погоды/цен приходит из ветки
  `fix/weather-grounding-guidance` (`2026-10-31-live-data-grounding-guidance-design.md`);
  эта ветка его не дублирует.
