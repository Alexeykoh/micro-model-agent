# Документация MMA

Три вопроса, на которые отвечает эта страница: **что читать**, **что нормативно** и
**где искать историю**.

## С чего начать

| Кому                      | Документ                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Впервые видит проект      | [README.md](../README.md) → [install.md](./install.md)                                                                      |
| Хочет контрибьютить       | [ONBOARDING.md](../ONBOARDING.md) → [CONTRIBUTING.md](../CONTRIBUTING.md)                                                   |
| Работает с агентом/кодом  | [AGENTS.md](../AGENTS.md) — правила, инварианты, карта кода                                                                 |
| Меняет архитектуру        | [architecture v2](./specs/2026-10-12-architecture-v2-design.md) + [схемы](./specs/2026-10-12-architecture-v2-schematics.md) |
| Разбирается с API сервиса | [service-api.md](./agents/service-api.md) → [serve mode](./serve-mode.md)                                                   |
| Поднимает демон/тонкий клиент | [monolith split](./specs/2026-11-10-monolith-split-design.md) → [service-api.md](./agents/service-api.md)                     |
| Хочет понять enterprise   | [MMA Enterprise: идея](./ideas/2026-11-05-mma-enterprise.md) → [отдельная версия](./ideas/2026-11-09-mma-enterprise-separate-version.md) |
| Проверяет стиль вывода    | [STYLE.md](./design/ui/STYLE.md)                                                                                            |

## Карта разделов

| Раздел                                                     | Что внутри                                                              | Статус    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | --------- |
| [`specs/`](./specs)                                        | Контракты: архитектура, enforcement, провайдеры, тулы, web, service     | **Живое** |
| [`ideas/`](./ideas)                                        | Идеи и картины продукта без нормативных контрактов                      | Черновик  |
| [`archive/specs/`](./archive/specs)                        | Завершённые спеки, сгруппированные по году                              | История   |
| [`plans/`](./plans)                                        | Планы активных работ                                                    | Рабочее   |
| [`archive/plans/`](./archive/plans)                        | Закрытые планы и планы из старых воркфлоу                               | История   |
| [`agents/`](./agents)                                      | Описание текущего состояния подсистем                                   | **Живое** |
| [`agents/architecture.md`](./agents/architecture.md)       | Текущее устройство: Output, Host-seam, Security, контракт `LLMProvider` | **Живое** |
| [`agents/gates.md`](./agents/gates.md)                     | Инвариант → гейт, ворота CI                                             | **Живое** |
| [`agents/debt.md`](./agents/debt.md)                       | Реестр долгов (pay-once)                                                | **Живое** |
| [`agents/feature-history.md`](./agents/feature-history.md) | Как реализовывались фичи                                                | История   |
| [`analysis/`](./analysis)                                  | Аудиты и разовые исследования                                           | История   |
| [`design/ui/`](./design/ui)                                | Стиль чата и макеты                                                     | **Живое** |
| [`testing/`](./testing)                                    | Ручные сценарии и наблюдения                                            | **Живое** |

## Правило для спек

1. Спека пишется **до кода**, если меняется контракт: путь данных, граница модуля,
   точка enforcement, формат события, схема конфига. Файл:
   `docs/specs/<YYYY-MM-DD>-<тема>-design.md`.
2. Пока спека описывает живой контракт — она лежит в `docs/specs/`.
3. Когда контракт заменён или фича закрыта — спека переезжает в
   `docs/archive/specs/<год>/`. Ссылки обновляются, файл не удаляется: на него
   ссылаются `debt.md`, `feature-history.md` и релизные заметки.
4. Планы (`docs/plans/`) — рабочий артефакт, а не контракт. После закрытия задачи
   план уезжает в `docs/archive/plans/<год>/`.

Нормативный список живых спек — в [specs/README.md](./specs/README.md).

## Проверка ссылок

Ссылки в Markdown проверяются тестом
[`tests/docs-link-check.test.ts`](../tests/docs-link-check.test.ts). Он входит в
`bun test`, поэтому битая ссылка после переноса файла не переживёт CI.

## Архив

Структура и правила — в [archive/README.md](./archive/README.md).
