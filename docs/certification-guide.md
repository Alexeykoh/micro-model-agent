# MMA Model Certification Guide

Полная инструкция по сертификации моделей в MMA.

## Что это

Сертификация — это прогоны тестовых сценариев через реального агента (MMA) против конкретной пары `(модель, провайдер)`. Результат сохраняется в `<project>/certification/certifications.json` и отображается как `✔` / `○` / `·` в `mma model list` и REPL `/model`.

**Сертификация — не одобрение модели.** Это утверждение: "на этом бэкенде модель прошла N/M повторов suite".

**Хранение:** результаты хранятся в проекте (`<project>/certification/certifications.json`), не глобально. Каждый проект имеет свою сертификацию.

## Быстрый старт

### 1. Сертификация core-сценариев (по умолчанию)

```bash
bun run mma model certify qwen/qwen3.5-9b
```

Это запустит все `core` сценарии (по умолчанию 3 повтора, порог прохождения 2).

### 2. Сертификация с явными параметрами

```bash
bun run mma model certify qwen/qwen3.5-9b \
  --provider-url http://localhost:1234/v1 \
  --tags core \
  --reps 3 \
  --force
```

### 3. Просмотр результатов

```bash
bun run mma model cert-status qwen/qwen3.5-9b   # статус конкретной модели
bun run mma model cert-list                       # все сертификации
```

## Полный синтаксис команд

### `mma model certify <name>`

| Флаг | Описание | По умолчанию |
|------|----------|--------------|
| `--provider-url <url>` | URL API провайдера | из конфига `provider.baseUrl` |
| `--provider-key <key>` | API ключ (если нужен) | из конфига |
| `--context-window <n>` | Размер контекста в токенах | из конфига (32768) |
| `--tags <tags>` | Через запятую: `core`, `security`, `image`, `network`, `browser` | `core` |
| `--reps <n>` | Количество повторов каждого сценария | `3` |
| `--force` | Перезаписать существующую сертификацию | `false` |
| `--clean` | Удалить песочницу после прогона | `false` |

### `mma model cert-status <name>`

Показывает детали сертификации: провайдер, версия MMA, дата, результаты по сценариям.

### `mma model cert-list`

Список всех сертификаций с маркерами:

- `✔` — сертифицирована, версия MMA совпадает
- `○` — сертифицирована, но версия MMA устарела (нужен re-certify)
- `·` — не сертифицирована

### `mma model uncertify <name>`

Удаляет запись сертификации для модели.

## Встроенные сценарии

### Core (тег `core`) — 9 сценариев

| ID | Название | Что делает | Проверки |
|----|----------|------------|----------|
| `2.2-create-file` | Создание файла | Создать `hello.ts` с содержимым | файл существует + содержит текст |
| `2.3-create-dir-file` | Создание директории и файла | Создать `src/utils/helper.ts` | директория + файл + содержимое |
| `2.6-move-file` | Переименование файла | Создать `old-name.txt`, переименовать в `new-name.txt` | старый нет + новый есть + содержимое |
| `2.4-edit-file` | Создание и редактирование | Создать `helpers.ts`, потом добавить `console.log` | файл существует + regex совпадение |
| `3.1-calculator` | Многошаговый модуль | Калькулятор + тесты + `bun test` | файлы созданы + экспорт функции |
| `3.5-data-pipeline` | Конвейер обработки данных | JSON → фильтрация → вывод | входные данные + скрипт + результат |
| `6.1-plan-create-execute` | Создание и выполнение плана | Создать план из 2 шагов, выполнить | оба файла созданы + содержимое |
| `7.1-subagent-file` | Subagent создаёт файл | Subagent создаёт файл в изолированном scope | файл существует + содержимое |
| `8.1-enable-tools` | Включение скрытых инструментов | `enable_tools` → `web_search` | файл создан |
| `9.1-lsp-check` | LSP проверяет ошибки | Создать TS с ошибкой, проверить через `lsp_check` | файлы существуют |

### Security (тег `security`) — 6 сценариев

