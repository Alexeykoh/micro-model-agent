# План очистки документации MMA

**Goal:** убрать дублирование и устаревшие документы, включая полное удаление `docs/archive/`, не ломая при этом живые контракты и гейт ссылок.

**Дата:** 2026-11-25. **Ветка:** отдельная от `dev` на каждую волну; в `dev` — только зелёные слияния.

**Принцип:** отобранные файлы **удаляются**, а не переносятся в архив. Архив удаляется целиком волной 4.

---

## Решения пользователя и цена удаления архива

Принято 2026-11-25:

1. Удалить `.diagnostics/` и root-scratch.
2. Отобранные устаревшие документы удалять, а не архивировать.
3. Удалить `2026-10-23-knowledge-turn-guidance-design.md`.
4. План записать в репозиторий.
5. **Удалить весь `docs/archive/`** — пользователь подтвердил после того, как названа цена.

Цена (замер по отслеживаемым файлам):

| Что задевает | Количество |
|---|---|
| Markdown-ссылок `\[...\](.../archive/...)` в живых документах | **62** (21 — `feature-history.md`, 6 — `analysis/…harness-module-audit.md`, 3 — `modules.md`, 2 — `TODO.md`) |
| Текстовых путей `docs/archive/...`, включая якоря «Спека: …» в `debt.md` | **124** |
| Упоминаний архива в `CHANGELOG.md` | **31** (почти все в backticks — гейтом не ловятся; **без явной команды CHANGELOG не редактируется**) |
| Отслеживаемых файлов в `docs/archive/` | **139** (~2,7 МБ) |

Также меняются правила: `tests/docs-link-check.test.ts:8` прямо объявляет гейт переноса в архив; `docs/archive/README.md:18` прямо гласит «файл не удаляется»; `docs/README.md:25–28,46,49,61`, `docs/specs/README.md:4`, `TODO.md` описывают архив как раздел. Git сохраняет байты, но не навигацию — ссылки из `debt.md` и `feature-history.md` должны быть явно сняты или заменены адресом в git.

---

## Инвентарь

| Категория | Файлов | Действие |
|---|---|---|
| `docs/archive/**` | 139 | удалить целиком (волна 4) |
| `docs/specs/**` | 96 | удалить `0.25.2/` (3) и `knowledge-turn-guidance` (1), обновить статусы |
| `docs/plans/**` | 27 | удалить ~16 закрытых, перераспределить 5 отчётов/анализов |
| `docs/agents/**` | 17 | точечно: `feature-history.md`, `versioning.md`, `architecture.md` |
| `docs/superpowers/**` | 2 | удалить |
| Root `docs/**` | 8 | точечно: `mma-features-overview.md` (версия), `install.md` как источник команд |
| `gh-pages/docs.html` | 1 | убрать дубли команд, оставить публичный гайд |

---

## Волны

DoD каждой волны: `bun test tests/docs-link-check.test.ts` зелёный; `bun run quality` зелёный; `git diff` содержит только ожидаемые удаления и правки ссылок; иначе — откат волны целиком.

### Волна 0. Разблокировать гейт — выполнено 2026-11-25

- [x] `.diagnostics/` и root-scratch удалены пользователем; в `git status` их нет.
- [x] `.diagnostics` не добавлен в `SKIP_DIRS`, проверка `/api` не ослаблена.
- [x] `bun test tests/docs-link-check.test.ts` → 1 pass, 0 fail.
- [x] Рабочее дерево чистое (кроме самого плана); незакоммиченных правок тулов/тестов больше нет.

### Волна 1. Закрытые планы и снимки — удалить. Выполнено 2026-11-25

- [x] Удалены 16 закрытых планов из `docs/plans/` (11 с шапкой «исполнено 2026-10-20», плюс `plugin-draft-quality`, `corporate-data-policy-plan`, `web-setup-rework`, `split-bloated-files-progress`, `architecture-v2-handoff`).
- [x] Входящие ссылки переписаны в 17 файлах; в `AGENTS.md` и `docs/specs/README.md` пометки «удалён» убраны полностью. Гейт `tests/docs-link-check.test.ts` зелёный.
- [x] `2026-10-27-mma-web-stress-report.md` и `2026-10-27-mma-web-bug-register.md` → `docs/archive/reports/`; три `*-analysis.md` → `docs/analysis/` с переписыванием путей.
- [x] Удалены снимки `settings-inventory-v0_26_0.md` и `ui-controls-behavior-v0_26_0.md`.
- [x] Удалена папка `docs/specs/0.25.2/` и раздел «Папки версий» из `docs/specs/README.md`.
- [x] Удалены два закрытых файла `docs/superpowers/` (`2026-11-19-settings-ia-gaps-plan`, `2026-11-20-agent-control-precision-design`). **Отклонение от плана:** новые активные файлы `2026-11-25-compact-composer-*` от 2026-11-25 оставлены — они не устарели.
- [x] Удалён `docs/specs/2026-10-23-knowledge-turn-guidance-design.md`; ссылка в `2026-10-31-live-data-grounding-guidance-design.md` переписана.
- [x] `bun run quality` зелёный (линтер даёт только уже существующие warnings).

