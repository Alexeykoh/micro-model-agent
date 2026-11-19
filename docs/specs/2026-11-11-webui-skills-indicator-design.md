# Web UI: индикатор загруженных скиллов и акцент для `@`-упоминаний

**Дата:** 2026-11-11
**Ветка:** `feat/webui-skills-indicator` (от `v0_25_5` → `dev`)
**Тип:** изменение контракта (новый SSE-событийный тип `skills` + новое API модуля скиллов `onChange`)
**Связанные:** AGENTS.md правила 2, 3, 5, 6, 7; `docs/design/ui/STYLE.md`

---

## 1. Проблема

Веб-UI не показывает, какие скиллы агент подключил в системный промпт: есть только
страница Settings → Skills с флагом loaded/available. Индикация нужна прямо в
композере, live — при подключении скилла агентом mid-turn.

Также `@`-упоминание файла в поле ввода подсвечивается только фоновой заливкой
(`--accent-bg`); нужна дополнительная акцентная метка (подчёркивание).

## 2. Цели / не-цели

- Показать в композере `mma web` иконку (Lucide `biceps-flexed`) + счётчик
  загруженных скиллов, скрытую при 0 и появляющуюся при ≥1.
- Тултип на hover: «загруженные скиллы» + список `имя · источник`
  (builtin/global/project), с честной оговоркой, что скилл вступает в промпт
  со следующего хода.
- Live-обновление через SSE-событие, эмитимое модулем скиллов.
- Акцентное подчёркивание у `@`-упоминания, сохраняя существующую заливку.
- НЕ переносим состояние в per-session (модуль синглтон на процесс — это
  существующая архитектура; индикатор честно отражает процессный набор).

## 3. Фича A — индикатор загруженных скиллов

### 3.1 Бэкенд: событие «skills»

**Единственный источник истины** — `SkillsModule.loadedSkills` (процессный синглтон).

`src/modules/skills/module.ts`:
- Добавить `onChange(cb: () => void): () => void` (подписка на изменение
  загруженного набора) и `notifyChanged()` (fail-open на сбой подписчика).
- Вызывать `notifyChanged()` после успешного `tryLoad`, после `unload`,
  и в конце `reload` (который может выгрузить пропавшие скиллы).
- В `reload()` notify вызывается изнутри `unload()` + один раз в конце при
  изменении набора.

Чтобы `module.ts` (289 строк) не превысил 300 (gate `file-size.test.ts`),
вынести `getLoadedBlock()` в `src/modules/skills/prompt-blocks.ts` как
`buildLoadedBlock(loaded: SkillMeta[])` — тонкая делегация. Также
`getPromptBlocks`/`getSystemPromptBlock` остаются в module.ts (короткие).

`src/modules/skills/loaded-events.ts` (новый, ~30 строк) — класс `LoadedEvents`
(subscribe/notify с fail-open-сбоем подписчика, по образцу `RenameHub.deliver`
в `session/manager-state.ts`).

`src/modules/skills/loaded-events.ts` экспортирует `LoadedEvents` и
`LoadedSkillRef = { name, kind }`.

`src/modules/webui/state-contracts.ts`: расширить `WebSkillsModule`:
```ts
export interface WebSkillsModule {
  getAvailable(): WebSkillInfo[];
  getLoaded(): WebSkillInfo[];
  /** Подписка на изменение загруженного набора (SSE-индикатор). */
  onChange?(cb: () => void): () => void;
  reloadSources?(): { added: number; removed: number };
}
```
Структурная совместимость: `SkillsModule.onChange(cb: () => void)` совпадает
по сигнатуре. ✓

`src/modules/webui/skills-events.ts` (новый, ~40 строк):
```ts
export function skillsEventPayload(skills: WebSkillsModule): { type: "skills"; ts: number; skills: { name: string; kind: string }[] }
export function installSkillsEvents(state: SseTransport, skills?: WebSkillsModule): () => void
```
- `skillsEventPayload`: строит безопасный вид (только `name` + `kind`) —
  тело скила и абсолютный путь наружу не уходят.
- `installSkillsEvents`: подписывается на `skills.onChange`, шлёт SSE `skills`.
  Возвращает отписку. Если `subscribe` нет — no-op.

`src/modules/webui/module.ts`: после `state.skills = deps.skills` вызвать
`const detachSkills = installSkillsEvents(state, deps.skills);` и
`detachSkills()` в `stop()`.

`src/modules/webui/server.ts`: в `handleEvents`, после greeting `event: state`,
записать `event: skills` со снимком текущего набора (чтобы свежая вкладка
знала текущее состояние). guarded by `s.skills`.

