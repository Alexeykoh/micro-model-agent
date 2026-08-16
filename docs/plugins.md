# Плагины MMA

Плагины перехватывают события агента: жизненный цикл сессии, вызовы LLM, выполнение тулов и UI-вывод (тул-карточки, спиннер, стриминг текста). Один плагин может подписаться на любое количество хуков.

> Источник правды — `AgentPlugin` в `src/modules/types.ts` и диспетчер `src/modules/plugins/manager.ts`.

## Где лежат плагины

| Каталог | Область | Описание |
|---------|---------|----------|
| `src/modules/plugins/builtin/` | встроенные | `lint-on-write`, `notify` — всегда загружены |
| `~/.mma/plugins/` | глобальные | для всех проектов пользователя |
| `<project>/.mma/plugins/` | проектные | только для этого проекта |

Плагин — файл (или папка с entry-файлом), экспортирующий объект `AgentPlugin`:

```ts
// ~/.mma/plugins/my-stats.ts
export default {
  name: "my-stats",
  onToolEnd(ctx, call, result, durationMs) {
    ctx.logger.info(`[my-stats] ${call.name} → ${durationMs}ms`);
  },
};
```

Допустимы `export default` и `export const plugin = {...}`. Файлы `.ts` работают под Bun, под обычным Node — только `.js`.

### Папки-плагины

Лоадер поддерживает два варианта размещения:

- **Отдельный файл** — `trace-server.ts` / `trace-server.js` прямо в корне каталога плагинов.
- **Папка** — подкаталог с entry-файлом. Entry ищется по порядку: `plugin.ts` → `plugin.js` → `index.ts` → `index.js`. Остальные файлы папки (хелперы, ассеты) загружаются entry-файлом через обычные относительные импорты:

```
~/.mma/plugins/trace-server/
├── plugin.ts      # entry — экспортирует AgentPlugin, импортирует остальное
├── page.html      # ассеты рядом с entry (читаются через import.meta.url)
├── context.ts
├── plans.ts
└── server.ts
```

Копирование папки-плагина = скопировать весь каталог целиком. Папки без entry-файла пропускаются.

## Интерфейс

```ts
interface AgentPlugin {
  name: string
  priority?: number          // больше = раньше (по умолчанию 0)
  isBuiltin?: boolean
  onBuildPrompt?(): string | null
  onBeforeThink?(ctx): void
  onAfterThink?(ctx, response: LLMResponse | null): void
  onBeforeTool?(ctx, call: ToolCall): boolean | Promise<boolean>
  onAfterTool?(ctx, call: ToolCall, result: ToolResult): void | Promise<void>
  onToolCall?(ctx): void
  onError?(ctx, error: Error): void
  onSessionStart?(ctx): void
  onSessionEnd?(ctx): void
  onPhase?(ctx, phase: 'thinking' | 'done'): void
  onToolStart?(ctx, call: ToolCall): void
  onToolEnd?(ctx, call: ToolCall, result: ToolResult, durationMs: number): void
  onText?(ctx, chunk: string): string | void
  onMeta?(ctx, chunk: string): string | void
}
```

## Жизненный цикл

| Хук | Когда вызывается | ctx (полезные поля) |
|-----|------------------|---------------------|
| `onSessionStart` | при старте сессии (до первого LLM-вызова) | `logger`, `sessionManager` |
| `onBuildPrompt` | один раз при сборке системного промпта | — (без ctx) |
| `onBeforeThink` | перед каждым вызовом LLM | `iteration`, `logger`, `lastUserMessage`, `contextManager`, `onMeta` |
| `onAfterThink` | после ответа LLM (см. `response`) | `iteration`, `logger` |
| `onPhase` | смена фазы спиннера: `thinking` / `done` | `iteration`, `logger` |
| `onToolCall` | LLM вернул тул-вызов | `toolName`, `args` |
| `onToolStart` | тул-карточка открыта (до выполнения) | `iteration`, `logger` |
| `onToolEnd` | тул выполнен (с результатом и длительностью) | `iteration`, `logger` |
| `onBeforeTool` | перед выполнением тула | `iteration`, `logger`, ... |
| `onAfterTool` | после выполнения тула | `iteration`, `logger`, ... |
| `onError` | ошибка LLM-вызова | `iteration`, `logger` |
| `onSessionEnd` | завершение сессии | `logger`, `sessionManager` |

