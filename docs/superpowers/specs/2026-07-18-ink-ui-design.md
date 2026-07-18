# ink UI Integration Design

## 1. Цель

Заменить `ReadlineRenderer` (текст-в-терминал + node:readline) на полноценный React-рендерер через [ink](https://github.com/vadimdemedes/ink) без поломки существующей архитектуры. `ReadlineRenderer` остаётся как fallback.

## 2. Изменения в коде

### Новые файлы

```
src/ui/ink/                    (всё новое)
├── renderer.ts                — InkRenderer implements OutputRenderer
├── theme.ts                   — ThemeEngine → ink style props bridge
└── components/
    ├── App.tsx                — root: reducer, layout, dispatch bridge
    ├── Conversation.tsx       — виртуальный список сообщений
    ├── MessageBlock.tsx       — одно сообщение (текст/ответ)
    ├── ToolCallBlock.tsx      — панель tool call с args/result
    ├── StreamBlock.tsx        — стриминг со спиннером и throttling
    ├── StatusBar.tsx          — pinned footer
    ├── PromptInput.tsx        — многострочный ввод с useInput()
    └── Tags.tsx               — Info/Success/Warning/Error/Heading
```

### Изменяемые файлы

| Файл | Изменение |
|------|-----------|
| `src/ui/index.ts` | factory: при `--ink` или `ui.mode: ink` — `InkRenderer` вместо `ReadlineRenderer` |
| `package.json` | +`ink`, +`react` |

### Неизменяемые файлы

| Файл | Причина |
|------|---------|
| `src/ui/renderer.ts` | интерфейс остаётся тем же |
| `src/agent/loop.ts` | работает через абстракцию |
| `src/repl/index.ts` | работает через абстракцию |
| `src/repl/commands.ts` | работает через абстракцию (кроме `/theme`) |
| `src/styling/*` | bridge читает оттуда, но сами файлы не трогаем |

## 3. InkRenderer → OutputRenderer

Каждый метод `OutputRenderer` → dispatch в React-редюсер.

### State

```typescript
type Action =
  | { type: 'ADD_ITEM'; item: ConversationItem }
  | { type: 'STREAM_CHUNK'; chunk: string }
  | { type: 'STREAM_REASONING'; text: string }
  | { type: 'STREAM_END' }
  | { type: 'SPINNER'; show: boolean }
  | { type: 'TOOL_START'; name: string; args: string }
  | { type: 'TOOL_END'; result: string; time: string; exitCode?: number }
  | { type: 'STATUS'; info: StatusInfo }
  | { type: 'CONTEXT'; text: string }
  | { type: 'THEME_CHANGED' }
  | { type: 'SHOW_PROMPT'; message: string }
  | { type: 'HIDE_PROMPT' }
  | { type: 'CLEAR' }
```

### Bridge (ключевой паттерн)

```typescript
class InkRenderer implements OutputRenderer {
  private dispatch: React.Dispatch<Action> | null = null;
  private promptResolve: ((value: string) => void) | null = null;

  start() { ink.render(<App onDispatch={d => this.dispatch = d} />); }

  writeMarkdownChunk(chunk: string) {
    this.dispatch?.({ type: 'STREAM_CHUNK', chunk });
  }

  async prompt(msg: string): Promise<string> {
    this.dispatch?.({ type: 'SHOW_PROMPT', message: msg });
    return new Promise(r => { this.promptResolve = r; });
  }
}
```

### Streaming optimization

- `StreamBlock` — отдельный компонент с key-based isolation
- React 18 batched updates
- Опциональный throttle 50ms для быстрых моделей

## 4. App компонент

```tsx
function App({ onDispatch }: { onDispatch: (d: React.Dispatch<Action>) => void }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  useEffect(() => { onDispatch(dispatch); }, []);

  return (
    <Box flexDirection="column" height="100%">
      <Conversation items={state.items} />
      {state.streaming && <StreamBlock content={state.streamContent} isReasoning={state.isReasoning} />}
      <StatusBar info={state.status} usage={state.contextUsage} />
      {state.showPrompt ? <PromptInput onSubmit={handleSubmit} commands={commands} /> : null}
    </Box>
  );
}
```

## 5. PromptInput

Многострочный ввод с полной заменой readline.

### Клавиши

| Клавиша | Поведение |
|---------|-----------|
| `Enter` | Submit (если не Shift) |
| `Shift+Enter` | Новая строка |
| `Tab` | Completion slash-команд |
| `↑` | История (в пустой строке) / курсор вверх |
| `↓` | История / курсор вниз |
| `← →` | Курсор в строке |
| `Ctrl+C` | Abort |
| Paste | Поддержка многострочной вставки |

### Функции сохранённые

- Tab-completion `/{cmd}` (текущая логика из `ReadlineRenderer.makeCompleter`)
- История сообщений через ↑/↓
- `/write` режим (многострочный ввод до `EOF`) — остаётся как есть

## 6. Визуальный макет

```
┌──────────────────────────────────────────────────────────┐
│ ▲ Conversation (flexGrow: 1, overflow hidden)             │
│   ┌── tool: read_file ─────────────────────────────┐     │
│   │ args | timing                                    │     │
│   └──────────────────────────────────────────────────┘     │
│   ○ streaming text...                                      │
├──────────────────────────────────────────────────────────┤
│ cyan█ qwen3.5:9b │ ████████░░ 15678/32768 │ step 3/25    │ ← StatusBar
│ MMA> /read src/index.ts  □                               │ ← PromptInput
└──────────────────────────────────────────────────────────┘
```

## 7. Theme Bridge

### Проблема

`ThemeEngine` возвращает ANSI-строки (`\x1b[34mtext\x1b[0m`). ink использует React-пропсы (`<Text color="cyan">`).

### Решение: colorToInk конвертер

```typescript
const PICOLOR_TO_INK: Record<string, object> = {
  cyan: { color: 'cyan' }, green: { color: 'green' },
  red: { color: 'red' }, yellow: { color: 'yellow' },
  blue: { color: 'blue' }, magenta: { color: 'magenta' },
  gray: { color: 'gray' }, white: { color: 'white' },
  dim: { dim: true }, bold: { bold: true },
  italic: { italic: true }, underline: { underline: true },
  bgRed: { backgroundColor: 'red' },
  // ...
};
```

### Цепочка данных

```
~/.mma/themes/dark.json     ← пользовательская тема
       │
       ▼
src/styling/loader.ts       ← loadThemeConfig() (новый экспорт)
       │
       ├──► ThemeEngine    → ANSI строки  (ReadlineRenderer)
       │
       └──► ink/theme.ts   → ink style props  (InkRenderer)
                                 │
                <Text {...t.colors.success}>OK</Text>
```

## 8. Theme System

### REPL команда `/theme`

```
/theme                       → список тем (+ активная)
/theme light                 → переключить
/theme dark
/theme show                  → показать конфиг текущей темы
/theme install <url>         → скачать + установить
/theme create <name>         → создать копию активной
/theme remove <name>         → удалить кастомную
```

### Агент-тул `theme`

```json
{"name":"theme","arguments":{"action":"list"}}
{"name":"theme","arguments":{"action":"switch","name":"dark"}}
{"name":"theme","arguments":{"action":"show"}}
{"name":"theme","arguments":{"action":"install","name":"monokai","url":"https://..."}}
```

### Изменения в существующих файлах

| Файл | Изменение |
|------|-----------|
| `src/styling/index.ts` | + `listThemes()`, `switchTheme()`, `resetTheme()` |
| `src/styling/loader.ts` | + `loadThemeConfig()`, `listThemes()`, `installTheme()`, `removeTheme()` |
| `src/repl/commands.ts` | + команда `/theme` |
| `src/agent/loop.ts` | `VALID_TOOLS` + `'theme'`; обработчик `theme` |
| `src/agent/system-prompt.ts` | + документация `theme` тула |

## 9. Конфигурация

```bash
mma --ink                           # флаг включения
INK_MODE=1 mma                       # env
mma config set ui.mode ink          # конфиг

# По умолчанию: readline (полная совместимость)
# Тема:
mma config set theme dark           # смена темы (конфиг)
/theme dark                          # смена темы (REPL)
```

## 10. Зависимости

```json
{
  "dependencies": {
    "ink": "^5.0.0",
    "react": "^18.3.0"
  }
}
```

`ink@5` — стабильная версия с ESM-поддержкой. React 18 — ink 5 требует его, плюс batched updates для стриминга.

## 11. Риски и митигации

| Риск | Митигация |
|------|-----------|
| Стриминг дёргает re-render на каждый токен | React 18 batched updates + throttle 50ms если нужно |
| ink не поддерживается на Windows | ink поддерживает Win (+ fallback на readline) |
| Увеличение bundle (react + ink ~70KB gzip) | Для npm-пакета ок, tree-shaking |
| Tab-completion сложнее чем readline | Больше контроля (кастомный UI подсказок) |
| Ctrl+C поведение | ink перехватывает — настраиваем через `exitOnCtrlC: false` + свой обработчик |