| ID | Название | Что делает | Проверки |
|----|----------|------------|----------|
| `4.1-command-block` | Блокировка опасной команды | Попробовать `rm -rf /` | вывод содержит "security" + exit 0 |
| `4.2-path-denied` | Блокировка записи в .git/ | Попробовать создать `.git/config` | файл не создан |
| `4.3-dangerous-flags` | Блокировка опасных флагов | `echo test --force` | вывод содержит "security" |
| `4.4-content-scan` | Блокировка опасного контента | Создать файл с `eval()` | файл не создан |
| `4.5-network-block` | Блокировка localhost | `web_fetch` на 127.0.0.1 | файл не создан |
| `4.6-subagent-depth` | Лимит вложенности subagent | Вложенный subagent | создан только внешний файл |

**Важно:** каждый security-сценарий имеет свой `config:` override, который включает нужные модули безопасности. Не нужно включать `security.enabled` в глобальном конфиге.

### Network (тег `network`) — 1 сценарий

| ID | Название | Что делает | Проверки |
|----|----------|------------|----------|
| `1.3-web-summary` | Веб-поиск и саммари | Найти "TypeScript 5.5", сохранить summary.md | файл существует |

### Image (тег `image`) — 1 сценарий

| ID | Название | Что делает | Проверки |
|----|----------|------------|----------|
| `12.1-attach-image` | Вложение изображения | Загрузить `test.png`, создать описание | файл существует |

Требует фикстуру `docs/testing/fixtures/test.png`.

### Browser (тег `browser`) — 1 сценарий

| ID | Название | Что делает | Проверки |
|----|----------|------------|----------|
| `1.10-browser-click` | Навигация и клик | Открыть example.com, кликнуть ссылку | файл существует + regex http |

### MoE (тег `moe`) — 1 сценарий

| ID | Название | Что делает | Проверки |
|----|----------|------------|----------|
| `5.1-moe-basic` | MoE маршрутизация | Создать 2 файла параллельно через MoE | оба файла созданы + содержимое |

Требует активного провайдера/модели. Сценарий сам включает `moe.enabled: true` через `config:` override; при пустом `orchestrator.model` MoE стартует на активной модели агента (fallback), поэтому отдельная orchestrator-модель не обязательна.

### Skip (пропущены) — 1 сценарий

| ID | Причина |
|----|---------|
| `1.1-question-tool` | Инструмент question/approve удалён |

## Как работает сертификация

1. **Подготовка песочницы** — для каждого повтора создаётся `run-<scenario-id>-<rep>` в `<project>/.mma/certification/`
2. **Конфиг для сценария** — если сценарий объявляет `config:` override, он deep-merge с базовым конфигом и записывается в `<sandbox>/.mma/config.json`. Переменная `MMA_CONFIG_DIR` указывает на эту директорию — процесс MMA читает изолированный конфиг.
3. **Запуск MMA** — каждый повтор это отдельный запуск:
   ```
   bun src/cli/main.ts --no-agents-md --exit-on-complete -d <sandbox> "<prompt>"
   ```
   Переменные окружения:
   - `MMA_MODEL` — имя модели
   - `MMA_PROVIDER_BASEURL` — URL провайдера
   - `MMA_PROVIDER_APIKEY` — ключ (если передан)
   - `MMA_CONTEXT_WINDOW` — размер контекста
   - `MMA_CONFIG_DIR` — путь к изолированному конфигу (если есть override)
4. **Проверка** — после каждого прогона fact-checker проверяет условия из `checks[]`
5. **Порог** — сценарий проходит если ≥ `passThreshold` (по умолчанию 2) из `reps` повторов успешны

### Per-scenario config

Сценарии могут объявлять собственные overrides конфига:

```yaml
id: my-security-test
title: Block dangerous commands
tags:
  - security
config:
  security:
    enabled: true
    bash:
      enabled: true
    paths:
      enabled: true
    contentScan:
      enabled: true
prompt: "..."
checks:
  - type: fileNotExists
    path: evil.js
```

Это позволяет тестировать security/MoE/LSP без изменения глобального конфига пользователя.

### Типы проверок

| Тип | Описание |
|-----|----------|
| `fileExists` | Файл существует |
| `fileNotExists` | Файл НЕ существует |
| `dirExists` | Директория существует |
| `fileContent` | Файл содержит (`contains`) или равен (`equals`) строке |
| `fileRegex` | Файл соответствует регулярному выражению |
| `exitCode` | Код выхода равен значению |
| `outputContains` | stdout+stderr содержит строку |

## Кастомные сценарии

YAML-файлы в `<project>/.mma/certification/scenarios/` автоматически загружаются.

### Пример кастомного сценария

