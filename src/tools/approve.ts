/**
 * Инструмент подтверждения действия (Yes/No).
 *
 * Позволяет агенту запросить подтверждение перед потенциально
 * опасными операциями (удаление файлов, git push и т.д.).
 *
 * @module tools/approve
 */

/** Состояние подтверждения */
export interface ApproveState {
  active: boolean;
  action: string;
  response?: boolean;
}

let currentApprove: ApproveState | null = null;

/** Создаёт запрос подтверждения */
export function askApprove(action: string): ApproveState {
  currentApprove = {
    active: true,
    action,
  };
  return currentApprove;
}

/** Возвращает текущий активный запрос подтверждения */
export function getApprove(): ApproveState | null {
  return currentApprove;
}

/** Записывает ответ пользователя (true = Yes, false = No) */
export function answerApprove(response: boolean): void {
  if (currentApprove) {
    currentApprove.response = response;
    currentApprove.active = false;
  }
}

/** Проверяет есть ли активный запрос подтверждения */
export function hasActiveApprove(): boolean {
  return currentApprove?.active === true;
}

import { getTheme } from '../styling/index.js';

export function formatApprove(a: ApproveState): string {
  return `Approve: ${a.action}\n\n  1. Yes\n  2. No\n\nEnter 1 or 2:`;
}

export function formatApproveColored(a: ApproveState): string {
  const theme = getTheme();
  return `${theme.warning(`  ${theme.icon.separator} Approve: ${a.action}`)}\n\n    ${theme.highlight('1')}. Yes\n    ${theme.highlight('2')}. No`;
}

/** Парсит аргументы команды approve */
export function parseApproveCommand(args: string): string {
  return args.trim();
}
