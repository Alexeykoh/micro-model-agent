# Настройки плагинов: манифест + свои файлы + подстраницы

Дата: 2026-11-12. Ветка: `feat/plugin-settings-subpages`.

## Задача

У плагинов нет своих настроек — только общий deny-list (`plugins.disabled`,
`plugins.maxDrafts`). Нужны: манифест настроек в коде плагина, свой файл
значений у каждого плагина, подстраница настроек в веб-панели Plugins
(простая визуализация файла настроек с редактированием).

## Контракт

### 1. Манифест — `AgentPlugin.settingsSchema` (`src/modules/types.ts`)

```ts
type PluginSettingType = "string" | "number" | "boolean" | "enum" | "list" | "json";
interface PluginSettingDef {
  key: string;            // ^[a-z0-9_]{1,64}$, уникален в схеме
  type: PluginSettingType;
  title?: string;         // подпись, fallback — key
  description?: string;   // подсказка под строкой
  default?: unknown;      // значение по умолчанию (валидируется по type)
  enum?: string[];        // обязательно непустое при type=enum
  min?: number; max?: number; // при type=number
  secret?: boolean;       // redact в GET, blank-keeps в PUT (как MCP env)
  placeholder?: string;
}
AgentPlugin.settingsSchema?: PluginSettingDef[];
```

Невалидные дефы отбрасываются с warning (fail-soft, как метаданные в
`validatePluginMeta`): схема никогда не роняет регистрацию плагина.

### 2. Файл значений — sidecar рядом с плагином

Путь выводится строго из `plugin.path` (без участия пользователя):

- папка-плагин (`.../my-plugin/plugin.ts`) → `.../my-plugin/settings.json`;
- файл-плагин (`.../my-stats.ts`) → `.../my-stats.settings.json`.

Только для внешних плагинов: `plugin.path` задан и плагин не builtin/system.
Встроенные хранят настройки в общем конфиге, как раньше.

Эффективные значения = `defaults` из схемы + хранимое. Неизвестные хранимые
ключи при записи сохраняются (forward-compat), в UI не показываются.
`GET` отдаёт секреты как `""` + список `hasSecrets`; `PUT` с пустым секретом
оставляет хранимое (контракт MCP env/headers).

### 3. Рантайм — волна 2 (не входит)

`PluginSettingsStore.getEffective()` готов и покрыт тестами, но `ctx.settings`
и `PluginManager.getSettings()` **не провязаны**: `manager.ts` стоит ровно на
потолке правила 6 (300 строк, гейт `tests/arch/file-size.test.ts`), и честная
интеграция (провайдер + инвалидация + делегаты ≈ +27 строк) требует сначала
выделить кусок менеджера в отдельный файл. Это отдельная ветка.

### 4. REST (`settings-api.ts`, handler-map, без `if`-цепочек)

- `GET /api/plugins/:name/settings` → `200 {schema, values, hasSecrets}`.
  Нет плагина → `404 not_found`; нет схемы/пути → `404 no_settings`;
  нет менеджера → `503 plugins_unavailable`.
- `PUT /api/plugins/:name/settings {values}` → валидация по схеме
  (`400 unknown-key` / `400 invalid-value`), запись файла, `200` тот же вид.
  Тело ограничено `maxBodyBytes` (общий парсер).

`WebPluginManager` расширяется опциональным
`getPlugin?(name): AgentPlugin | null` (опционально — старые стабы живы).

### 5. UI — подстраница в панели Plugins

- Строка плагина с `hasSettings` получает chip-шестерёнку → поддиалог
  (`openSubDialog`, как MCP-форма) с заголовком-названием плагина.
- Форма рендерится через существующий `controlFor` (toggle/select/number/
  share/list/json) с адаптером `post(key, value)` → `PUT` по одному ключу
  (как остальные секции настроек, без кнопки Save).
- Секреты — тот же контрол, `type=password`, плейсхолдер «stored — blank keeps».

### 6. `PluginRecord.hasSettings: boolean`

`true` = валидная непустая схема + резолвится путь файла. Фронт по нему
решает, рисовать ли шестерёнку; `mma plugins show` — строку о настройках.

## Не входит

- Центральное хранилище (`~/.mma/plugin-settings/`) — sidecar проще и уже
  даёт project/global-скоуп через каталог плагина.
- Отдельный `plugin.manifest.json` — схема в коде покрывает и одиночные файлы,
  и папки; формат файла — позже при необходимости.
- Секреты в лог/поиск: ключи настроек не индексируются поиском панели.

## Гейты

- `tests/plugin-settings-schema.test.ts` — валидация схемы, coerce/validate,
  merge defaults, redact секретов (падает без правки).
- `tests/plugin-settings-store.test.ts` — roundtrip через tmp-каталог,
  unknown-keys сохраняются, cache/mtime.
- `tests/webui-plugin-settings-api.test.ts` — GET/PUT/404/400/503.
- i18n: ключи симметрично в `en`/`ru` (`tests/i18n.test.ts`).
- Файлы ≤300 строк; без `as any`; без `console.*` в `src/`.
