# `document_read` на PDF: источник байтов отдаёт `Buffer`, а pdfjs ждёт `Uint8Array`

_Дата: 2026-11-01. Ветка: `fix/document-read-pdf`. Статус: реализуется._

## 1. Что наблюдается

Живой прогон `mma web` на песочнице, `document_read` по реальному `.pdf`:

```
documents.error: Please provide binary data as `Uint8Array`, rather than `Buffer`.
```

DOCX/XLSX/ODT/ODP с тем же путём чтения работают, потому что их читатели
принимают `Uint8Array`-совместимые данные; падает именно PDF.

## 2. Причина

- `src/modules/documents/source.ts` (`fileSource`) читает файл через
  `readFile()` из `node:fs/promises`, который возвращает **Node `Buffer`**.
- Контракт `DocSource.bytes(): Promise<Uint8Array>` это пропускает: `Buffer` —
  подкласс `Uint8Array`, поэтому typecheck молчит, а в рантайме значение
  остаётся `Buffer`.
- `src/modules/documents/handlers/pdf.ts` делает `bytes.slice()` перед
  `getDocument`. У `Buffer` `slice()` переопределён и возвращает **вид-Buffer**,
  а не `Uint8Array`, поэтому `Buffer` доезжает до pdfjs.
- `pdfjs-dist@6.4.299` в `getDataProp()` (legacy build, строка ~14792) делает
  проверку `val instanceof Buffer` и бросает исключение:
  `Please provide binary data as `Uint8Array`, rather than `Buffer`.`
  Это осознанное требование библиотеки, а не наш дефект формата.

То есть контракт «источник отдаёт `Uint8Array`» нарушается на границе чтения
файла, а PDF-обработчик лишь первым на это наткнулся.

## 3. Контракт

### 3.1 `DocSource.bytes()` отдаёт настоящий `Uint8Array`

`fileSource()` обязан возвращать значение, у которого
`Buffer.isBuffer(value) === false` и которое является `Uint8Array` с теми же
байтами и той же длиной.

- Допустимое представление — **вид без копии**:
  `new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)`. Длина файла не
  удваивается в памяти, `byteOffset`/`byteLength` сохраняются (это важно:
  небольшие файлы Bun/Node отдают из пула, где `byteOffset > 0`).
- Потребители внутри модуля уже корректно работают с `byteOffset`
  (`readZip` строит `DataView` с offset) — менять их не нужно.
- Кэш промиса (`bytes()` читает файл ровно один раз на разбор) сохраняется.

### 3.2 PDF-обработчик нормализует вход сам

`pdf.ts` не должен зависеть от того, `Buffer` пришёл или `Uint8Array`:
вместо `bytes.slice()` — `new Uint8Array(bytes)`.

Это одновременно:

1. копия, которая нужна, потому что pdfjs забирает (detach) переданный буфер,
   а исходные байты обязаны остаться валидными для вызывающей стороны;
2. нормализация типа: `new Uint8Array(buffer)` всегда даёт обычный
   `Uint8Array`, даже если аргумент — `Buffer` (тогда `.slice()` вернул бы
   `Buffer` снова).

### 3.3 Чего контракт не делает

- Не меняет лимиты размера документа и не добавляет новых.
- Не трогает другие обработчики (DOCX/XLSX/ODT/ODP/CSV…) — они получают
  исправленный источник автоматически, их код не правится.
- Не обновляет `pdfjs-dist` и не подменяет его API.

## 4. Не-цели

- Отдельная задача «кап размера документа при чтении» (сейчас лимита нет).
- Остальные форматы и их live-проверки — отдельные задачи, если найдутся.

## 5. Тесты

| Файл | Что держит |
|---|---|
| `tests/documents/source-bytes.test.ts` | `fileSource(...).bytes()` — не `Buffer`, а `Uint8Array` с байтами и длиной файла; повторный вызов отдаёт тот же промис (одно чтение) |
| `tests/documents/source-bytes.test.ts` | сквозной путь: настоящий `.pdf` на диске → `registry.parse` → текст `Hello` (этот тест падает до правки с ошибкой pdfjs про `Buffer`) |
| `tests/documents/handlers-pdf.test.ts` | существующие кейсы PDF (текст, скан, многостраничный, закладки, `MAX_PAGES`, битый файл) не ломаются |

## 6. План

1. Спека.
2. Тест `tests/documents/source-bytes.test.ts` — прогнать и зафиксировать падение
   до правки.
3. `source.ts`: `readFile` → вид `Uint8Array` без копии.
4. `pdf.ts`: `new Uint8Array(bytes)` вместо `bytes.slice()`.
5. `bun test` + `bun run quality`; живой прогон `document_read` по `.pdf`.
