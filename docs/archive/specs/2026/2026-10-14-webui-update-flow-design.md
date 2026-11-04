# Update/install flow в web: прогресс, синхронизация, закрытие

Дата: 2026-10-14
Статус: approved
Ветка: `fix/webui-update-flow`

## 1. Проблема

Кнопка «Update» в вебе ставила релиз по `POST /api/update`, который вызывал
`WebUiState.updaterInstall = () => updater.getUpdater().install()` — **напрямую
`Updater.install()`, минуя `UpdaterModule`**. Последствия (из репорта):

1. **Нет прогресса.** Ни в web, ни в консоли процесса `mma web` не видно, что
   происходит после нажатия: `install()` качает десятки-сотни МБ молча.
2. **Кнопки не синхронизированы.** Установка из Settings не гасит кнопку в
   карточке пустого экрана (и наоборот); результат — только тост.
3. **Карточку нельзя закрыть.** `upd-card` в пустом экране без dismiss, при
   каждом `showEmptyFeed()` пересоздаётся.
4. **Чат замирал.** `renderActiveState` при смене факта апдейта делал
   `if (document.querySelector("#msgs .empty")) showEmptyFeed()`. Селектор ловил
   и `.empty` внутри `.feed` открытой вкладки → `msgs.replaceChildren(...)`
   отвязывал ленту вкладки, и новые сообщения/ответы писались в отсоединённый
   узел (не видны). Это и есть «чат не обновляется при открытом предупреждении».

## 2. Изменения

### 2.1 Апдейтер (server)

- `install-release.ts`: `installRelease(opts, onProgress?)` и
  `downloadFile(..., onProgress?)` отдают фазы `download` (с `received`/`total`
  по `content-length`, скачивание потоком), `verify`, `extract`, `activate`.
- `checker.ts`: `Updater.install(onProgress?)` прокидывает колбэк.
- `module.ts`: `UpdaterModule.installNow(): Promise<InstallResult>` — единая
  ручная установка: логирует `updater.installing` (в stdout процесса через
  `busLogger`), шлёт `notice {phase:"installing", progress}` и финальный
  `installed`/`failed`. `UpdatePhase` расширен `installing`; `UpdateNotice`
  получил `progress?: InstallProgress`.
- `web-command.ts`: `state.updaterInstall = () => updater.installNow()`; клирит
  чип апдейта только на `installed` (на `failed` обновление всё ещё доступно).

### 2.2 SSE `update` (формат)

Событие теперь несёт фазы `available | installing | installed | failed` и, для
`installing`, `progress: {phase, received?, total?}`. Добавление полей —
обратно совместимое расширение (старые клиенты игнорируют).

### 2.3 Фронтенд

- `app.ts`:
  - `installing` → метка/disabled всех `.upd-btn` (обе поверхности) = текст
    прогресса (`downloading 42% · 3.1 MB/7.4 MB`, `verifying…`, …);
  - `failed` → вернуть метку, MMART = error;
  - `installed` → вернуть метку, `renderSettings()` + `showEmptyFeed()`, чтобы
    кнопки ушли сразу (сервер ещё и чистит `updateAvailable`);
  - гард перестроения пустого экрана — `#msgs > .empty` (только верхнеуровневый
    empty, не `.empty` внутри ленты вкладки).
- `update-state.ts`: флаг `dismissed` (+`dismissUpdate`/`isUpdateDismissed`);
  повторный тот же факт апдейта снова показывает карточку.
- `feed/core.ts`: у `upd-card` кнопка ✕ (`web.update.dismiss`); `emptyView`
  не рисует карточку при `dismissed`.
- i18n: `web.update.dismiss`, `web.update.downloading[_pct]`,
  `web.update.stage_{verify,extract,activate}` (en+ru).

## 3. Приёмка

- `tests/updater-module.test.ts`: `installNow` логирует и шлёт
  `installing`→`installed`; прогресс-фазы доходят до `onNotice`.
- `tests/updater-checker.test.ts`: `downloadFile` отдаёт прогресс и корректно
  работает без `res.headers`/`res.body` (моки).
- `tests/webui-*`: карточка закрывается, чат не замирает (гард `#msgs > .empty`).
- en/ru паритет; `bun test` + `bun run quality` зелёные; `CHANGELOG.md`.
