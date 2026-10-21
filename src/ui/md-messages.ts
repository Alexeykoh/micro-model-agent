// Сообщения чата с цветовым префиксом (ошибка/успех/предупреждение).
//
// Вынесено из `md-formatter.ts`: это не markdown-рендер, а примитивы вывода
// (правило 6 AGENTS).
import { pc } from "./colors";
import { t } from "../i18n/index";

/** Форматирует ошибку (красный префикс из i18n). */
export function formatError(text: string): string {
  return pc.red(pc.bold(t("ui.error_prefix")) + text);
}

/** Форматирует успех (зелёный префикс из i18n). */
export function formatSuccess(text: string): string {
  return pc.green(pc.bold(t("ui.success_prefix")) + text);
}

/** Форматирует предупреждение (жёлтый префикс из i18n). */
export function formatWarning(text: string): string {
  return pc.yellow(pc.bold(t("ui.warning_prefix")) + text);
}
