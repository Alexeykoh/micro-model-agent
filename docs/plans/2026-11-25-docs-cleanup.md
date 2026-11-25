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

### Волна 3. Индексы и статусы

- [ ] `docs/specs/README.md`: добавить 15 спек от 2026-11-19…11-24 в список активных; убрать пункт про `0.25.2`.
- [ ] Обновить маркеры статуса у 6–7 спек (`2026-11-01-approve-token-design`, `…-document-source-bytes-design`, `…-lsp-pool-recovery-design`, `…-compaction-history-capacity-design`, `2026-10-08-agent-service-api-design`, `2026-10-19-corporate-data-policy-design`, `2026-09-30-webui-sidebar-tabs-design`) на «реализовано».
- [ ] Починить 74 ссылки на несуществующие `.ts`-пути в живых доках; расширить `docs-link-check` на текстовые `.ts`-пути только для `docs/agents/**` и `docs/specs/**`.
- [ ] Добавить 2–3 входящие ссылки на осиротевшие `docs/analysis/*` из `feature-history.md`.

### Волна 4. Удаление всего архива

Отдельная волна после 0–3; перед выполнением — чекпоинт: показать пользователю сгенерированный список ссылок и подтвердить ещё раз.

- [ ] Сгенерировать полный список входящих ссылок: 62 markdown + 124 текстовых пути (скрипт в `%TEMP%`, не в репозитории).
- [ ] `docs/agents/feature-history.md` (21 ссылка), `docs/analysis/*` (6), `docs/agents/modules.md` (3), `TODO.md` (2), живые спеки — заменить ссылки пометкой «было в архиве, доступно в git: `git log --all -- <путь>`» или удалить абзац.
- [ ] `docs/agents/debt.md` — снять все якоря «Спека: docs/archive/...»; долг остаётся с описанием и гвардом, но без адреса спецификации.
- [ ] Обновить `docs/README.md` (убрать строки про архив и правило «файл не удаляется»), `docs/specs/README.md`, `TODO.md`.
- [ ] Изменить или снять гейт `tests/docs-link-check.test.ts`: комментарий и назначение привязаны к архиву; после удаления проверка текстовых путей `docs/(specs|plans)/**` остаётся, проверка архивных путей уходит.
- [ ] `git rm -r docs/archive/` (139 файлов, включая `archive/README.md`).
- [ ] `bun test` + `bun run quality`; в живых документах не осталось ссылок на несуществующий архив.
- [ ] `CHANGELOG.md` не трогать: 31 упоминание в backticks не ломает гейт, правка требует отдельной явной команды.

### Волна 5 (отдельная задача)

Генератор документационного сайта из Markdown (VitePress + TypeDoc) — устраняет дублирование `install.md` ↔ `docs.html` структурно. Не смешивать с удалениями.

---

## Не трогать

- `AGENTS.md`, `docs/README.md`, `docs/agents/{architecture,gates,debt,feature-history}.md` — только точечные правки ссылок по волнам 2–4.
- `docs/design/ui/STYLE.md`, `docs/testing/**`, архитектуру v2 + схемы, W1/W2/W3, `remove-moe` (INV-1…23), `monolith-split`, активные планы `2026-11-20-web-model-capabilities`, `2026-11-23-research-loop-efficiency`, `2026-11-24-file-rollback`.
- `CHANGELOG.md` — без явной команды.
- Несохранённые правки пользователя в рабочем дереве.
