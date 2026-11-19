# LSP pool recovery после конца сессии / аборта хода

_Дата: 2026-11-01. Ветка: `fix/lsp-pool-recovery`. Статус: реализуется._

## 1. Что наблюдается

Живой прогон `mma web` на песочнице:

- **Свежий процесс:** `lsp_check` на `src/ts/broken.ts` работает — 5.6 с,
  реальная диагностика `Type 'number' is not assignable to type 'string'`.
- **После зависшего/остановленного хода** (UI показал «остановлено», в
  `session.jsonl` нет `llm_usage` и tool-call'ов) следующий `lsp_check` в новом
  чате того же процесса:

  ```
  [LSP check failed for ...src/ts/broken.ts: LSP pool disposed]
  ```

- Вкладка LSP остаётся в состоянии «проверяется…» навсегда.

То есть LSP сам по себе исправен; ломается **состояние пула** после завершения
сессии/аборта.

## 2. Причина

- `src/modules/lsp/module.ts` (`getPlugin().onSessionEnd`) вызывает
  `this.client.close()`.
- `src/modules/lsp/client.ts` (`close()`) вызывает `pool.dispose()`.
- `src/modules/lsp/pool.ts` (`dispose()`) ставит терминальный `disposed = true`
  и очищает соединения; `acquire()` при `disposed` создаёт соединение, сразу
  гасит его и бросает `Error("LSP pool disposed")`.
- `LspClient.poolInstance` остаётся ссылкой на уже disposed пул; следующий
  `lsp_check`/`warmup`/`diagnose` использует его и падает. Пересоздания пула нет.
- `src/modules/webui/lsp/lsp-api.ts` (`handleLspDoctorPost`) держит
  `lspProbing = true`, пока `diagnose()` не завершится. Если проба зависла на
  disposed пуле, `finally` не наступает, и UI навсегда показывает «проверяется…».

## 3. Контракт

### 3.1 `LspClient.close()` — граница жизни, а не терминальное состояние

`close()` закрывает текущие соединения и **оставляет клиент пригодным к
дальнейшей работе**. Следующий `checkFile`/`warmup`/`diagnose`/`stats` создаёт
новый пул.

```ts
// client.ts
async close(): Promise<void> {
  const pool = this.poolInstance;
  this.poolInstance = null;
  if (pool) await pool.dispose();
}
```

- `LspConnectionPool.dispose()` остаётся терминальным: прямой пользователь пула
  после `dispose()` не должен получать живое соединение. Пересоздание — забота
  `LspClient`, а не пула.
- Для тестов добавляется `LspClientDeps.poolFactory?: () => LspConnectionPool`.
  `pool` (готовая инстанция) остаётся для обратной совместимости, но
  `poolFactory` позволяет проверить, что после `close()` создаётся **новый** пул.

### 3.2 `onSessionEnd` может закрывать пул

`LspModule.getPlugin().onSessionEnd` остаётся: конец сессии вправе освободить
тёплые соединения. Важно, чтобы это не отравляло общий модуль: следующий ход
поднимает новый пул лениво.

### 3.3 Проба LSP не висит вечно

`POST /api/lsp/doctor` уже ограничена `LSP_DOCTOR_DEADLINE_MS` (45 с) и снимает
`lspProbing` в `finally`. Живой прогон после фикса пула подтвердил: вкладка LSP
завершает пробу за ~45 с и показывает `5/7 ok`; вечного «проверяется…» больше нет.
Новый таймаут в этой ветке не добавляется. Если проба когда-нибудь превысит
дедлайн — это отдельный дефект `diagnose()`/SSE, а не пула.

## 4. Не-цели

- PDF parser (`Buffer` vs `Uint8Array`) — отдельная задача.
- Зависший ход/обрыв provider stream — отдельная задача; здесь только
  последствие для LSP-пула.
- Изменение warmup/диагностик LSP-серверов и UI-дедлайна (45 с — штатный).

## 5. Тесты

| Файл | Что держит |
|---|---|
| `tests/modules/lsp/pool-recovery.test.ts` | `LspClient` после `close()` создаёт новый пул (`poolFactory` вызван дважды, старый `dispose` вызван один раз); следующий `checkFile` работает |
| `tests/modules/lsp/pool-recovery.test.ts` | повторный `close()` идемпотентен, второй пул не создаётся без обращения |
| существующие `tests/modules/lsp/*` | не ломаются: connection-kill, stderr-drain, version-skew, check-honesty, check-cold-start |

## 6. План

1. `LspClient`: `poolFactory`, `close()` с обнулением `poolInstance`; тест
   пересоздания пула.
2. `bun test` + `bun run quality`; живой прогон: LSP → закрыть сессию/аборт →
   новый чат → `lsp_check` снова работает.
