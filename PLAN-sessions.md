# Multi-Session Support — Implementation Plan

## Phase 1 — Session Data Layer (3 файла)

### 1.1 `src/modules/session/types.ts`
- `SessionMeta` (id, name, createdAt, updatedAt, messageCount, model, contextWindow)
- `SessionConfig` (autoSave, maxSessions)

### 1.2 `src/modules/session/store.ts`
- `SessionStore` — читает/пишет в `~/.mma/sessions/<id>/`:
  - `meta.json` — метаданные сессии
  - `history.jsonl` — JSONL сообщений
- Методы: `saveMeta()`, `loadMeta()`, `appendMessage()`, `loadHistory()`, `listSessions()`, `deleteSession()`

### 1.3 `src/modules/session/manager.ts`
- `SessionManager` (фасад):
  - `create(name?)` → `SessionMeta`
  - `list()` → `SessionMeta[]`
  - `get(id)` / `delete(id)` / `rename(id, name)`
  - `setActive(id)` / `getActive()` — текущая сессия в памяти
  - `appendMessage(msg)` — пишет в active session history.jsonl
  - `loadHistory()` → `Message[]` — для загрузки в ContextManager

---

## Phase 2 — Integration (4 файла)

### 2.1 `src/modules/session/index.ts` — barrel export

### 2.2 `src/modules/session/module.ts` — реализует `AgentModule`:
- `getSystemPromptBlock()` — возвращает `PromptBlock` с именем/id сессии для system prompt
- `getPlugin()` — возвращает `AgentPlugin` с:
  - `onSessionStart(ctx)` — загружает историю сессии в ContextManager
  - `onSessionEnd(ctx)` — сохраняет финальный compaction, закрывает сессию

### 2.3 `src/core/bootstrap.ts` — изменения:
- Создать `SessionManager`
- Передать его в `AgentDeps`
- Заложить `sessionHistory` в `ToolContext` (реальная имплементация)
- При старте: создать новую сессию или зарезьюмить последнюю
- Связать ContextManager.compact() с SessionManager.appendMessage()
- Вызвать `pluginManager.runOnSessionStart()` при старте
- Вызвать `pluginManager.runOnSessionEnd()` при завершении

### 2.4 `src/modules/context/manager.ts`:
- Добавить `onCompact: ((msgs: Message[]) => void) | null`
- ContextManager.compact() дёргает `onCompact` если установлен
- SessionManager подписывается на onCompact для персиста

---

## Phase 3 — Интеграция с PluginManager и Memory

### 3.1 PluginManager hooks уже готовы:
- `onSessionStart(ctx)` — вызывается в bootstrap после создания сессии
  - SessionModule загружает историю → передаёт ContextManager
- `onSessionEnd(ctx)` — вызывается при exit / switch session
  - SessionModule сохраняет последний compaction → закрывает JSONL

### 3.2 Memory module — каждая сессия может:
- Иметь изолированные `conventions.md`, `decisions.md`, `errors.md` в `~/.mma/sessions/<id>/`
- Либо share-ить глобальные — настраивается через `session.isolateMemory: boolean` в конфиге

### 3.3 Indexer module — не зависит от сессий (индексирует код, а не историю)

### 3.4 search-history tool — переключается на чтение из `~/.mma/sessions/*/history.jsonl`

### 3.5 ExecutionModule — через `onSessionStart` получает контекст сессии (прошлые решения, ошибки)

---

## Phase 4 — CLI + REPL (3 файла)

### 4.1 `src/cli/repl.ts` — слэш-команды:
```
/sessions           — список сессий (* active)
/new [name]         — создать новую
/resume <id|name>   — переключиться
/rename <name>      — переименовать текущую
/delete <id>        — удалить сессию
```

### 4.2 `src/cli/commands.ts` — новая группа:
```
mma session list
mma session show <id>
mma session delete <id>
```

### 4.3 `src/cli/main.ts` — при старте REPL:
- Показать список сессий, спросить продолжить или новую

---

## Phase 5 — Config (2 файла)

### 5.1 `src/config/types.ts` — добавить в `AppConfig`:
```typescript
session: {
  autoSave: boolean
  maxSessions: number
  isolateMemory: boolean
}
```

### 5.2 `src/config/defaults.ts` — дефолты

---

## Phase 6 — Документация

### 6.1 `AGENTS.md`:
- Project Structure: добавить `modules/session/`
- Новая секция Session Management с командами
- Убрать `history.ts` из planned (теперь это `session/`)

### 6.2 `PLAN-sessions.md` удалить после реализации

---

## Phase 7 — Tests (минимум 4 файла)

### 7.1 `tests/session-store.test.ts`
### 7.2 `tests/session-manager.test.ts`
### 7.3 `tests/cli/repl-session.test.ts`
### 7.4 Обновить `tests/core/bootstrap.test.ts`

---

## Порядок выполнения

```
Phase 1 → Phase 2 → Phase 3 → Phase 5 → Phase 4 → Phase 6 → Phase 7
```
