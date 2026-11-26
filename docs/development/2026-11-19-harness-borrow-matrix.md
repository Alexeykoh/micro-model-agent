# Развитие MMA: что позаимствовать у современных harness'ов

**Дата:** 2026-11-19
**Статус:** рабочая карта идей. Не спека, не план релиза и не долг.
**Основа:** сравнение MMA 0.26 с Claude Code, DeepSeek Harness, Qwen Code, Codex CLI и Pi
по официальным докам и исходникам этих проектов.

Нормативная база остаётся прежней: [architecture v2](../specs/2026-10-12-architecture-v2-design.md),
[gates.md](../agents/gates.md), [AGENTS.md](../../AGENTS.md). Любая строка ниже, которая меняет
публичный контракт (CLI, формат `session.jsonl`, конфиг, REST/SSE-событие, контракт плагина),
перед кодом получает [спеку](../specs/README.md) и гейт.

---

## 0. Как читать матрицу

- **Приоритеты**
  - `P1` — брать в ближайших волнах: закрывает реальный пробел дешево.
  - `P2` — после закрытия W5 / одновременно с enterprise-волной.
  - `P3` — держать в поле зрения; брать только при наступлении триггера.
  - «Не берём» — уже покрыто или прямо вредно для целевой модели (9B).
- **Стоимость** (человеко-дни одного разработчика, знакомого с MMA, ориентировочно):
  `S` ≤ 1 · `M` 2–5 · `L` 6–15 · `XL` > 15.
- **Гейт приёмки** — минимальная проверка, без которой идея считается не сделанной.
  Для fail-open путей обязательно: отдельный сигнал в `session.jsonl` и строка
  в `observability-coverage` (INV-15).

---

## 1. Краткая база сравнения

| Ось | **MMA 0.26** | Claude Code | DeepSeek Harness | Qwen Code | Codex CLI | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Философия | Small-model + верификация | Зрелость контроля | Всё — плагин (Cordis) | Широта поверхностей | Rust + OpenAI | Осознанный минимализм |
| Петля | 6 фаз, один путь | Agent loop + workflows | Turn/step, event waterfall | Agent loop | Agent loop | Agent loop |
| Верификация | Детерм. гейты + critic + аудит | Хуки, тесты, одобрения | Validation events, «model-visible = logged» | Goal-верификатор | Частично | Нет |
| Сабагенты | `fork()` в Observe | Teams, worktree, SDK | Subagent Providers + Teams | Teams + **Arena** | Cloud/SDK | Нет намеренно |
| Конфиг/расширения | 3 слоя + эффекты, 33 модуля | settings, managed, skills/plugins | **Профили + бандлы + патчи + HMR** | settings, hooks, MCP | `config.toml`, execpolicy, hooks | Pi packages, hot reload |
| Безопасность | Enforcement в `ToolExecutor`, DLP, шифрование | Permissions (не security boundary) | Guarded pipeline; **security-аудит не проведён** | Sandbox + approval modes | Sandbox + approvals | Встроенной нет |
| История | `session.jsonl` | Сессии | `session.vN.jsonl[.zstd]`, версионированные миграции | Сессии | Сессии | `pi-durable` |
| Поверхности | CLI/Web/Serve/daemon | Terminal/IDE/Desktop/Web/CI | Web/headless/SDK/ACP/Desktop | Terminal/Desktop/Web/IDE/чаты/daemon/SDK | CLI/IDE/Desktop/Web | CLI/print/JSON/RPC/SDK |

---

## 2. P1 — брать в ближайших волнах

