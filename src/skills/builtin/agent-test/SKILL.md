# Agent Test — тестирование MMA агента

Навык для автоматизированного тестирования ответов MMA агента на разных сценариях.

## Запуск

```bash
# Все сценарии
bun run test-agent-conversation.ts

# Один сценарий
bun run test-agent-conversation.ts --scenario chat

# Список сценариев
bun run test-agent-conversation.ts --list
```

## Добавление нового сценария

Отредактируй `test-agent-conversation.ts`, секция `SCENARIOS`:

```ts
{
  name: 'my-new-scenario',          // уникальное имя
  description: 'Описание что тестируем',
  prompts: [
    'Промпт 1',
    'Промпт 2',
    'Промпт 3',
  ],
},
```

Затем запусти: `bun run test-agent-conversation.ts --scenario my-new-scenario`

## Текущие сценарии

| Имя | Описание | Промптов |
|-----|----------|----------|
| chat | Простая беседа | 8 |
| read | Чтение файлов | 3 |
| code | Написание кода | 3 |
| project | Микро-проект из 5 файлов | 1 |
| topics | Смена тем | 4 |

## Что проверяется автоматически

- **Пустые ответы** — модель не ответила
- **User profile** — модель упомянула профиль пользователя (запрещено)
- **Tool calls** — какие инструменты были использованы
- **Длина ответов** — min/max/avg

## Настройка через env

```bash
MMA_LLM_URL=http://localhost:1234/v1    # URL LLM сервера
MMA_LLM_MODEL=qwen/qwen3.5-9b          # Модель
MMA_CTX=32768                           # Размер контекста
```

## Структура

```
test-agent-conversation.ts   — основной скрипт (все сценарии + анализ)
test-llm-direct.ts           — прямой вызов LLM (для отладки)
test-compare.ts              — сравнение direct fetch vs provider
test-thinking.ts             — тест thinking/reasoning модели
```
