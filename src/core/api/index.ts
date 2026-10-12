/**
 * Публичный API ядра для модулей (INV-3).
 *
 * Модуль вправе зависеть только от этого фасада, а не от внутренностей
 * `core/agent/*`. Здесь — ровно те функции/типы, что модулям реально нужны;
 * список растёт по мере перевода модулей (W4), но остаётся узким.
 *
 * Стережёт `tests/arch/module-boundaries.test.ts`: модуль не импортирует
 * `core/agent` напрямую (allowlist пуст).
 */

// Утилиты наблюдаемости/вывода, нужные модулям (webui/service/critic).
export { redactContextSecrets } from "../agent/context-log";
export { summarizeToolArgs } from "../agent/tool-output";
// Структурный ключ аргументов тула (execution/stuck-detector).
export { canonicalArgsKey } from "../agent/canonical-args";
// Калибровка контекста (context-модуль).
export { ContextCalibrator, isImplausibleJump } from "../agent/context-calibration";
export type { CalibrationState } from "../agent/context-calibration";
// Тип агента для раннеров/веб-поверхностей (только тип — рантайм-цикла нет).
export type { Agent } from "../agent";
