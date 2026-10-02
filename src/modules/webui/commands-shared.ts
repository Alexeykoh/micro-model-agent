// Общая обвязка слеш-хендлеров `mma web`: единый путь записи конфига (реестр → персист).
/**
 * Ядерный диспетчер (`commands.ts`) и расширенные хендлеры настроек
 * (`commands-settings.ts`) идут ОДНИМ путём записи: реестр конфига
 * (`setConfigValue`), хуки `saveConfig`/`reconfigure` хоста. Хелперы здесь,
 * чтобы между модулями хендлеров не было цикла импортов.
 */
import type { AppConfig } from "../../config/types";
import { setLocale } from "../../i18n";
import { setConfigValue } from "../../config/registry";
import type { WebUiState } from "./state";

/** Вывод строки в ленту команды. */
export type Out = (line: string) => void;
/** Хендлер команды: аргументы и вывод. */
export type Handler = (args: string[], out: Out) => void | Promise<void>;

/** Гоняет `fn` только при wired конфиге; иначе — подсказка. */
export function withConfig(
  state: WebUiState,
  out: Out,
  fn: (cfg: AppConfig) => void | Promise<void>,
): void | Promise<void> {
  if (!state.config) {
    out("↳ config unavailable");
    return;
  }
  return fn(state.config);
}

/** Мета активной сессии; null, если сессий нет. */
export function activeMeta(state: WebUiState) {
  const id = state.sessionManager?.getActive();
  return id ? (state.sessionManager?.get(id) ?? null) : null;
}

/** Человекочитаемый текст ошибки записи конфига по причине реестра. */
export function configErrorText(reason: string, input: string, key?: string): string {
  const target = key ?? input;
  switch (reason) {
    case "unknown-key":
      return `unknown key: ${input}`;
    case "read-only":
      return `${target} is read-only`;
    case "range":
      return `value out of range for ${target}`;
    case "combined":
      return "shares exceed the combined limit";
    default:
      return `invalid value for ${target}`;
  }
}

/** Персист + reconfigure после успешной записи реестра, затем отчёт. */
export async function applyConfigWrite(
  cfg: AppConfig,
  name: string,
  value: string,
  out: Out,
  state: WebUiState,
): Promise<void> {
  // Конфиг меняет живой раннер через `reconfigure` (resize контекста, подмена
  // провайдера) — во время хода это гонка. Читающие команды (`/status`,
  // `/model list`, `/config <key>`) проходят мимо этого пути и остаются.
  if (state.busy) {
    out("↳ busy: stop the running turn before changing settings");
    return;
  }
  const result = setConfigValue(cfg, name, value);
  if (!result.ok) {
    out(`↳ ${configErrorText(result.reason, result.input, result.key)}`);
    return;
  }
  // У `locale` в реестре `reconfigure: false`, так что больше некому применить
  // его к процесс-глобальному i18n. Делаем здесь, чтобы серверный вывод и
  // перезапрошенный словарь браузера сошлись сразу (зеркалит `handleConfigPost`).
  if (result.key === "locale") setLocale(cfg.locale);
  let note = "saved";
  try {
    state.saveConfig?.(cfg);
  } catch {
    note = "not persisted";
  }
  if (result.reconfigure && state.reconfigure) {
    try {
      await state.reconfigure(cfg);
    } catch {
      note = `${note}; reconfigure failed`;
    }
  }
  out(`${result.key} = ${result.display} · ${note}`);
}
