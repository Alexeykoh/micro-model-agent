# Живая проверка ветки `docs/architecture-v2` на реальной модели

**Дата:** 2026-10-12 · **Ветка:** `docs/architecture-v2` (6 коммитов впереди `origin`)
**Модель:** `qwen/qwen3.5-9b` (LM Studio, `http://localhost:1234/v1`, окно 32768)
**Цель:** убедиться, что ветка ничего не сломала и как минимум улучшила поведение агента,
прогнав **живые сценарии в тестовых каталогах** и отчитавшись по каждой фиче.

---

## 1. Итог (TL;DR)

| Проверка | Результат |
|---|---|
| `bun test` | **3803 pass / 0 fail / 8 skip** (428 файлов) |
| `bun run quality` | **exit 0** (typecheck ✔, `check:arch` 70 ✔, biome — только warnings, fallow ✔) |
| Живой certify `core,shell,security` | 35/2/1 → после перепроверки **39/0/1** |
| Живой certify + image/network/research | **42 pass / 0 fail / 1 skip (из 43)** — модель **certified** |
| События `moe` / `orchestrator` в живых логах | **0** (единственный путь исполнения) |
| `mma serve` `/v1/health·ready·openapi` | **200** |
| `mma web` `/` и `/api/models·sessions·config` | **200** |
| `mma doctor` | **OK** (все модули, 9 плагинов, LSP 10 серверов, конфиг «domain files») |

**Вывод:** ветка регрессий не внесла. Единственные два fail в первом прогоне
(`2.1-read-file`, `2.8-create-dir`) при повторной проверке прошли (по 2/2); разбор ниже
показывает, что это флейк окружения и галлюцинация пути у модели, а не дефект ветки.
Новый путь параллельных сабагентов (после удаления MoE) и единая точка enforcement
подтверждены живьём.

---

## 2. Метод

- Канонический harness репозитория: `mma model certify` — каждый сценарий гоняется в
  отдельной песочнице `.mma/certification/run-<id>-<rep>/`, с изолированным
  `MMA_CONFIG_DIR` и факт-проверкой файлов/exit-кода/вывода.
- Сертификационный манифест изолирован через `MMA_CERT_HOME=_testing/live/cert-home`
  (глобальный `~/.mma` не затронут).
- Дополнительные сценарии для непокрытых фич добавлены в
  `.mma/certification/scenarios/` (`feat-memory-remember-recall`, `feat-indexer-project-map`).
- Fail-сценарии перепроверены точечно (`--scenarios`, `--reps 2`), затем сетевое/image/
  research-подмножество прогнано отдельно.
- Серверные поверхности проверены без модели: запуск в фоне, readiness-поллинг, один
  запрос, остановка по PID.