### 3.2 Фронтенд

`src/modules/webui/assets/index.html`: в `.composer-main` (после `.inp-wrap`,
перед `.pause-btn`) добавить:
```html
<button class="skills-btn" id="skillsBtn" type="button" hidden aria-label="Loaded skills">
  <span class="skills-badge"></span>
</button>
```

`src/modules/webui/assets/js/icons.ts`: добавить Lucide `biceps-flexed` (точные
пути из lucide-static 1.72.0).

`src/modules/webui/assets/js/session/skills-indicator.ts` (новый, ≤200 строк):
- локальное состояние `loaded: {name, kind}[]`;
- при импорте: `const host = document.getElementById("skillsBtn")` →
  `host.replaceChildren(icon("biceps-flexed"), el("span","skills-badge",""))`,
  `attachTooltip(host, buildTooltip)`, `host.addEventListener("click", () => hooks.openSettingsAt?.("skills"))`;
- `applySkillsEvent(d)` — парсит `d.skills`, обновляет state, рендерит;
- `render()` — toggle `hidden`, бейдж счётчика, aria-label;
- `refreshSkillsIndicatorI18n()` — re-apply aria-label на смену локали.

`src/modules/webui/assets/js/sse.ts`: `es.addEventListener("skills", (e) => { const d = parse(e); if (d) applySkillsEvent(d); })` (прямой импорт, как `loadModels` — app.ts на потолке 300 строк).

`src/modules/webui/assets/styles.css`: `.skills-btn`, `.skills-badge`, tooltip-ряды
(`.skills-tip` / `.skills-row`).

`src/modules/webui/assets/app-i18n.ts`: вызов `refreshSkillsIndicatorI18n()`.

i18n `src/i18n/en.json` + `ru.json` (симметрия обязательна):
- `web.composer.skills_title` = "Loaded skills" / "Загруженные скилы"
- `web.composer.skills_aria` = "Loaded skills: {count}" / "Загружено скилов: {count}"
- `web.composer.skill_kind_builtin` = "built-in" / "встроенный"
- `web.composer.skill_kind_global` = "global" / "глобальный"
- `web.composer.skill_kind_project` = "project" / "проект"

### 3.3 Тултип

Hover → `attachTooltip` (shared `.ctip` node, positioned above, flips below) with
a `.qtip` fragment: header row "Загруженные скилы · N" + rows "name  [kind]".

Примечание: скилл вступает в промпт со следующего хода — добавить строку-
примечание в тултипе: "вступит в промпт со следующего хода".

### 3.4 Тесты

- `tests/modules/skills/loaded-events.test.ts` — subscribe fires on load/unload; not on failed load; unsubscribe works; throwing subscriber doesn't break loading.
- `tests/webui-skills-indicator-dom.test.ts` (happy-dom) — hidden at 0; applySkillsEvent with 2 → visible, badge "2", tooltip rows names+kinds; empty list → hidden.
- `tests/webui-skills-forward.test.ts` — installSkillsForwarding broadcasts `skills` event with `{name, kind}` only, no `content`/`sourcePath`.
- i18n parity test (существующий) — en/ru симметрия новых ключей.

## 4. Фича B — акцент для `@`-упоминаний

CSS-only в styles.css:

```css
.inp-mark .mmark {
  color: transparent;
  background: var(--accent-bg);
  border-radius: 3px;
  text-decoration: underline;
  text-decoration-color: var(--accent);
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}
```

`text-decoration-color` независим от `color: transparent`, поэтому
подчёркивание в акцентном цвете рисуется слоем зеркала (z-index 0) и
показывается сквозь прозрачный фон textarea ровно на позиции базовой линии.
Текст остаётся цветом textarea (`--fg`); заливка сохраняется («подчёркивание
+ заливка»).