| Идея (источник) | Что даёт MMA | Почему именно сейчас | Стоимость | Куда ложится | Гейт приёмки |
| --- | --- | --- | --- | --- | --- |
| **Supply-chain дисциплина** (Pi) | Точные пины прямых зависимостей, `min-release-age=2`, lockfile как источник истины, pre-commit-защита lockfile, install-lock для инсталлятора, `npm ci --ignore-scripts`, плановый `npm audit`, allowlist lifecycle-скриптов | У MMA уже есть sha256-проверка релизов, SBOM и release-manifest; не хватает именно политики зависимостей. Самая дешёвая и самая заметная для пользователя правка | `S` | `scripts/`, `.github/workflows/`, `package.json` | CI-job + guard, что lockfile не меняется случайно; офлайн-сборка не тянет новые пакеты |
| **Профили и упорядоченные слои патчей** (DeepSeek Harness) | `profile` (набор `bundle` + внешние плагины + свой patch-файл), слой home-patch и `--patch` поверх; дамп итогового дерева конфигурации | Прямо развязывает enterprise-линию: «политика приходит с сервера» и кастомные дистрибутивы перестают быть правкой файлов. Перекликается с модульными ключами конфига (INV-21) и `teardown` (INV-7) | `M` | `src/config/`, `src/core/module-host.ts`, `src/cli/` | `tests/arch/config-effects.test.ts`: снимок → патч → эффекты → откат; ни одного прямого изменения чужого домена (INV-19) |
| **`Goal`: цель между ходами с независимым верификатором** (Qwen Code) | `/goal` держит объект работы, пока отдельный verifier не примет результат, внутри token budget | У MMA есть проверка шагов плана и финальный аудит, но нет «персистентной цели» между пользовательскими ходами. Это добирает нижнюю половину доверия без новой фазы петли | `M` | `src/modules/execution/`, `src/core/agent/`, план-хранилище | `tests/execution/goal-verifier.test.ts`: цель не закрывается словом модели; fail-open оставляет `goal_verifier_degraded` |
| **Версионированные поколения `session.jsonl` + миграции** (DeepSeek Harness) | `session.vN.jsonl[.zstd]`, соседние миграции `vN → vN+1`, опубликованное поколение никогда не перезаписывается | MMA активно использует replay и `session diagnose`; формат лога — де-факто публичный контракт. Сейчас миграция есть у конфига, но не у самого лога | `M` | `src/modules/session/`, `tests/replay/` | `tests/replay/invariants.test.ts` на старых и новых фикстурах; read-open не публикует новую генерацию |
| **Пери-субагентные модели/усилия + worktree-изоляция** (Claude Code) | `model`, `effort`, `maxTurns`, `isolation: worktree`, `cacheTtl` на уровне сабагента; MMA сейчас имеет expert tags, scope и result mode | У MMA уже есть `config.experts` и per-expert модели — осталось довести до сабагента. Worktree снимает главный риск параллельных правок в одной рабочей папке | `M` | `src/tools/subagent*.ts`, `src/modules/security/` | `tests/tools/subagent-scope.test.ts`: выход за worktree/scope невозможен; таймауты согласованы (INV-8) |

---

## 3. P2 — после W5 / вместе с enterprise-волной

| Идея (источник) | Что даёт MMA | Почему не сейчас | Стоимость | Куда ложится | Гейт приёмки |
| --- | --- | --- | --- | --- | --- |
| **Capability seams: Service Definition + Provider + Consumer** (DeepSeek Harness) | Явная сменяемость провайдера файловой системы/процессов; подмена провайдера переносит Bash/PTY/LSP в удалённый sandbox без форков | Сейчас почти есть (`core/api/**`, `ModuleHost`), но не как единый паттерн. Требует решения «ядро или модуль» и согласования с [monolith split](../specs/2026-11-10-monolith-split-design.md) | `M`–`L` | `src/core/api/`, `src/modules/*` | `tests/arch/module-boundaries.test.ts` (INV-3/4) + тест подмены провайдера без изменения тулов |
| **Синтаксис permission-правил как UX** (Claude Code) | `Bash(npm run *)`, `Read(./.env)`, gitignore-паттерны, разбор составных команд, комментарий при одобрении | MMA строже (enforcement в точке исполнения), но менее выразителен для пользователя. Берём **только синтаксис и предсказуемость**, не замену enforcement | `M` | `src/modules/security/`, промпт-блоки | `tests/arch/guidance-enforcement.test.ts`: подсказка модели не расходится с реальным enforcement; правила не становятся «безопасностью через текст» |
| **Managed-only hooks и отдельный execution policy** (Codex CLI, Claude Code) | `allow_managed_hooks_only`, отдельный артефакт политики исполнения, который пользователь не может ослабить | Имеет смысл только вместе с control plane и ролями; иначе это лишний слой конфига | `M` | `src/modules/plugins/`, `src/config/`, enterprise-волна | `tests/service/tenant-authz.test.ts`: managed-правило не переопределяется локальным |
| **Чат-каналы и daemon с несколькими workspace** (Qwen Code) | Telegram/DingTalk/Feishu/GitHub как входы; несколько workspaces на одном процессе | MMA честно заявлен как 1 процесс = 1 tenant. Мульти-workspace — отдельная enterprise-волна, а не патч | `L` | `src/modules/service/`, `src/modules/webui/` | Контракт `/v1/*` остаётся обратно совместимым; тесты тенант-изоляции |
| **Маленькая core-дистрибуция** (Pi `sdk-minimal`, dsh profile `sdk-minimal`) | Отдельный минимальный набор «ядро + SDK» без 33 модулей | Полезно только вместе с профилями из P1; иначе второй путь сборки | `M` | `scripts/stage-release.ts`, профили | Smoke-тест билда + тот же набор гейтов |

---

## 4. P3 — держать в поле зрения (триггеры)

