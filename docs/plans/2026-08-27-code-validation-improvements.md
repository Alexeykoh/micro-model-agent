# План: Улучшение валидации кода в write_file

## Контекст

При тестировании рефакторинга (монолит → модули) агент (qwen3.5-9b) записывал файлы с ошибками:
- `require()` в TypeScript ES-модулях
- Рекурсивные функции вместо re-export
- Конфликты имён импортов

Все ошибки ловились только **после** записи файла (lint-on-write, LSP). Модель видела "file written", но потом получала ошибки — тратила итерации на исправление.

## Решение

Добавить валидацию **до** записи файла и автоисправление **после** записи.

---

## Задача 1: Pre-validation в write_file

**Файл:** `src/tools/write-file.ts`

**Суть:** Проверять синтаксис файла ДО записи. Если ошибка — НЕ писать файл, вернуть ошибку.

### Что проверять

| Язык | Проверка | Команда |
|------|----------|---------|
| TypeScript (.ts/.tsx/.mts/.cts) | Syntax check | `bun build --no-bundle --target=bun <tmpfile>` |
| JavaScript (.js/.jsx/.mjs/.cjs) | Syntax check | `node --check <tmpfile>` |
| JSON (.json) | Parse check | `JSON.parse()` |
| Python (.py) | Syntax check | `python -m py_compile <tmpfile>` |

### Алгоритм

```
1. Определить язык по расширению
2. Если поддерживается — записать во временный файл
3. Запустить syntax check
4. Если ошибка — вернуть success:false с ошибкой, НЕ писать оригинальный файл
5. Если ок — писать оригинальный файл
6. Удалить временный файл
```

### Важно

- Временный файл = `<resolved>.tmp.<ext>` (рядом с оригиналом)
- Таймаут: 5 секунд
- Не блокировать на ошибках линтера — только синтаксис
- Кэшировать результаты (content hash) чтобы не проверять одинаковый код

### Псевдокод

```typescript
async function preValidateSyntax(resolved: string, content: string): Promise<{ valid: boolean; error?: string }> {
  const ext = extname(resolved);
  
  // JSON — проверяем парсинг
  if (ext === '.json') {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }
  
  // TypeScript/JavaScript — проверяем через компилятор
  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const tmpFile = `${resolved}.tmp${ext}`;
    try {
      writeFileSync(tmpFile, content, 'utf-8');
      
      const isTs = ['.ts', '.tsx', '.mts', '.cts'].includes(ext);
      const cmd = isTs 
        ? `bun build --no-bundle --target=bun "${tmpFile}"`
        : `node --check "${tmpFile}"`;
      
      const result = await runAsync(cmd, dirname(resolved), 5000);
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e.message };
    } finally {
      // Удалить временный файл
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    }
  }
  
  // Для остальных языков — пропускаем
  return { valid: true };
}
```

### Интеграция в write_file

```typescript
// Перед writeFileSync
const validation = await preValidateSyntax(resolved, content);
if (!validation.valid) {
  return {
    success: false,
    output: t("file.syntax_error", { path, error: validation.error }),
  };
}
```

### i18n

Добавить ключ `file.syntax_error`:
- en: `"Syntax error in {path}: {error}"`
- ru: `"Синтаксическая ошибка в {path}: {error}"`

---

## Задача 2: Auto-fix в lint-on-write

**Файл:** `src/modules/plugins/builtin/lint-on-write.ts`

**Суть:** Когда LSP находит ошибки — пытаться исправить автоматически.

### Что исправлять автоматически

| Тип ошибки | Как исправить |
|------------|---------------|
| Missing import (TS2307) | Добавить import |
| Import conflict (TS2440) | Переименовать import через `as` |
| Unused import (TS6133) | Удалить import |
| Type mismatch (简单) | Подставить правильный тип |

### Что НЕ исправлять

- Логические ошибки
- Ошибки в runtime поведении
- Сложные refactorings

### Алгоритм

```
1. LSP находит ошибки
2. Для каждой ошибки:
   a. Парсим错误信息 (file, line, col, message, code)
   b. Если错误代码 в списке автоисправимых:
      - Читаем файл
      - Применяем паттерн-замену
      - Проверяем через LSP
      - Если ошибок нет — применяем
      - Если есть — откатываем
   c. Если не автоисправима — пропускаем
3. Возвращаем список исправлений
```

### Паттерны автоисправления

#### 1. Import conflict (TS2440)
```typescript
// Было:
import { validateDiscountCode } from './discountCodes';
export function validateDiscountCode() { ... }

// Стало:
import { validateDiscountCode as isDiscountCodeValid } from './discountCodes';
export function validateDiscountCode() { ... }
```

Паттерн:
```
Ошибка: "Import declaration conflicts with local declaration of 'X'"
Действие: Добавить `as XLocal` к импорту
```

#### 2. Unused import (TS6133)
```typescript
// Было:
import { foo, bar } from './module';

// Стало:
import { bar } from './module';
```

Паттерн:
```
Ошибка: "'X' is declared but its value is never read"
Действие: Удалить X из списка импортов
```

