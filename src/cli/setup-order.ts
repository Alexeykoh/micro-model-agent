/**
 * Шим совместимости: логика записи конфига визарда живёт в
 * `src/modules/setup/apply.ts`, чтобы её делил браузерный визард. Реэкспорт
 * отсюда сохраняет терминальный путь импорта (и его тесты).
 */
export { applyAnswersToConfig, SECURITY_BASH_BLOCKLIST } from "../modules/setup/apply";
