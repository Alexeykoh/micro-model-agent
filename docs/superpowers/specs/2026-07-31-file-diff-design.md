# 2026-07-31 — Цветной diff для файловых инструментов

## Контекст

При работе с MMA агент хочет видеть, что именно изменилось в файле после `edit_file`, `write_file`, `delete_file` или `move_file`. Текущие инструменты показывают только краткое сообщение ("Replaced in file.ts"), без деталей изменений.

## Решение

Добавить генерацию unified diff с ANSI-цветами для терминала.

### Новый модуль: `src/ui/diff.ts`

Функции:
- `generateDiff(oldContent, newContent)` — unified diff для edit/write (overwrite)
- `generateNewFileDiff(content)` — diff для нового файла (все строки `+`)
- `generateDeleteDiff(content)` — diff для удаления (все строки `-`)
- `generateMoveDiff(from, to)` — diff для перемещения

### Формат вывода

```
  1   import { defineConfig } from 'vitest/config'
  2
  3   export default defineConfig({
  4     test: {
- 5       exclude: ['tests/integration/**', 'node_modules/**'],
+ 5       exclude: ["tests/integration/**", "node_modules/**", "_testing/**"],
  6     },
- 7   })
+ 7   });
```

### Цвета

- `-` строки: красный фон (`picocolors.bgRed`)
- `+` строки: зелёный фон (`picocolors.bgGreen`)
- Контекст: обычный
- `...` (пропущенные строки): серый (`picocolors.dim`)

### Параметры

- Контекст: 3 строки до/после изменений
- Максимум: 100 строк (если больше — обрезается с предупреждением)

### Интеграция

Инструменты возвращают:
```json
{
  "success": true,
  "output": "Replaced in src/utils/helper.ts",
  "diff": "  1   import...\n- 2   ...\n+ 2   ..."
}
```

- `output` — краткое сообщение (без изменений)
- `diff` — полный diff с ANSI-цветами

### Зависимости

- `picocolors` — уже в dependencies (используется в `ui/md-formatter.ts`)
- Внешних библиотек diff не используется (собственная LCS-реализация)

### Тестирование

- Unit-тесты: `tests/ui-diff.test.ts`
- Ручное: запустить MMA, сделать edit, проверить вывод