Ограничение (честность): зеркало размечает любой `@token`, похожий на путь
(regex `/@[^\s@]+/` + проверка на `.`/`/`/`\`) — включая вручную набранный
`@foo/bar`, не только файлы из автокомплита. Акцент применяется к тому же
набору, что и существующая заливка (одно правило «@path-подобный токен =
ссылка на файл»). Альтернатива — трекать принятые пути per-tab — требует
нового состояния и отложена.

Тест: `tests/webui-mention-accent.test.ts` — статический CSS-гвард:
`.inp-mark .mmark` содержит `text-decoration-color: var(--accent)` и
сохраняет `background: var(--accent-bg)`.

## 5. Файлы и волны

Per AGENTS rule 3 (одна задача — одна ветка, один контракт; массовая правка
«заодно» недопустима), предлагаю две волны/ветки от `v0_25_5`:

- **Wave 1 — `feat/webui-mention-accent`**: CSS + guard test. 2 файла, не
  меняет контракты. Идёт первой (маленькая, самодостаточная).
- **Wave 2 — `feat/webui-skills-indicator`**: спека, бэкенд-событие, индикатор,
  i18n, тесты. Основная работа.

Обе ветки идут в `dev` отдельно. Если предпочитаешь одну ветку — сделаю двумя
коммитами на `feat/webui-skills-indicator`.

## 6. Spec + tests + changelog

- Spec (AGENTS rule 2 — изменение контракта → спека):
  `docs/specs/2026-11-11-webui-skills-indicator-design.md`.
- CHANGELOG: entries в Unreleased (Added/Changed).
- Гварды: loaded-events unit test, webui forward unit test, DOM test для
  индикатора, CSS-гвард для акцента.

## 7. Открытые решения (решены в дизайне)

1. **Ветки:** две волны (Wave 1 + Wave 2). Если хочешь — одна ветка двумя коммитами.
2. **Акцент @-упоминаний:** применяется к любому path-подобному `@token` (как
   сейчас делает заливка) — консистентно. Альтернатива (per-tab трекинг
   accepted paths) — отложена.
3. **Индикатор — клик:** кнопка кликабельна (клик → Настройки → Скилы через
   `hooks.openSettingsAt("skills")`), тултип открывается по hover и фокусу.

## 8. Риски

- `src/modules/skills/module.ts` (289 строк) у потолка 300: вынесение
  `getLoadedBlock` в `prompt-blocks.ts` (~18 строк) — необходимый шаг,
  оправданный правилом 6.
- `src/modules/webui/server.ts` (287 строк): добавление greeting-записи skills —
  +2-3 строки, под потолком.
- `src/modules/webui/assets/app.ts` (299 строк): не трогаем — SSE-обработчик
  импортирует indicator напрямую (как `loadModels`), без роста app.ts.
- SSE не фильтруется egress-фильтром (в отличие от REST /api/skills) →
  пэйлоад `skills` содержит только `{name, kind}` — тело скила и абсолютный
  путь наружу не уходят.
- Global vs per-session: набор загруженных скиллов — процессный (синглтон
  SkillsModule); индикатор показывает его одинаково во всех вкладках. Это
  честно: именно этот набор попал в системный промпт.
- Multi-line mention underline: `text-decoration` рисуется per-line-fragment
  (лучше чем `border-bottom`, который рисуется только на последней строке).
  Зеркало реплицирует метрики textarea (тот же padding/font/line-height) —
  позиция выверена существующей заливкой-пилюлей.
- Lucide `biceps-flexed` существует в lucide-static 1.72.0 (проверено
  unpkg-фетчем).
- i18n: новые ключи добавляются в en.json и ru.json симметрично
  (gate `tests/i18n.test.ts`).
- File-size gate: все новые .ts файлы ≤300 строк.
- Frontend graph guard: новый модуль `session/skills-indicator.ts` импортирует
  только `dom.js`, `i18n.js`, `store.js` — без циклов.
- Webui boundaries guard: новый `skills-events.ts` зависит от narrow-ролей
  (`SseTransport`, `WebSkillsModule`), не от `WebUiState`.

## 9. Реализация (порядок)

1. Ветка `feat/webui-skills-indicator` уже создана от `v0_25_5`.
2. Написать спеку (этот файл) + CHANGELOG entry.
3. Wave 1 (mention accent): CSS + guard test. Запустить `bun run quality`.
4. Wave 2 (skills indicator):
   a. Бэкенд: loaded-events.ts, prompt-blocks.ts split, SkillsModule.onChange,
      WebSkillsModule contract, skills-events.ts, module.ts wiring, server.ts greeting.
   b. Фронтенд: icons.ts, index.html, styles.css, skills-indicator.ts, sse.ts.
   c. i18n en/ru.
   d. Тесты.
   e. `bun test`, `bun run quality`.
5. Commit + merge в dev (per AGENTS rule 3: интеграция задачи — merge в dev).

## 10. Открытые решения (нужны ответы перед спекой)

1. Ветки: две (skills indicator + mention accent) или одна с двумя коммитами?
2. Акцент @: применять к любому path-подобному `@token` (как заливка) или
   только к реально добавленным файлам (per-tab трекинг accepted paths)?
3. Клик по индикатору: открывать Настройки → Скилы, или неактивный элемент?

Рекомендации: (1) одна ветка двумя коммитами — проще для ревью; (2) первое
(консистентно с существующей подсветкой); (3) кликабельная (дает элементу цель
и путь клавиатурным пользователям).
