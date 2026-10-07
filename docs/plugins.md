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
  version?: string           // semver: дедуп (выигрывает старшая) + показ в UI
  minMmaVersion?: string     // несовместимые пропускаются загрузчиком
  description?: string       // человеческое описание, 1–2 строки
  author?: string            // автор или организация
  homepage?: string          // только http(s)
  permissions?: PluginPermission[]  // декларация прав (см. «Права — не защита»)
  provides?: { tools?: string[]; hooks?: string[] }
  priority?: number          // больше = раньше (по умолчанию 0)
  isBuiltin?: boolean
  onBuildPrompt?(): string | null
  onBeforeThink?(ctx): void
  onAfterThink?(ctx, response: LLMResponse | null): void
  onBeforeTool?(ctx, call: ToolCall): boolean | Promise<boolean>
  onAfterTool?(ctx, call, result: ToolResult): void | Promise<void>
  onToolCall?(ctx): void
  onError?(ctx, error: Error): void
  onSessionStart?(ctx): void
  onSessionEnd?(ctx): void
  onPhase?(ctx, phase: 'thinking' | 'done'): void
  onToolStart?(ctx, call: ToolCall): void
  onToolEnd?(ctx, call, result, durationMs: number): void
  onText?(ctx, chunk: string): string | void
  onMeta?(ctx, chunk: string): string | void
  onTurnEnd?(ctx, summary: TurnSummary): void
}
```

Типы (`AgentPlugin`, `HostBridge`, `TurnSummary`, `PluginRecord`, `PLUGIN_PERMISSIONS`)
экспортируются из корня пакета — можно импортировать и не дублировать контракт:

```ts
import type { AgentPlugin } from "micro-models-agent";
```

### Метаданные

`description`, `author`, `homepage`, `permissions` — **необязательные**. Их отсутствие даёт
предупреждение в логе и в UI, но не мешает регистрации: плагин из 8 строк и оба примера в
`examples/plugins/` работают как раньше. Единственное жёсткое требование — валидное `name`
(`^[a-z0-9][a-z0-9._-]{0,63}$`).

`provides.hooks` ядро вычисляет само; `provides.tools` заполняется, когда плагин отдаёт тулы.

Плагин с необязательными метаданными (описание для пользователя):

```ts
// ~/.mma/plugins/lint-on-commit.ts
import type { AgentPlugin } from "micro-models-agent";

export default {
  name: "lint-on-commit",
  version: "1.0.0",
  description: "Гоняет линтер после каждой записи файла.",
  author: "alexe",
  homepage: "https://github.com/alexe/mma-lint-on-commit",
  permissions: ["process", "fs:read"],
  onAfterTool(ctx, call, result) {
    if (call.name !== "write_file") return;
    ctx.logger.info("lint skipped — подключите линтер");
  },
} satisfies AgentPlugin;
```

## Включение и выключение

Плагин включается/выключается **живо**, без перезапуска. Три поверхности, один путь записи
(`setConfigValue("plugins.disabled", …)`):

```bash
mma plugins list              # реестр: имя, версия, автор, описание, права
mma plugins list --all        # + встроенные
mma plugins show my-plugin    # подробности одного плагина
mma plugins disable my-plugin
mma plugins enable my-plugin
```

```
/plugins                      # тот же список
/plugins --all
/plugins show my-plugin
/plugins disable my-plugin
```

В `mma web` — вкладка **Plugins** в сайдбаре (`Alt+6`): тумблер в строке и подробности
(описание, автор, версия, путь, что добавляет, права) в поп-апе. В панели настроек
`Plugins · MCP` — те же тумблеры. Конфиг-ключ: `plugins.disabled`
(домен `plugins.json`, deny-list имён).

> **Disable ≠ sandbox.** Модуль уже `require`-нут, код верхнего уровня уже выполнился.
> Выключение останавливает хуки и поведение, а не исполнение импорта. `permissions` — это
> декларация для показа пользователю, а не enforcement: плагин исполняется в процессе агента
> и де факто имеет те же возможности (включая `bash`, сеть и доступ к конфигу с ключами
> провайдера). Настоящая изоляция и доверие к коду — открытая работа
> (`docs/specs/2026-09-28-production-readiness-design.md`, §P1).

Плагин, который не загрузился, не исчезает: он виден как отказ с причиной в одну строку
(`mma plugins list`, вкладка Plugins, `GET /api/plugins` → `failures`).

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

## Host Bridge — управление агентом из плагина

Хуки позволяют плагину **наблюдать** за агентом. Чтобы **управлять** им (отправлять сообщения, прерывать), REPL регистрирует в `PluginManager` узкий интерфейс `HostBridge`; диспетчер подмешивает его в контекст каждого хука как `ctx.hostBridge`:

```ts
interface HostBridge {
  isBusy(): boolean;                                   // агент обрабатывает ход?
  submit(text: string, opts?: { images?: string[] }): Promise<unknown>; // как ввод с клавиатуры
  interrupt(): void;                                   // аналог double-Esc
}
```

- Сообщения идут через тот же путь `Repl.runAgent()` — рендеринг, сессия, логи общие с терминалом.
- `submit` отклоняется (`throw`) при занятом агенте: сначала проверяйте `isBusy()`.
- Картинки передаются data URL'ами (`data:image/jpeg;base64,...`) — они попадают в контекст так же, как Ctrl+V.
- В одноразовом режиме (`mma "prompt" --exit-on-complete`) моста нет — `ctx.hostBridge === undefined`.

```ts
// .mma/plugins/remote.ts — пример использования
export default {
  name: "remote",
  onSessionStart(ctx) {
    const bridge = ctx.hostBridge;
    if (!bridge) return ctx.logger?.warn("[remote] no host bridge (single-run mode)");
    if (!bridge.isBusy()) bridge.submit("привет из плагина");
  },
};
```

## `onTurnEnd`

Вызывается **один раз** на каждый завершённый `Agent.run()` — финальный ответ, ошибка или прерывание:

```ts
interface TurnSummary {
  success: boolean;
  durationMs: number;
  textLength: number;
  toolCalls: number;
  interrupted?: boolean;
}
```

В отличие от `onPhase('done')` (это конец одного LLM-вызова внутри цикла тулов), `onTurnEnd` означает «весь ход завершён» — можно снимать busy-состояние, слать уведомления.

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

## Пример: двусторонний веб-интерфейс (web-ui)

`examples/plugins/web-ui/` — чат с агентом из браузера: стриминг хода (SSE), отправка сообщений и картинок (`POST /api/message` → HostBridge), прерывание (`POST /api/interrupt`), план, бэктолл истории. Демонстрирует связку всех UI-хуков + `onTurnEnd` + `ctx.hostBridge`. Env-конфиг: `MMA_WEBUI_PORT`, `MMA_WEBUI_HOST`, `MMA_WEBUI_TOKEN` (обязателен для не-loopback бинда), `MMA_WEBUI_MAX_CLIENTS`, `MMA_WEBUI_OPEN=0`.

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
- Метаданные и валидация: `src/modules/plugins/records.ts`
- Общий формат листинга (CLI + REPL): `src/modules/plugins/format.ts`
- Дизайн: `docs/specs/2026-10-07-plugin-registry-design.md`
