export interface ApproveState {
  active: boolean;
  action: string;
  response?: boolean;
}

let currentApprove: ApproveState | null = null;

export function askApprove(action: string): ApproveState {
  currentApprove = {
    active: true,
    action,
  };
  return currentApprove;
}

export function getApprove(): ApproveState | null {
  return currentApprove;
}

export function answerApprove(response: boolean): void {
  if (currentApprove) {
    currentApprove.response = response;
    currentApprove.active = false;
  }
}

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

export function parseApproveCommand(args: string): string {
  return args.trim();
}