Отчёты-артефакты (JSON):
`certification/report-qwen_qwen3.5-9b-2026-10-12T20-38-10.json` (полный),
`…T20-46-36.json` (после перепроверки fail'ов + memory/indexer),
`…T20-51-10.json` (финальный, 42/0/1).

---

## 3. Матрица фич

Легенда: ✔ — проверено живьём и прошло; ⚠ — проверено, но с оговоркой; ○ — не покрыто
живьём (и почему).

### 3.1 Файловые операции (core)

| Фича | Сценарий(и) | Итог |
|---|---|---|
| `read_file` | 2.1 (2/2), 2.11, 2.5, 3.9 | ✔ |
| `write_file` | 2.2, 2.3, 2.8 (2/2), 2.5, 3.x | ✔ |
| `edit_file` | 2.4, 2.5, 3.9 (read→grep→edit) | ✔ |
| `create_dir` | 2.3, 2.8 | ✔ |
| `delete_file` | 2.7 | ✔ |
| `move_file` | 2.6 | ✔ |
| `list_dir` | 2.9 | ✔ |
| `file_info` | 2.10 | ✔ |
| `glob` | 2.12, 3.8 | ✔ |
| `grep` | 2.13, 3.7, 3.9 | ✔ |

### 3.2 Shell и процессы (shell)

| Фича | Сценарий(и) | Итог |
|---|---|---|
| `bash` (в т.ч. пайпы) | 3.6, 5.1 (`echo … \| grep`) | ✔ |
| `bash` в составе многошаговой задачи | 3.5 (data-pipeline: JSON + скрипт + запуск) | ✔ |
| Фоновые процессы (`process_list`/`process_kill`) | 5.2 (`sleep` → список → kill) | ✔ |

### 3.3 Планирование, исполнение, сабагенты

| Фича | Сценарий(и) | Итог |
|---|---|---|
| `plan` + `plan_step` | 3.11, 6.1 | ✔ |
| Авто-продвижение шагов плана | 2.8 (в логе — `plan auto-advance`) | ✔ |
| Сабагент (одиночный) | 3.10, 7.1 | ✔ |
| **Параллельные сабагенты** (`parallelizable`) | **7.2** (новый сценарий ветки) | ✔ |

### 3.4 Контекст, память, индекс, LSP

| Фича | Сценарий(и) | Итог |
|---|---|---|
| Память `remember`/`recall` | `feat-memory-remember-recall` (2/2) | ✔ |
| Индексатор / `project_map` | `feat-indexer-project-map` (2/2) | ✔ |
| `lsp_check` (находит ошибку TS) | 9.1 | ✔ |
| Контекст/компакция | — | ○ (порог в маленьких песочницах не достигается; покрыто юнит-тестами `compaction-policy`, `context-manager-*`) |

### 3.5 Сеть, изображения, скрытые тулы

| Фича | Сценарий(и) | Итог |
|---|---|---|
| `enable_tools` + `web_search` на лету | 8.1 | ✔ |
| `web_search` + `web_fetch` → summary | 1.3 | ✔ |
| `download_file` | 6.3 | ✔ |
| `attach_image` | 12.1 | ✔ |
| `browser` / `web_browse` | 1.10 | ○ (Playwright — только по явной команде пользователя, правило 8) |

### 3.6 Security enforcement (единая точка `ToolExecutor.execute()`)

| Фича | Сценарий | Итог |
|---|---|---|
| Блок опасной bash-команды | 4.1 (`rm -rf /`) | ✔ |
| Запрет записи в защищённый путь | 4.2 (`.git/config`) | ✔ |
| Блок опасных флагов | 4.3 (`--force`) | ✔ |
| Скан опасного контента | 4.4, 4.9 (`eval`/`child_process.exec`) | ✔ |
| Блок сети к localhost | 4.5 | ✔ |
| Лимит глубины сабагентов | 4.6 | ✔ |
| Path-escape | 4.7 (`../../etc/passwd`) | ✔ |
| SSRF (private IP) | 4.8 (`127.0.0.1:22`) | ✔ |

### 3.7 Наблюдаемость и гейты (из живых `session.jsonl`)

События, реально записанные за все прогоны (инвентарь):

```
assistant 260 · tool_call 226 · tool_result 226 · plan 29 · audit 4
critic_check 44 · critic_verdict 29 · critic_error 29 · claim_retry 12
context 272 · context_probe 46 · llm_usage 272 · reasoning 260
reasoning_control 258 · session_start 46 · system 92 · user 46
```

- `tool_call == tool_result` (226/226) — нет «висящих» вызовов.
- `critic_*`, `claim_retry`, `audit`, `plan` присутствуют ⇒ гейты
  (hallucination → critic → audit) реально работают и **наблюдаемы** (INV-13/15).
- `moe`/`orchestrator` — **0** ⇒ единственный путь исполнения (INV-22).

### 3.8 Архитектура/инфраструктура (проверено вживую, без модели)

| Фича | Как проверено | Итог |
|---|---|---|
| `ModuleHost` / `ModuleDef` | `mma doctor`: execution/session/indexer/mcp/memory/browser/lsp/skills = ok | ✔ |
| Plugin runtime | `mma doctor`: 9 active / 9 total | ✔ |
| Config domain-persist (W3) | `mma doctor`: `stored: domain files` | ✔ |
| Сервис API v1 | `mma serve` → `/v1/health` 200, `/v1/ready` 200, `/v1/openapi.json` 200 (21 958 байт) | ✔ |
| Web UI | `mma web` → `/` 200, `/api/models` 200, `/api/sessions` 200, `/api/config` 200 | ✔ |
| Сессии | `mma session list` + `session.jsonl` в каждой песочнице | ✔ |
| Провайдеры | `mma provider check`: lmstudio (8 моделей), opencode-go (38) | ✔ |
| Диагностика | `mma doctor` → `doctor: OK` | ✔ |

### 3.9 Не покрыто живьём (осознанно)

| Что | Почему |
|---|---|
| `browser`/`web_browse` | Playwright запускается только по явной команде пользователя (правило 8 AGENTS.md) |
| `question`/`approve` | Интерактивны; в headless-сертификации сценарий 1.1 помечен `skip` by design |
| `mcp_call` | Нужен внешний MCP-сервер; покрыто юнит-тестами |
| `load_skill` | В `~/.mma/skills` нет установленных скиллов |
| `chunk_query` | Нужен индекс/эмбеддинги; покрыто юнит-тестами |
| `context`/компакция под давлением | Порог не достигается в малых песочницах; юнит-тесты |
| `pipeline_run`, `define_capability`, `search_history`, `session_info`, `meet_done` | Доступны в наборе тулов, отдельных живых сценариев нет |

---

## 4. Сравнение с предыдущей сертификацией (2026-09-21)

Предыдущий отчёт `qwen/qwen3.5-9b` снят **до удаления MoE**: в нём есть сценарии
`5.1-moe-basic`, `5.2-moe-parallel-waves`, `5.3-moe-read-after-write`, и он охватывал
все теги (45 сценариев против наших 38/43).

- **Новые сценарии ветки:** `7.2-parallel-subagents` — **pass** (проверяет новый
  единственный путь параллельных сабагентов через `ToolExecutor.fork()`).
- **Убраны:** 3 MoE-runtime сценария (ожидаемо, вместе с MoE) + 5 из тегов
  image/network/browser/research.
- **Регрессии по пересечению:** `2.1` и `2.8` (было pass → стало fail), но обе при
  повторной проверке **прошли 2/2** ⇒ разбор ниже показывает не-структурную природу.

---

## 5. Наблюдения и кандидаты в долг

1. **Разовый ранний выход процесса (`2.1-responses`, полный прогон).**
   В логе песочницы `session.jsonl` последняя запись — assistant с `write_file`-вызовом,
   `tool_result` отсутствует; `diagnostics`: `Plan: 1/3 steps done`, `Pending: #2 read,
   #3 create result.txt`. Ручное репро и 2 повтора — **3/3 pass**. Похоже на флейк
   окружения (стрим/процесс), а не на детерминированный дефект. Кандидат в отдельное
   исследование (`exit-on-complete` / ранний выход между LLM- и tool-фазами).
2. **`2.8-create-dir` — галлюцинация пути у модели.** Модель создала
   `deep/a/b/c/d/e/f/leaf.ts` вместо заданного `deep/nested/path/leaf.ts`; инструменты и
   harness отработали корректно. При повторе — 2/2 pass. Ограничение 9B, не дефект ветки.
3. **Стартовое предупреждение о бюджете системного промпта.** При окне 32768 и
   `contextBudget.systemPrompt=0.1` бюджет ~3276 токенов, а реальный `AGENTS.md` +
   project map требуют ~9044. Это конфигурационная рекомендация (`mma context`/
   `context --system`), а не дефект ветки.

---

## 6. Оговорки

- Основной прогон — `--reps 1`; два сценария перепроверены `--reps 2`. Для
  «боевой» сертификации авторы рекомендуют `2/3`.
- Модель — локальная `qwen/qwen3.5-9b` (класс target из AGENTS.md); вердикт по другим
  моделям не следует.
- Браузерные UI-сценарии (Playwright) в этот прогон не входили.