`response` в `onAfterThink` — один из вариантов `LLMResponse`:
`{ type: "text", content }` | `{ type: "tool_call", calls }` | `{ type: "reasoning", content }`, либо `null`.

## Управление тулами

- **Блокировка:** `onBeforeTool` возвращает `false` — тул не выполнится. Первый `false` прерывает цепочку плагинов.
- **Модификация результата:** `onAfterTool` может менять `result.output` — текст попадёт в контекст модели и в тул-карточку. Так работает встроенный `lint-on-write`: дописывает ошибки синтаксиса в вывод `write_file`.

## UI/вывод

- **`onText`** — каждый чанк стриминга текста модели. Верните строку — она заменит чанк на экране (например, ред-акт секретов), `undefined` — чанк пройдёт как есть. Влияет только на отображение; `result.text` остаётся исходным.
- **`onMeta`** — то же для служебного вывода: reasoning (до покраски) и вывод тулов. Остальные статусные строки (разделители, MoE-статусы) через хук не проходят.
- **`onPhase`** — думание: `thinking` (модель грузится/генерирует, крутится спиннер), `done` (ответ получен). Удобно для своих уведомлений.
- **`onToolStart` / `onToolEnd`** — открытие/закрытие тул-карточки; в `onToolEnd` доступны `result` и `durationMs`. Пример: сбор статистики по тулам.

Трансформации применяются по порядку приоритета плагинов: результат предыдущего — вход следующего.

## Гарантии

- **Изоляция ошибок:** исключение в любом хуке логируется и не прерывает ни агент, ни остальные плагины.
- **Приоритет:** `priority` сортирует плагины по убыванию (10 раньше 1). Плагины модулей и builtin помечаются `isBuiltin`.
- **`onBeforeTool`** — единственный короткозамыкающий хук.

## Пример: ред-акт секретов

```ts
// .mma/plugins/redact.ts
export default {
  name: "redact",
  priority: 50,
  onText(_ctx, chunk) {
    return chunk.replace(/sk-[A-Za-z0-9]+/g, "[key]");
  },
  onMeta(_ctx, chunk) {
    return chunk.replace(/sk-[A-Za-z0-9]+/g, "[key]");
  },
};
```

## Пример: live trace в браузере (папка-плагин)

Полный пример многофайлового плагина — `examples/plugins/trace-server/` (HTTP-сервер + SSE, контекст, планы). Установка: скопировать папку целиком в `~/.mma/plugins/` или `<project>/.mma/plugins/`. Внутри — `plugin.ts` (entry) и модули `state.ts` / `util.ts` / `context.ts` / `plans.ts` / `server.ts` + ассет `page.html`.

## Пример: статистика сессии

```ts
// .mma/plugins/stats.ts
export default {
  name: "stats",
  calls: 0,
  totalMs: 0,
  onToolStart(_ctx) { this.calls++; },
  onToolEnd(ctx, _call, _result, durationMs) {
    this.totalMs += durationMs;
    ctx.logger.info(`[stats] calls=${this.calls} totalMs=${this.totalMs}`);
  },
  onSessionEnd(ctx) {
    ctx.logger.info(`[stats] done: ${this.calls} tools in ${this.totalMs}ms`);
  },
};
```

## См. также

- Встроенные плагины: `src/modules/plugins/builtin/lint-on-write.ts`, `notify.ts`
- Загрузчик: `src/modules/plugins/loader.ts`
- Диспетчер: `src/modules/plugins/manager.ts`