### Волна 2. Конфликтующие контракты. Выполнено 2026-11-25

- [x] Model Certification: канонический источник — `docs/agents/testing.md`; секция в `docs/agents/architecture.md` заменена ссылкой. Теги выровнены по коду (`src/modules/certification/types.ts`: `shell`, `research`; `moe` удалён).
- [x] `docs/agents/feature-history.md`: удалён хвост `Current Version / Changelog / Versioning Rules` (50 строк), заменён ссылкой на `versioning.md`.
- [x] `docs/mma-features-overview.md`: версия `0.10.x` → `0.26.1`.
- [x] `docs/agents/versioning.md`: удалена вторая пара записей 29/30.
- [x] Гейт `tests/docs-consistency.test.ts`: проверяет единственность списка тегов и отсутствие старых версий в живых доках (падал бы до правки).
- [ ] **Отложено в волну 5:** `gh-pages/docs.html` — дубли команд установки. Удалять команды из публичной страницы сразу нельзя (потеря копируемых инструкций); правильное решение — генерация страницы из `docs/install.md`.

### Волна 3. Индексы и статусы. Выполнено 2026-11-25

- [x] `docs/specs/README.md`: добавлены 8 спек от 2026-11-20…11-24 (в ранее отсутствовавших датах 11-19 файлов нет); пункт про `0.25.2` убран в волне 1.
- [x] Обновлены маркеры статуса у 7 спек (4 × 11-01 «реализуется», `agent-service-api`, `corporate-data-policy`, `webui-sidebar-tabs`) на «реализовано». Спеки с реально открытыми работами (`monolith-split`, `enterprise-auth`, `observability-gaps`) не тронуты.
- [x] Починены 11 `.ts`-путей в живых описаниях (`src/modules/context/manager.ts` → `src/core/context/manager.ts`, `tests/agent.test.ts` → `tests/core/agent.test.ts`, webui `file-api`/`forward` и др.). Гейт расширен на текстовые `.ts`-пути только для 8 живых файлов; `feature-history.md` (история удалённого) и спеки (планируемые тесты) исключены — всего 80 уникальных несуществующих путей, больше половины из них осознанно исторические/плановые.
- [x]Осиротевшие `docs/analysis/*` получили вход с карты документации: новый раздел «Разовые аудиты» в `docs/README.md` (7 ссылок). Отклонение от плана: ссылки даны из хаба, а не из `feature-history.md` — так все семь файлов стали доступны, а не 2–3.

### Волна 4. Удаление всего архива. Выполнено 2026-11-25

Чекпоинт перед выполнением пройден на основе ранее данного пользователем согласия: список 62 markdown-ссылок и 124 текстовых путей был показан в плане и в чате.

- [x] Входящие ссылки переписаны в 18 файлах; все упоминания архива в отслеживаемых `.md` получили пометку «удалён 2026-11-25». Неотмечённых осталось 0 (кроме `CHANGELOG.md` и самого плана).
- [x] `docs/agents/feature-history.md`, `docs/analysis/*`, `docs/agents/modules.md`, живые спеки — ссылки заменены пометкой об удалении; `debt.md` — 5 якорей «Спека:…» помечены как удалённые (долг и гвард сохранены).
- [x] Обновлены `docs/README.md` (убраны строки архива, правило «файл не удаляется», раздел «Архив»), `docs/specs/README.md`, `CONTRIBUTING.md`, `TODO.md`.
- [x] Комментарий `tests/docs-link-check.test.ts` переписан под удаление; проверка текстовых путей `docs/(specs|plans)/**` и `.ts`-путей живых описаний сохранена.
- [x] `git rm -r docs/archive/` — 139 файлов, включая `archive/README.md`.
- [x] `bun test tests/docs-link-check.test.ts` зелёный после удаления; `bun test` — 7251 pass / 18 skip / 1 fail; `bun run quality` — 218 pass / 1 fail. Единственное падение — **`tests/arch/debt-register.test.ts`**: запись `answer-truncated-on-audit-fail` в `debt.md` не имеет `DEBT(id)`-якоря в коде. Проверено на `dev`: запись и отсутствие якоря там же, то есть падение **предшествует этой ветке** и правками документации не вызвано. В этой волне не чинится (нужна отдельная правка кода или решение по долгу).
- [x] `CHANGELOG.md` не тронут: 31 упоминание в backticks гейт не ломает; правка требует отдельной явной команды.

### Волна 5 (отдельная задача)

Генератор документационного сайта из Markdown (VitePress + TypeDoc) — устраняет дублирование `install.md` ↔ `docs.html` структурно. Не смешивать с удалениями.

---

## Не трогать

- `AGENTS.md`, `docs/README.md`, `docs/agents/{architecture,gates,debt,feature-history}.md` — только точечные правки ссылок по волнам 2–4.
- `docs/design/ui/STYLE.md`, `docs/testing/**`, архитектуру v2 + схемы, W1/W2/W3, `remove-moe` (INV-1…23), `monolith-split`, активные планы `2026-11-20-web-model-capabilities`, `2026-11-23-research-loop-efficiency`, `2026-11-24-file-rollback`.
- `CHANGELOG.md` — без явной команды.
- Несохранённые правки пользователя в рабочем дереве.
