# Анализ проблемы пустых ответов Qwen3.5

**Дата**: 2026-07-21  
**Модель**: qwen/qwen3.5-9b (reasoning model)  
**Контекст**: 32768 токенов

---

## Диагностика

### Паттерн из логов

| finish_reason | reasoning_chunks | content_chunks | Частота | Интерпретация |
|---------------|------------------|----------------|---------|---------------|
| `unknown` | 0 | 0 | 6 раз | Пустой ответ при загрузке system prompt |
| `stop` | 15-499 | 0 | 25 раз | **Основная проблема** |
| `length` | N | 0 | 0 раз | Не обрезается по max_tokens |

### Ключевое наблюдение

**`finish_reason=stop` + `content_chunks=0`** означает:
- Модель **добровольно** завершила генерацию (не обрезана по `max_tokens`)
- Модель **потратила весь budget на reasoning** и не переключилась на content phase
- Это **НЕ проблема max_tokens** — это проблема поведения модели

### Механизм Qwen3.5 с `enable_thinking: true`

```
Запрос → [reasoning phase] → [content phase] → ответ
         reasoning_content    content
```

Проблема: модель завершает reasoning, но **не начинает content phase**.

Причины:
1. **Reasoning exhausted budget**: Модель генерирует 200-500 reasoning chunks, затем `finish_reason=stop` — она "думает" что закончила
2. **Context overload**: При длинном контексте (15+ сообщений) модель тратит больше reasoning на анализ
3. **Tool result complexity**: Сложные результаты инструментов (ошибки, длинные выводы) увеличивают reasoning

---

## Варианты решений

### Решение A: Retry с `enable_thinking: false`

**Идея**: При пустом ответе с reasoning chunks, повторить запрос с отключенным thinking.

**Реализация**:
```typescript
// В doChat, при обнаружении пустого ответа с reasoning chunks:
if (reasoningChunksCount > 0 && contentChunksCount === 0) {
  // Повторный запрос без thinking — модель генерирует content напрямую
  const retryOptions = { ...chatOptions, enableThinking: false };
  // ... повторный вызов provider.chat с retryOptions
}
```

**Плюсы**:
- Garantirovanno генерирует content (без thinking модель не "застревает")
- Низкая задержка (один повторный запрос)
- Не влияет на качество reasoning для успешных запросов

**Минусы**:
- Теряется качество reasoning для сложных задач
- Двойной запрос к API при пустом ответе

**Оценка**: ★★★★☆ — наиболее practical решение

---

### Решение B: Увеличение `max_tokens` до 32768

**Идея**: Дать модели больше budget для обеих фаз (reasoning + content).

**Реализация**:
```typescript
// В openai-compat.ts:
const defaultMaxTokens = reasoning ? 32768 : 4096;
```

**Плюсы**:
- Простое изменение (одна строка)
- Модель имеет больше room для reasoning И content

**Минусы**:
- **Не решает проблему**: `finish_reason=stop` означает что модель не обрезана по max_tokens
- Увеличивает latency (модель генерирует больше reasoning)
- Увеличивает cost

**Оценка**: ★★☆☆☆ — не решает корневую причину

---

### Решение C: Отключение thinking по умолчанию

**Идея**: Не включать `enable_thinking: true`除非 explicitly requested.

**Реализация**:
```typescript
// В openai-compat.ts:
// Было:
if (options?.enableThinking && reasoning) {
  body.chat_template_kwargs = { enable_thinking: true };
}
// Стало:
// Не включаем thinking по умолчанию — только по запросу
```

**Плюсы**:
- Устраняет проблему для большинства запросов
- Модель генерирует content напрямую (без reasoning phase)

**Минусы**:
- Теряется качество reasoning для сложных задач
- Модель может хуже справляться с multi-step планированием

**Оценка**: ★★★☆☆ — good for simple tasks, bad for complex

---

### Решение D: Пост-обработка reasoning как content

**Идея**: Если reasoning chunks > 0 а content chunks = 0, использовать reasoning как content.

**Реализация**:
```typescript
// В doChat:
const response = fullText.join('');
if (!response.trim() && reasoningChunksCount > 0) {
  // Используем reasoning как fallback content
  const reasoningText = reasoningBuf || '';
  if (reasoningText.trim()) {
    return { response: reasoningText, genTimeMs };
  }
}
```

**Плюсы**:
- Никогда не теряет output модели
- Простая реализация

**Минусы**:
- Reasoning может содержать internal thoughts (не для пользователя)
- Формат reasoning отличается от content (другой стиль)

**Оценка**: ★★★☆☆ — emergency fallback, не для regular use

---

### Решение E: Уменьшение system prompt

**Идея**: Уменьшить размер system prompt чтобы модель тратила меньше reasoning на анализ.

**Реализация**:
- Сократить правила (было 16 → оставить 8-10)
- Убрать примеры из system prompt (оставить только формат)
- Использовать compressed skills

**Плюсы**:
- Уменьшает context usage
- Модель тратит меньше reasoning на анализ system prompt

**Минусы**:
- Теряется guidance для модели
- Может ухудшить качество ответов

**Оценка**: ★★☆☆☆ — risky, может сломать поведение

---

### Решение F: Комбинированное (A + D)

**Идея**: Использовать retry с `enableThinking: false` как primary, и post-processing reasoning как emergency fallback.

**Реализация**:
```typescript
// 1. Основной запрос с thinking
const { response } = await doChat(provider, messages, renderer, signal, 2, showThinking, caller);

// 2. Если response пустой и есть reasoning chunks — retry без thinking
if (!response && reasoningChunksCount > 0) {
  const retryResult = await doChat(provider, messages, renderer, signal, 1, false, caller, { enableThinking: false });
  if (retryResult.response) return retryResult;
}

// 3. Если всё ещё пустой — используем reasoning как fallback
if (!response && reasoningText) {
  return { response: `[Reasoning output]: ${reasoningText}`, genTimeMs };
}
```

**Плюсы**:
- Triple fallback: thinking → no-thinking → reasoning
- Maximizes chance of getting content
- Graceful degradation

**Минусы**:
- Сложнее в реализации
- Может увеличить latency при fallback

**Оценка**: ★★★★★ — most robust solution

---

## Рекомендация

**Решение F (комбинированное)** — наиболее robust подход:

1. **Primary**: Retry с `enableThinking: false` при пустом ответе с reasoning chunks
2. **Fallback**: Использование reasoning как emergency content
3. **Дополнительно**: Опциональное увеличение max_tokens до 24576 (уже реализовано для subagent)

### Приоритеты реализации

| Приоритет | Решение | Сложность | Ожидаемый эффект |
|-----------|---------|-----------|------------------|
| P0 | F: Retry с enableThinking=false | Низкая | 80% reduction пустых ответов |
| P1 | D: Reasoning как fallback | Низкая | Emergency safety net |
| P2 | B: max_tokens=32768 | Низкая | marginal improvement |

---

## Тестирование

После реализации проверить:
1. Запустить `test-agent-conversation.ts --scenario code`
2. Мониторить `reasoning_chunks vs content_chunks` в логах
3. Убедиться что retry с `enableThinking: false` срабатывает
4. Проверить что content генерируется после retry
