# LSP: как проверить, что сервер реально работает

Три слоя, у каждого свой ответ. Проверять **по порядку**: сервер → mma → агент.

| Слой | Чем проверяется | Что доказывает |
|---|---|---|
| Сервер | `lsp-raw.mjs` (ниже) или `/lsp doctor` | процесс стартует, отвечает на `initialize`, отдаёт диагностику |
| mma | `/lsp doctor` (корень + stderr), `/lsp status` (тёплые соединения), вкладка LSP | mma умеет поднять сервер и держать его в пуле |
| Агент/панель | `/lsp check <файл>`, выбор файла в `mma web`, `lsp_check` модели | проверка доходит до файла и возвращает результат либо явную причину |

## 1. Сервер отвечает сам по себе

`/lsp doctor` печатает по строке на **(сервер × корень проекта)**: время,
класс причины, первые строки stderr. Если строка `ok` — процесс стартует и
`initialize` отвечает. Если `ok` только на корне `baseDir`, а файл лежит в
подпроекте (`my-app`), это ничего не доказывает: `initialize` у подпроекта
другой (у него свой `tsconfig`/`node_modules`). Смотри строку именно с нужным
корнем.

Полная независимая проверка (без mma) — сохранить как `lsp-raw.mjs` и запустить
`node lsp-raw.mjs <файл> npx --yes --package typescript-language-server --package typescript@5 typescript-language-server --stdio`:

```js
// lsp-raw.mjs — рукопожатие LSP и первые диагностики. node lsp-raw.mjs <file> <cmd> [args...]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const [file, command, ...args] = process.argv.slice(2);
const abs = resolve(file);
const uri = "file:///" + abs.replace(/\\/g, "/");
const child = spawn(command, args, { cwd: process.cwd(), shell: process.platform === "win32" });
let buf = Buffer.alloc(0), stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });
const send = (m) => { const b = JSON.stringify(m); child.stdin.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`); };
const t0 = Date.now();
let inited = false;
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: process.pid, rootUri: "file:///" + process.cwd().replace(/\\/g, "/"), workspaceFolders: null, capabilities: {} } });
child.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const h = buf.indexOf("\r\n\r\n");
    if (h < 0) return;
    const len = Number((/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, h).toString()) || [])[1]);
    if (!Number.isFinite(len)) { buf = buf.subarray(h + 4); continue; }
    if (buf.length < h + 4 + len) return;
    const msg = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString());
    buf = buf.subarray(h + 4 + len);
    if (msg.id === 1) {
      console.log(`initialize ok in ${Date.now() - t0}ms`);
      inited = true;
      send({ jsonrpc: "2.0", method: "initialized", params: {} });
      send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "typescript", version: 1, text: readFileSync(abs, "utf8") } } });
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      console.log(`diagnostics in ${Date.now() - t0}ms: ${msg.params.diagnostics.length}`);
      for (const d of msg.params.diagnostics.slice(0, 3)) console.log(`  ${(d.range.start.line ?? 0) + 1}:${(d.range.start.character ?? 0) + 1} ${d.message}`);
      child.kill(); process.exit(0);
    }
  }
});
setTimeout(() => {
  console.log(inited ? "initialize ok, but no diagnostics in 10s (project is still loading?)" : "NO initialize response in 10s");
  if (stderr) console.log("stderr:\n" + stderr.slice(0, 2000));
  child.kill(); process.exit(inited ? 2 : 1);
}, 10000);
```

Чтение результата:

- `initialize ok` + диагностики → сервер рабочий; если mma при этом ругается,
  проблема в mma (корень/конфиг/пауза), а не в сервере.
- `initialize ok`, но диагностик нет за 10 с → сервер грузит проект; это не
  «сломан», а «медленно» (большой Angular/Next).
- нет `initialize` → смотреть stderr: несовместимый Node, нет `typescript`,
  npx не может скачать пакет, битый конфиг.

## 2. mma поднял сервер

- `/lsp status` печатает **тёплые соединения**: `server · корень · возраст`.
  Пусто — пул холодный (прогрев не дошёл или сервер упал).
- `~/.mma/sessions/<id>/app.jsonl` (уровень `info`):
  `LSP warm start: …`, `LSP ready: … in Nms`, `LSP warm failed: … — причина`,
  `LSP check <file> in Nms (N diagnostic(s))`, `LSP check skipped: … still starting`.
- вкладка LSP: строка `проверить` и статус серверов (тот же doctor).

## 3. Агент/панель дошли до файла

- `/lsp check <файл>` — текст для модели: `Проверено файлов: N`, `[LSP errors]`,
  `[LSP check failed for …]` (с причиной и stderr), либо `[lsp_check … ещё
  запускается]`.
- `mma web` → вкладка LSP → выбрать файл: показывается `сервер запускается…`
  (панель сама повторяет запрос до минуты), затем диагностики, `нет ошибок`,
  `для этого типа файла нет LSP-сервера` или причина отказа.

## Почему «тут быстро, а там не поднимается»

Проверять по списку (сверху — самые частые):

1. **Размер проекта.** `initialize` у Angular 11 / Next.js монорепо — 15–60 с,
   у маленького репозитория — доли секунды. Быстро/медленно — это про проект, а
   не про mma.
2. **Первый запуск `npx`.** Пока пакет не в кеше, `npx --yes --package …`
   качает его с реестра. В корпоративной сети с self-signed сертификатом это
   может занимать десятки секунд или падать. Прогрев на старте убирает этот
   эффект только после первого успешного скачивания.
3. **Node.** `typescript-language-server` 4.x требует Node 18+, 5.x — 20+,
   6.x — 22.22+; `yaml-language-server` 2.x — 22.13+. На старом Node сервер
   падает сразу после старта (`SyntaxError`/`ERR_REQUIRE_ESM`) — doctor покажет
   `Node too old for this server` и stderr.
4. **Корень проекта.** Для файла корень = ближайший каталог с
   `package.json`/`tsconfig.json`. Если в нём нет `node_modules` (монорепо с
   hoisting), TS-сервер может не найти `typescript`. `doctor` теперь печатает
   корень в каждой строке — сравни его с каталогом, где реально лежит
   `node_modules`.
5. **PATH и глобальный бинарник.** `resolveNpxLaunch` предпочитает глобальный
   бинарник, если он есть в PATH. Установленный под другой Node (nvm/volta) он
   будет падать — сверь `where typescript-language-server`, `npm prefix -g`,
   `where npx`.
6. **Антивирус/диск.** Первый `initialize` на Windows с Defender может
   добавить секунды; повторный — уже нет.
7. **Пауза восстановления.** После 3 падений сервер ждёт 2→4→…→60 с;
   `/lsp status` показывает остаток, `doctor` — причину падения.

## Если сервер работает, а агент «не видит»

Признаки: `doctor` — ok на нужном корне, `lsp-raw.mjs` — даёт диагностику, а
`/lsp check` пишет «ещё запускается»/«failed».

- `/lsp status` пуст → пул не получил соединение (смотри `app.jsonl`).
- `LSP warm failed … — <причина>` → корень другой, конфиг сервера сломан или
  сервер упал именно на этом корне.
- `LSP check skipped … still starting` → не уложился в бюджет; повторный вызов
  (или панель) дождётся.

Это уже история mma, а не сервера; в отчёте всегда есть причина и корень.