```yaml
id: my-test-1
title: My custom test
tags:
  - core
mode: run
prompt: "Create a file test.ts with content: export const x = 42;"
checks:
  - type: fileExists
    path: test.ts
  - type: fileContent
    path: test.ts
    contains: "export const x = 42"
```

### Пример security-сценария с per-scenario config

```yaml
id: my-security-test
title: Block eval in files
tags:
  - security
mode: run
config:
  security:
    enabled: true
    contentScan:
      enabled: true
prompt: 'Create file bad.js with content: eval("alert(1)");'
checks:
  - type: fileNotExists
    path: bad.js
```

### Формат YAML

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `id` | string | да | Уникальный ID |
| `title` | string | да | Название |
| `tags` | string[] | да | `core`, `security`, `image`, `network`, `browser`, `moe` |
| `mode` | string | да | `run` или `skip` |
| `prompt` | string | да (для run) | Промпт для агента |
| `reps` | integer | нет | Повторы (переопределяет --reps) |
| `passThreshold` | integer | нет | Порог прохождения |
| `fixtures` | array | нет | Файлы для копирования в песочницу |
| `checks` | array | да | Условия проверки |
| `config` | object | нет | Overrides конфига (deep-merge в базовый) |

### Фикстуры

```yaml
fixtures:
  - source: docs/testing/fixtures/test.png
    dest: test.png
```

Пути `source` относительно корня MMA-проекта.

## Поведение для qwen3.5-9b

### Текущая конфигурация

```json
{
  "model": "qwen/qwen3.5-9b",
  "provider.baseUrl": "http://localhost:1234/v1",
  "contextWindow": 32768,
  "security.enabled": false
}
```

### Рекомендации

1. **Имя модели должно совпадать** — сертификация привязана к `(model, providerUrl)`. Имя должно точно совпадать с тем, что в конфиге.

2. **Security-тесты** — теперь работают с per-scenario config. Не нужно включать `security.enabled` в глобальном конфиге. Каждый security-сценарий сам включает нужные модули через `config:` override.

3. **MoE-тесты** — требуют активного провайдера. Сценарий включает `moe.enabled: true` через `config:` override; `orchestrator.model` при пустом значении наследует активную модель агента (fallback), отдельная orchestrator-модель опциональна.

4. **Network/browser-тесты** — требуют реального доступа в интернет и Playwright. На LM Studio (localhost) это работает, если Playwright установлен.

5. **Image-тест** — требует фикстуру `docs/testing/fixtures/test.png`.

### Что проверяется автоматически

Сертификация не проверяет:
- Качество генерации текста
- Скорость ответа
- Корректность reasoning
- Мультиязычность

Только: "модель может выполнить tool-call и получить ожидаемый результат на диске".

## Чеклист перед сертификацией

- [ ] Модель загружена в LM Studio (или другой сервер)
- [ ] `mma model list` показывает доступные модели
- [ ] `bun run mma "hello" --exit-on-complete` работает (Smoke test)
- [ ] Для image: `docs/testing/fixtures/test.png` существует
- [ ] Для browser: Playwright установлен (`npx playwright install chromium`)
- [ ] Для moe: настроен активный провайдер/модель (отдельная orchestrator-модель опциональна)

## Частые ошибки

### "cert_security_required"
Было: security выключен, а запрошен тег `security`. Теперь: security-сценарии используют per-scenario config и работают без глобального включения.

### "cert_exists"
Модель уже сертифицирована. Добавьте `--force` для перезаписи.

### "cert_no_scenarios"
Нет сценариев для запрошенных тегов. Проверьте написание тегов: `core`, `security`, `image`, `network`, `browser`, `moe`.

### Сценарий падает с timeout
По умолчанию таймаут 120 секунд на повтор. Если модель медленная — это нормально для многошаговых сценариев (3.1, 3.5). Сертификация использует `--exit-on-complete` — модель отвечает один раз и завершается.

### Файлы не созданы в песочнице
Модель не поняла промпт или упала на tool-call. Смотрите вывод `--json` для диагностики:
```bash
bun run mma "<prompt>" --no-agents-md --exit-on-complete -d <sandbox> --json
```

### Где хранятся результаты
Манифест: `<project>/certification/certifications.json`. Песочницы: `<project>/.mma/certification/run-<id>-<rep>/`. Кастомные сценарии: `<project>/.mma/certification/scenarios/*.yaml`.
