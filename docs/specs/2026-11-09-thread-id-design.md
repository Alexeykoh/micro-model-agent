# Спека: `thread_id` для сессий (Durable state 1/4)

Дата: 2026-11-09. Ветка: `feat/durable-state` (ветка 1 из 4:
thread_id → checkpointer → retention → long-term store; по правилу 3
каждый — отдельная ветка, здесь только thread_id).
Источник: `TODO.md §3 P0 Durable state` и
[`docs/archive/specs/2026/2026-09-28-production-readiness-design.md`](../archive/specs/2026/2026-09-28-production-readiness-design.md) §4.

## Что неправильно

У сессии нет стабильного бизнес-ID для трейсинга. `SessionMeta.id` —
внутренний технический identifier каталога; `externalRef` — внешний ключ
интегратора ( может содержать сырой текст/PII). Для связки
trace↔session↔cost (P0 Observability) нужен harness-generated ID,
который переживает resume и не основан на контенте.

## Контракт

1. **Поле:** `SessionMeta.threadId?: string` — опциональное (старые меты
   без поля валидны). `.mma`-файлы, сгенерированная форма:
   `thr_` + 16 hex-символов (slug от крипто-ID сессии, без сырых текстов).
   Строго \< 255 символов. Никогда не содержит текст сообщений.
2. **Генерация:** `SessionManager.create()` всегда проставляет `threadId`,
   если в мете его нет. Передача через `create(...)` — append-only разширение
   сигнатуры не требуется: поле задаётся внутри фабрики (как сейчас
   генерируется `id`).
3. **Использование:** `llm_usage`/`context` события журнала уже пишут session-id;
   при возобновлении поток обязан сохранить тот же `threadId` (meta round-trip —
   достаточное условие). Резолв внешних `externalRef` не затрагивается.
4. **Service API:** поле `threadId` не добавляется в публичные ответы
   без отдельной задачи (minsurface: не отдаём лишнее наружу).

## Приёмка

- Тест: `create()` даёт `threadId` формы `thr_[0-9a-f]{16}` (< 255);
  `saveMeta`/`loadMeta` round-trip сохраняет; старая мета без поля грузится (undefined).
- Резолв добросовестности: `threadId` не содержит субстроки первого сообщения юзера
  (кроме случайных совпадений hex).
- `bun test tests/session/` зелёный; `bun run typecheck` чист.
