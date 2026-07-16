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

export function formatApprove(a: ApproveState): string {
  return `Approve: ${a.action}\n\n  1. Yes\n  2. No\n\nEnter 1 or 2:`;
}

export function parseApproveCommand(args: string): string {
  return args.trim();
}
