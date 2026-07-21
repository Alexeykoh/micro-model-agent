# Глубокий анализ проблем MMA агента

**Дата анализа**: 2026-07-21  
**Модель**: qwen/qwen3.5-9b  
**Платформа**: Windows (PowerShell)  
**Источник данных**: тесты `test-agent-conversation.ts` + логи `~/.mma/logs/2026-07-21.log`

---

## Проблема 1: bash-команды падают на Windows

### Симптом
Все вызовы `bash` завершаются с ошибкой:
```
"pwsh" не является внутренней или внешней командой, runnable program or batch file.
```

### Корневая причина

**Файл**: `src/tools/bash.ts:203`

```typescript
const result = await execa('pwsh', ['-NoProfile', '-EncodedCommand', encoded], {
  timeout: timeoutSeconds * 1000,
  maxBuffer: 10 * 1024 * 1024,
  windowsHide: true,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
  encoding: 'utf8',
});
```

Код **жёстко захардкожен** на `pwsh` (PowerShell Core). На Windows по умолчанию установлена `Windows PowerShell` (`powershell.exe`), а не `PowerShell Core` (`pwsh`). Они — разные исполняемые файлы:

| Команда | Путь | Версия |
|---------|------|--------|
| `powershell.exe` | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` | 5.1 (встроенная) |
| `pwsh` | Требует отдельной установки | 7.x (cross-platform) |

**Почему это не было замечено ранее**: На основной машине разработчика `pwsh` установлен. На тестовой машине — нет.

### Цепочка вызовов

```
Model → <tool_call>{"name":"bash","arguments":{"cmd":"npm create vite@latest..."}}</tool_call>
  → loop.ts:698-700: определяет как bash, формирует executorArgs
    → ToolExecutor.execute() → bashHandler.execute()
      → executeBash(cmd, timeout)
        → translateToPowerShell(cmd) — конвертирует Unix→PowerShell
        → encodePowerShellCommand(cmd) — base64 для -EncodedCommand
        → execa('pwsh', ['-NoProfile', '-EncodedCommand', encoded]) ← ПАДАЕТ ЗДЕСЬ