| Идея (источник) | Триггер, при котором берём | Почему не сейчас |
| --- | --- | --- |
| **Agent Arena** (Qwen Code) — одна задача на нескольких моделях в изолированных worktrees, сравнение и merge победителя | Появится запрос на сравнение бэкендов на реальных задачах и готова изоляция worktree из P1 | Сертификация моделей уже закрывает офлайн-часть; полный Arena — отдельный продукт |
| **Модель пишет воркфлоу сама** (Qwen Code Dynamic Workflows) | Есть песочница, execution policy и eval-оценка сгенерированного кода | Для 9B это новый класс галлюцинаций и новая поверхность атаки; YAML-пайплайны с волнами уже покрывают большинство кейсов |
| **Agent Teams / cross-session messaging** (Claude Code) | Появится control plane с несколькими пользователями | Текущая модель «1 сессия = 1 раннер»: переизобретать обмен сообщениями без tenants бессмысленно |
| **Enforcement как внешний guard для других агентов** (сигнал: `cc-safety-net` поддерживает Pi, dsh, Codex, OpenCode) | В инфраструктуре появятся чужие агенты, для которых нужен общий шлюз | MMA уже имеет собственную точку enforcement; наружу её отдавать рано, пока контракт beta |
| **HMR конфигурации без рестарта** (DeepSeek Harness) | Пользовательский спрос на live-правки политики в web | `/reload` и эффекты конфига уже покрывают базовый случай; HMR добавит гонки с персистентностью |

---

## 5. Не берём — уже покрыто или вредно

| Практика | Причина отказа |
| --- | --- |
| «Всё — плагин, включая agent loop» (dsh) | Прямо конфликтует с INV-9/22: enforcement и единственный путь хода должны быть в ядре. Модульность MMA — через `ModuleHost`, а не через подмену ядра |
| **Отсутствие permission-слоя** (Pi) | MMA работает с файлами, сетью и чужими ключами; отказ от enforcement недопустим. Если нужна простота — лучше минимальная дистрибуция (P2), а не снятие защиты |
| **Текстовые правила как граница безопасности** (Claude Code) | Доки Claude сами признают: `Bash(rm *)` не ловит `/bin/rm` и `sh -c`. У MMA проверка в `ToolExecutor.execute()` — это сильнее; синтаксис берём, концепцию нет |
| **Hosted/managed harness как основной путь** (Claude Managed Agents) | Нарушает cloud-optional и офлайн-идентичность MMA. Может появиться только как дополнительная surface после enterprise |
| **Отключение шифрования сессий и DLP ради скорости** | Это откат от уже принятых решений; не заимствование, а регресс |

---

## 6. Риски и ограничения

1. **Маленькая модель.** Любая новая фича, которая попадает в системный промпт или схему тулов,
   съедает контекст 9B. По умолчанию — on-demand теги и hidden-tools блок; новые alwaysOn-блоки
   требуют отдельного обоснования и замеров `mma context --system`.
2. **Инварианты не становятся текстом.** Идея из раздела 2 или 3, принятая в работу, получает
   гейт в `tests/arch/` или `tests/execution/` **в той же волне**, иначе она заживёт максимум
   до следующего большого изменения (AGENTS.md §5).
3. **Бета-версионирование.** Новый тул/команда/модуль = `MINOR` в `0.x.y`; смена формата
   `session.jsonl` или REST-контракта = спека по AGENTS.md §2 + обратная совместимость.
4. **Ресурсы.** Оценки `S/M/L/XL` — ориентиры для одного разработчика. Две идеи `P1` с общим
   гейтом (`session.vN` + replay) дешевле, чем две независимые волны.
5. **Долг платится один раз.** Пока идея не взята в работу, её место здесь. В
   [debt.md](../agents/debt.md) она попадает только с `id`, триггером и критерием выхода.

---

## 7. Что сделать прямо сейчас

- [ ] Завести отдельную задачу на supply-chain check (`P1/S`) — самый дешёвый и безопасный шаг.
- [ ] Перед следующей волной архитектуры решить: профили/патчи или расширение реестра ключей.
      Если меняется формат конфига — сначала [спеку](../specs/README.md).
- [ ] Сверить `Goal`-верификатор с текущими `verify`/audit/critic, чтобы не появился второй
      путь проверки (INV-22).
- [ ] Не трогать [CHANGELOG.md](../../CHANGELOG.md) до явной команды.

---

## 8. Источники

- Claude Code — [overview](https://code.claude.com/docs/en/overview), [permissions](https://code.claude.com/docs/en/permissions), [sub-agents](https://code.claude.com/docs/en/sub-agents), [Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
- DeepSeek Harness — [репозиторий](https://github.com/deepseek-ai/deepseek-harness), [architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md), [SAFETY](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md), [Cordis](https://github.com/cordiverse/cordis)
- Qwen Code — [репозиторий](https://github.com/QwenLM/qwen-code), [документация](https://qwenlm.github.io/qwen-code-docs/)
- Codex CLI — [репозиторий](https://github.com/openai/codex), [docs/](https://github.com/openai/codex/tree/main/docs)
- Pi — [репозиторий](https://github.com/earendil-works/pi), [pi.dev](https://pi.dev)
- Внутренние: [best-practices audit](../analysis/2026-08-07-harness-best-practices-audit.md), [enterprise idea](../ideas/2026-11-05-mma-enterprise.md), [monolith split](../specs/2026-11-10-monolith-split-design.md), `handoff` (удалён 2026-11-25)
