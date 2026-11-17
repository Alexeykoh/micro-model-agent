# План: переработка шагов первой настройки `mma web`

**Дата:** 2026-11-17
**Ветка:** `feat/web-setup-rework`
**Спека:** [2026-11-17-web-setup-rework-design.md](../specs/2026-11-17-web-setup-rework-design.md)

## Волны

### Волна 1 — контракт и сервер

- [x] `SetupAnswers`: `configureProvider`, `contextAuto`, `criticEnabled`,
      `webSearchEnabled`, `theme`, `themeMode`, `themeEffects`, `sounds`.
- [x] `parseSetupAnswers`: условная обязательность provider/model/context;
      валидация новых полей по одному.
- [x] `applyAnswersToConfigWithWarnings`: пропуск провайдера; `contextAuto`;
      critic/webSearch/ui/sounds.
- [x] `GET /api/setup`: `workspace`, `current`, `defaults.contextAuto`.
- [x] `POST /api/setup/test`: `latencyMs`, `replyChars`.
- [x] Тесты: `tests/modules/setup/apply.test.ts`, `tests/webui-setup.test.ts`.

### Волна 2 — каркас и провайдерские шаги

- [x] `setup-state.ts`: новые шаги и поля, группы прогресса.
- [x] `setup-render.ts`: 4 группы, aria-current, фокус.
- [x] `setup-intro.ts`: welcome без чек-листа, язык сверху, «Начать».
- [x] `setup-steps-provider.ts`: 2.0 choice, автоскан, убрать звуки из security.
- [x] `setup-steps-model.ts`: Авто/Вручную для контекста.
- [x] `setup-actions.ts`: развилка 2.0, отсутствие «Назад» на welcome.

### Волна 3 — настройки агента

- [x] `setup-steps-agent.ts`: критик, веб-поиск, разделитель 3.0.
- [x] `setup-steps-appearance.ts`: тема, режим, эффекты, звуки, прослушивание.
- [x] `setup-security.ts`: пресеты Осторожный/Обычный/Доверенный.
- [x] CSS: сегменты, сетка тем, бейджи групп.

### Волна 4 — финал

- [x] `setup-review.ts`: новые строки, workspace, «Проверить и запустить».
- [x] `setup-draft.ts`: localStorage без `apiKey`.
- [x] `setup-dom.ts`/`setup-security.ts`: aria-live, Esc, фокус.
- [x] i18n en/ru, симметрия ключей.

### Волна 5 — проверка

- [x] `bun test` (таргетно), `bun run quality` — в работе.
- [x] Живой прогон на `MMA_CONFIG_DIR` (без Playwright).
- [x] Ручная проверка ru/en и мобильной ширины.

## Критерии готовности

- На virgin-конфиге визард проходится за ~2 минуты, 12 экранов.
- «Пропустить провайдера» доводит до чата на дефолтах LM Studio.
- «Проверить и запустить» показывает задержку и ловит неверную модель.
- После перезагрузки вкладки черновик восстанавливается без ключа.
- `bun test` и `bun run quality` зелёные; есть тесты, падающие без правки.