#### 3. Missing module (TS2307)
```typescript
// Было:
import { foo } from './nonexistent';

// Стало: Ничего — это логическая ошибка
```

**Не исправляем** — требует создания файла или изменения архитектуры.

### Реализация

```typescript
interface AutoFix {
  pattern: RegExp;
  fix: (match: RegExpMatchArray, content: string) => string | null;
  description: string;
}

const AUTO_FIXES: AutoFix[] = [
  {
    // Import conflict
    pattern: /Import declaration conflicts with local declaration of '(\w+)'/,
    fix: (match, content) => {
      const name = match[1];
      // Найти import с этим именем и добавить alias
      const importRegex = new RegExp(`import\\s*\\{([^}]*\\b${name}\\b[^}]*)\\}\\s*from`);
      return content.replace(importRegex, (m, imports) => {
        const newImports = imports.replace(
          new RegExp(`\\b${name}\\b`),
          `${name} as ${name}Local`
        );
        return m.replace(imports, newImports);
      });
    },
    description: "Rename conflicting import"
  },
  {
    // Unused import
    pattern: /'(\w+)' is declared but its value is never read/,
    fix: (match, content) => {
      const name = match[1];
      // Удалить из import
      const importRegex = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from`);
      return content.replace(importRegex, (m, imports) => {
        const parts = imports.split(',').map(s => s.trim()).filter(s => s !== name);
        return m.replace(imports, parts.join(', '));
      });
    },
    description: "Remove unused import"
  }
];
```

### Интеграция в lint-on-write

После Stage 3 (project typecheck):
```typescript
// Если есть ошибки — пытаемся исправить
if (errors.length > 0) {
  const fixes = await tryAutoFix(filePath, content, errors);
  if (fixes.applied.length > 0) {
    // Записать исправленный файл
    writeFileSync(filePath, fixes.newContent, 'utf-8');
    // Добавить информацию об исправлениях
    result.output += `\n[Auto-fixed]: ${fixes.applied.join(', ')}`;
  }
}
```

---

## Задача 3: Import conflict detection

**Файл:** `src/tools/write-file.ts` (расширить)

**Суть:** При записи файла проверять конфликты имён с существующими экспортами.

### Алгоритм

```
1. Парсим импорты из записываемого файла
2. Для каждого импорта:
   a. Определяем имя (or alias)
   b. Проверяем, нет ли в этом же файле export с таким именем
   c. Если есть — конфликт
3. Если конфликт — вернуть warning (не error, т.к. код может быть валидным)
```

### Реализация

```typescript
function detectImportConflicts(content: string): string[] {
  const conflicts: string[] = [];
  
  // Извлечь все импорты
  const importRegex = /import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+))\s+from/g;
  const exportRegex = /export\s+(?:function|class|const|let|var|type|interface)\s+(\w+)/g;
  
  const imports = new Set<string>();
  const exports = new Set<string>();
  
  let match;
  while ((match = importRegex.exec(content))) {
    const names = match[1] ? match[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]) : [match[2]];
    names.forEach(n => imports.add(n));
  }
  
  while ((match = exportRegex.exec(content))) {
    exports.add(match[1]);
  }
  
  // Проверить конфликты
  for (const name of imports) {
    if (exports.has(name)) {
      conflicts.push(name);
    }
  }
  
  return conflicts;
}
```

### Интеграция

В `write_file` после валидации синтаксиса:
```typescript
const conflicts = detectImportConflicts(content);
if (conflicts.length > 0) {
  // Warning, не error — код может быть валидным
  result.output += `\n[WARNING] Import conflicts detected: ${conflicts.join(', ')}`;
}
```

---

## Задача 4: Тестирование

### Тест-кейсы

1. **Pre-validation:**
   - Записать валидный TypeScript → успех
   - Записать TypeScript с синтаксической ошибкой → ошибка, файл НЕ записан
   - Записать JSON с ошибкой парсинга → ошибка, файл НЕ записан
   - Записать JavaScript с ошибкой → ошибка, файл НЕ записан

2. **Auto-fix:**
   - Import conflict → автоисправление через `as`
   - Unused import → удаление
   - Сложная ошибка → нет автоисправления

3. **Import conflict detection:**
   - Файл с export и import одного имени → warning
   - Файл без конфликтов → нет warning

### Запуск тестов

```bash
bun test tests/write-file.test.ts
bun test tests/lint-on-write.test.ts
```

---

## Приоритеты

| Задача | Приоритет | Сложность | Время |
|--------|-----------|-----------|-------|
| Pre-validation | Высокий | Средняя | 2-3 часа |
| Auto-fix | Средний | Высокая | 4-6 часов |
| Import conflict | Низкий | Низкая | 1-2 часа |

## Зависимости

- Pre-validation не зависит от других задач
- Auto-fix зависит от LSP модуля
- Import conflict detection можно делать параллельно

## Риски

1. **Pre-validation может замедлить запись** — решается кэшированием и таймаутами
2. **Auto-fix может сломать код** — решается проверкой через LSP после исправления
3. **Import conflict detection может давать false positives** — решается warning вместо error