```

### Влияние на тесты

| Сценарий | Потеря |
|----------|--------|
| code (fibonacci, Logger, debounce) | `tsc --noEmit` не работает — агент не может проверить типы |
| code-quality (mergeSort, Stack) | `npx tsc --noEmit` не работает |
| code-explain (async-map) | `npx tsc --noEmit` не работает |
| react-todo | Subagent не может установить зависимости, создать проект — 0 файлов |
| subagent-test | Все bash-команды падают |

### Дополнительные проблемы

1. **Трансляция Unix→PowerShell неполная**: Таблица `UNIX_TO_PWSH` покрывает базовые команды (`ls`, `cat`, `rm`, `mkdir`), но не покрывает:
   - `npm create vite@latest ...` — передаётся как есть, но `pwsh` не найден
   - `npx --yes create-vite ...` — аналогично
   - `if (-not (Test-Path ...))` — PowerShell-синтаксис, но снова `pwsh` не найден

2. **Subagent не адаптируется**: Когда `bash` падает 12 раз подряд, subagent продолжает пробовать variations команд вместо переключения на `write_file` для ручного создания файлов.

3. **Нет feedback модели**: Ошибка `"pwsh" не является командой` не содержит подсказки о доступных shell. Модель не может понять что нужно использовать `powershell.exe`.

---

## Проблема 2: Пустые ответы после tool calls

### Симптом
В 12 из 30 промптов модель возвращает пустой контент:
```
⚠   [empty response: model produced 80 reasoning chunks but no content]
⚠   [empty response: model produced 284 reasoning chunks but no content]
```

### Корневая причина

**Множественные факторы, взаимно усиливающие друг друга**:

#### Фактор A: `enableThinking: true` для Qwen3.5

**Файл**: `src/tools/subagent.ts:262`
```typescript
for await (const chunk of provider.chat(messages, { temperature: 0.7, signal, showThinking, enableThinking: true })) {
```

**Файл**: `src/llm/openai-compat.ts:75-78`
```typescript
if (options?.enableThinking && reasoning) {
  body.chat_template_kwargs = { enable_thinking: true };
}
```

Qwen3.5 — reasoning-модель. При `enable_thinking: true` модель сначала генерирует `reasoning_content` (thinking), затем `content`. Проблема: **модель exhausted свой reasoning budget и не генерирует content**.

Из логов видно паттерн:
```
finish_reason=stop, reasoning_chunks=80, content_chunks=0
finish_reason=stop, reasoning_chunks=284, content_chunks=0
finish_reason=stop, reasoning_chunks=348, content_chunks=0
```

`finish_reason=stop` означает что модель завершила генерацию (не обрезана по `max_tokens`). Но `content_chunks=0` — модель потратила весь budget на reasoning и не переключилась на content.

#### Фактор B: `max_tokens` insufficient для reasoning-моделей

**Файл**: `src/llm/openai-compat.ts:58`
```typescript
const defaultMaxTokens = reasoning ? 16384 : 4096;
```

Для reasoning-моделей `max_tokens=16384`. Но reasoning-токены потребляют часть этого бюджета. Если модель генерирует 10,000 reasoning-токенов, у неё остаётся только ~6,000 для content. После tool call контекст растёт, и модель тратит больше reasoning на анализ результата.

#### Фактор C: Контекст после tool call

После каждого tool call в контекст добавляются:
1. `assistant` сообщение с tool_call
2. `tool` сообщение с результатом (до 8000 символов)
3. `user` сообщение с `"Continue."`

Для модели с контекстом 32K это быстро растёт. После 3-4 tool calls контекст может содержать 15,000+ токенов. Модель тратит reasoning на анализ всей истории, не оставляя бюджета на content.

#### Фактор D: Retry机制 не эффективна

**Файл**: `src/agent/loop.ts:367-406`

Текущий retry при пустом ответе:
```typescript
if (!response.trim()) {
  consecutiveEmpty++;
  // ...
  messages.push({ role: 'user', content: 'Continue.' });
  continue;
}
```

Проблема: `doChat` вызывается с `retries=1` (loop.ts:333), что означает **одну попытку** внутри `doChat`. Если модель вернула пустой ответ с reasoning chunks, retry внутри `doChat` отправляет тот же контекст — модель снова тратит reasoning и не генерирует content.

**Файл**: `src/agent/loop.ts:333`
```typescript
const { response } = await doChat(provider, messages, renderer!, renderer?.abortSignal, 1, options?.showThinking);
```

Второй аргумент `1` — это `retries`. Модель получает **ровно одну попытку** в `doChat`.

### Статистика из логов

| Паттерн | Частота | Пример |
|---------|---------|--------|
| reasoning > 0, content = 0, finish_reason=stop | 25 раз | После write_file, read_file, bash |
| reasoning > 0, content = 0, finish_reason=length | 0 раз | — |
| reasoning = 0, content = 0, finish_reason=unknown | 5 раз | В начале (system prompt загрузка) |

### Почему reasoning chunks > 0 при content = 0?

Qwen3.5 с `enable_thinking: true` отправляет reasoning в отдельном поле `reasoning_content`. Модель:
1. Получает tool result
2. Генерирует reasoning chunks (анализирует что делать дальше)
3. **Не генерирует content** — либо exhausted budget, либо "застревает" в reasoning

Это known behavior Qwen3.5 — модель иногда "думает" слишком долго и не переключается на ответ.

---

## Проблема 3: Subagent результаты не видны

### Симптом
Пользователь видит только:
```
[Subagent done — no files, 20 turns, 5133 tokens]
```
Но не видит **что именно делал subagent**.

### Корневая причина

**Проблема в цепочке отображения**:

#### Шаг 1: SubagentRenderer буферизует вывод

**Файл**: `src/ui/subagent-renderer.ts`

SubagentRenderer перехватывает весь вывод subagent (streaming, tool calls, сообщения) и сохраняет в буфер:
```typescript
private buffer: SubagentBuffer = { lines: [], toolCalls: [], streaming: '' };
```

#### Шаг 2: Буфер передаётся в основной renderer

**Файл**: `src/agent/loop.ts:665-668`
```typescript
const buf = subRenderer.getBuffer();
if (!quiet && renderer?.writeToolBuffer) {
  renderer.writeToolBuffer({ lines: buf.lines, toolCalls: buf.toolCalls });
}
```

#### Шаг 3: Ink renderer dispatches TOOL_BUFFER event

**Файл**: `src/ui/ink/renderer.ts:136-138`
```typescript
writeToolBuffer(data) {
  this.dispatch({ type: 'TOOL_BUFFER', data });
}
```

#### Шаг 4: App.tsx stores buffer in state

**Файл**: `src/ui/ink/components/App.tsx:113-127`
```typescript
case 'TOOL_BUFFER': {
  const idx = state.toolCallIndex;
  // ... stores subagentBuffer in entry
}
```

#### Шаг 5: ToolCallBlock renders buffer

**Файл**: `src/ui/ink/components/ToolCallBlock.tsx:49-66`

Компонент отображает:
- Tool calls subagent (lines 51-58)
- Последние 15 строк из lines (line 61)

### Где проблема?

Проблема в **runIsolatedLoop** (subagent.ts:544-556):

```typescript
const summary = createdFiles.length > 0
  ? `[Subagent done — ${createdFiles.length} file(s), ${turns} turns, ${finalTokens} tokens]\nFiles: ${createdFiles.join(', ')}`
  : `[Subagent done — no files, ${turns} turns, ${finalTokens} tokens]`;
```

**Summary не содержит информации о выполненных действиях**. Он содержит только:
- Количество файлов
- Количество ходов
- Количество токенов

Но **не содержит**:
- Какие команды выполнялись
- Какие ошибки возникли
- Что модель пыталась сделать

Дополнительно: в test-agent-conversation.ts renderer — это `createVerboseRenderer()`, который **не имеет метода `writeToolBuffer`**:

```typescript
function createVerboseRenderer() {
  return {
    // ... нет writeToolBuffer!
  } as any;
}
```

Поэтому в тестах **буфер subagent вообще не отображается** — данные теряются.

### Влияние

1. Пользователь не видит прогресс subagent
2. Невозможно диагностировать почему subagent не создал файлы
3. В тестах subagent output полностью скрыт

---

## Взаимосвязи проблем

```
Проблема 1 (bash/pwsh)
  ↓
  Subagent не может выполнить bash-команды
  ↓
  Subagent пробует variations → все падают → 20 ходов, 0 файлов
  ↓
  Результат: "[Subagent done — no files]"
  ↓
Проблема 3 (отображение)
  ↓
  Пользователь не видит что именно падало
  ↓
  Невозможно диагностировать без логов

Проблема 2 (empty responses)
  ↓
  После tool call модель генерирует reasoning, не content
  ↓
  Retry с "Continue." не помогает (тот же контекст)
  ↓
  Агент застревает или прерывается
  ↓
  В kombinacji с Проблемой 1: bash падает + пустой ответ = полная потеря контекста
```

---

## План исправления

### P0: bash fallback на Windows

**Цель**: bash-команды работают на любой Windows машине.

**Изменения**:

1. **`src/tools/bash.ts`** — добавить detection shell и fallback:
   ```typescript
   import { execSync } from 'node:child_process';
   
   function detectShell(): { cmd: string; args: string[] } {
     if (process.platform !== 'win32') {
       return { cmd: 'sh', args: ['-c'] };
     }
     // Попытка 1: pwsh (PowerShell Core)
     try {
       execSync('pwsh --version', { stdio: 'pipe', timeout: 3000 });
       return { cmd: 'pwsh', args: ['-NoProfile', '-EncodedCommand'] };
     } catch {}
     // Попытка 2: powershell.exe (Windows PowerShell)
     try {
       execSync('powershell.exe -Version 5.1', { stdio: 'pipe', timeout: 3000 });
       return { cmd: 'powershell.exe', args: ['-NoProfile', '-EncodedCommand'] };
     } catch {}
     // Попытка 3: cmd.exe
     return { cmd: 'cmd.exe', args: ['/c'] };
   }
   ```
   
   Кэшировать результат detection (один раз при старте).

2. **`src/tools/bash.ts:203`** — использовать detected shell:
   ```typescript
   const shell = detectShell();
   // Для cmd.exe не используем -EncodedCommand
   if (shell.cmd === 'cmd.exe') {
     result = await execa(shell.cmd, [...shell.args, cmd], { ... });
   } else {
     const encoded = encodePowerShellCommand(cmd);
     result = await execa(shell.cmd, [...shell.args, encoded], { ... });
   }
   ```

3. **Логирование**: При первом запуске логировать какой shell используется.

**Верификация**: `npm test` + ручной запуск bash-команд на тестовой машине.

### P1: Увеличение max_tokens для retry

**Цель**: Модель имеет достаточно budget для content после reasoning.

**Изменения**:

1. **`src/agent/loop.ts:333`** — увеличить retries:
   ```typescript
   // Было:
   const { response } = await doChat(provider, messages, renderer!, renderer?.abortSignal, 1, options?.showThinking);
   // Стало:
   const { response } = await doChat(provider, messages, renderer!, renderer?.abortSignal, 2, options?.showThinking);
   ```

2. **`src/tools/subagent.ts:262`** — увеличить max_tokens для subagent после tool call:
   ```typescript
   // После tool call увеличиваем max_tokens
   const isAfterToolCall = messages.some(m => m.role === 'tool');
   const maxTokens = isAfterToolCall ? 24576 : 16384;
   
   for await (const chunk of provider.chat(messages, { 
     temperature: 0.7, signal, showThinking, enableThinking: true,
     max_tokens: maxTokens,
   })) {
   ```

3. **`src/llm/openai-compat.ts`** — убедиться что `max_tokens` передаётся в API:
   ```typescript
   max_tokens: options?.max_tokens ?? defaultMaxTokens,
   ```
   (Уже реализовано, но нужно убедиться что subagent передаёт max_tokens)

**Верификация**: Тесты `test-agent-conversation.ts`, мониторинг `reasoning_chunks vs content_chunks`.

### P2: Улучшение subagent отображения

**Цель**: Пользователь видит что делает subagent.

**Изменения**:

1. **`src/tools/subagent.ts:553-556`** — расширить summary:
   ```typescript
   const actions = messages
     .filter(m => m.role === 'assistant')
     .flatMap(m => {
       const calls = m.content.matchAll(/<tool_call>\{"name":"([^"]+)"/g);
       return [...calls].map(c => c[1]);
     });
   const actionSummary = [...new Set(actions)].join(', ');
   
   const summary = createdFiles.length > 0
     ? `[Subagent done — ${createdFiles.length} file(s), ${turns} turns]\nFiles: ${createdFiles.join(', ')}\nTools used: ${actionSummary}`
     : `[Subagent done — no files, ${turns} turns]\nTools attempted: ${actionSummary}${errors.length > 0 ? `\nErrors: ${errors.join('; ')}` : ''}`;
   ```

2. **`src/tools/subagent.ts:539`** — добавить tool result в буфер:
   ```typescript
   // После выполнения tool call, добавляем результат в renderer
   if (toolExitCode !== 0) {
     renderer.writeError(`  [${parsed.name}] failed: ${toolOutput.slice(0, 200)}`);
   } else {
     renderer.writeSuccess(`  [${parsed.name}] ok`);
   }
   ```

3. **`test-agent-conversation.ts`** — добавить `writeToolBuffer` в mock renderer:
   ```typescript
   function createVerboseRenderer() {
     return {
       // ... существующие методы
       writeToolBuffer: (data: { lines: string[]; toolCalls: any[] }) => {
         if (data.toolCalls.length > 0) {
           process.stdout.write(`  [subagent tools] ${data.toolCalls.map(t => t.name).join(', ')}\n`);
         }
         if (data.lines.length > 0) {
           process.stdout.write(`  [subagent output] ${data.lines.slice(-5).join('\n  ')}\n`);
         }
       },
     } as any;
   }
   ```

**Верификация**: Запуск `test-agent-conversation.ts`, проверка что subagent output виден.

### P3: Subagent fallback на write_file

**Цель**: Subagent создаёт файлы даже когда bash недоступен.

**Изменения**:

1. **`src/tools/subagent.ts:526-536`** — добавить detection bash failure:
   ```typescript
   } else {
     logToolCall('sub:bash', String(cmd).slice(0, 80));
     const bashExecResult = toolExecutor ? await toolExecutor.execute(/* ... */) : null;
     const result = bashExecResult?.result ?? { stdout: '', stderr: 'ToolExecutor not available', exitCode: 1, truncated: false };
     toolOutput = result.stdout || result.stderr || '(no output)';
     toolExitCode = result.exitCode;
     
     // Если bash падает из-за отсутствия shell —提示 модель использовать write_file
     if (toolExitCode !== 0 && /pwsh|powershell|shell/i.test(toolOutput)) {
       toolOutput += '\n\n[HINT] Shell unavailable. Use write_file tool to create files manually instead of bash commands.';
     }
   }
   ```

**Верификация**: Тест `react-todo` и `subagent-test`.

---

## Приоритеты

| Приоритет | Проблема | Влияние | Сложность |
|-----------|----------|---------|-----------|
| P0 | bash fallback | Все bash-команды падают на Windows | Низкая |
| P1 | max_tokens для retry | Пустые ответы после tool calls | Низкая |
| P2 | Subagent отображение | Невозможно диагностировать | Низкая |
| P3 | Subagent fallback | Subagent не адаптируется | Средняя |

**Общая ожидаемая оценка после исправлений**: 5.6 → 7.5-8.0/10
