import { describe, it, expect, vi } from 'vitest';
import { planHandler } from '../src/tools/native/plan.js';
import { todoHandler } from '../src/tools/native/todo.js';
import { questionHandler } from '../src/tools/native/question.js';
import { approveHandler } from '../src/tools/native/approve.js';
import { userProfileHandler } from '../src/tools/native/user-profile.js';
import { themeHandler } from '../src/tools/native/theme.js';
import type { ToolContext } from '../src/tools/types.js';

vi.mock('../src/tools/plan.js', () => ({
  createPlan: vi.fn((name: string, steps: string[]) => `Plan: ${name} [${steps.length} steps]`),
  updatePlanStep: vi.fn(() => 'Step updated'),
  showPlan: vi.fn(() => 'Plan: Test'),
  clearPlan: vi.fn(() => 'Plan cleared'),
  parsePlanCommand: vi.fn((args: string) => ({ action: 'create', params: [args] })),
  getPlanPendingCount: vi.fn(() => 0),
}));

vi.mock('../src/tools/todo.js', () => ({
  addTodo: vi.fn((text: string) => `Added: ${text}`),
  doneTodo: vi.fn((text: string) => `Done: ${text}`),
  removeTodo: vi.fn((text: string) => `Removed: ${text}`),
  listTodos: vi.fn(() => 'No todos'),
  parseTodoCommand: vi.fn((args: string) => ({ action: 'list', params: args })),
}));

vi.mock('../src/agent/user-profile.js', () => ({
  loadProfile: vi.fn(() => '# User Profile\n- TypeScript expert'),
  appendNote: vi.fn(),
}));

vi.mock('../src/styling/index.js', () => ({
  listThemes: vi.fn(() => ['dark', 'light']),
  switchTheme: vi.fn(),
}));
vi.mock('../src/styling/loader.js', () => ({
  loadThemeConfig: vi.fn(() => ({ name: 'dark', colors: {}, icons: {} })),
  installTheme: vi.fn(),
  removeTheme: vi.fn(() => true),
}));
vi.mock('../src/config/config.js', () => ({
  loadConfig: vi.fn(() => ({ theme: 'dark' })),
  saveConfig: vi.fn(),
}));

const ctx: ToolContext = { cwd: '/tmp/test', quiet: true };

describe('plan handler', () => {
  it('creates a plan', async () => {
    const result = await planHandler.execute({ name: 'Test Plan', steps: ['s1', 's2'] }, ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Plan');
  });

  it('suggests subagent for 3+ steps', async () => {
    const result = await planHandler.execute({ name: 'Big', steps: ['s1', 's2', 's3'] }, ctx);
    expect(result.stdout).toContain('subagent');
  });

  it('has correct definition', () => {
    expect(planHandler.name).toBe('plan');
  });
});

describe('todo handler', () => {
  it('adds a todo', async () => {
    const result = await todoHandler.execute({ action: 'add', text: 'Buy milk' }, ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Added');
  });

  it('lists todos', async () => {
    const result = await todoHandler.execute({ action: 'list' }, ctx);
    expect(result.exitCode).toBe(0);
  });

  it('returns error for unknown action', async () => {
    const result = await todoHandler.execute({ action: 'unknown' }, ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unknown');
  });

  it('has correct definition', () => {
    expect(todoHandler.name).toBe('todo');
  });
});

describe('question handler', () => {
  it('returns questionPending', async () => {
    const result = await questionHandler.execute({ question: 'What color?' }, ctx);
    expect(result.questionPending).toBe(true);
    expect(result.breakLoop).toBe(true);
    expect(result.stdout).toContain('What color?');
  });

  it('has correct definition', () => {
    expect(questionHandler.name).toBe('question');
  });
});

describe('approve handler', () => {
  it('returns questionPending', async () => {
    const result = await approveHandler.execute({ action: 'delete file' }, ctx);
    expect(result.questionPending).toBe(true);
    expect(result.breakLoop).toBe(true);
    expect(result.stdout).toContain('delete file');
  });

  it('has correct definition', () => {
    expect(approveHandler.name).toBe('approve');
  });
});

describe('user_profile handler', () => {
  it('shows profile', async () => {
    const result = await userProfileHandler.execute({ action: 'show' }, ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('TypeScript');
  });

  it('returns error for unknown action', async () => {
    const result = await userProfileHandler.execute({ action: 'unknown' }, ctx);
    expect(result.exitCode).toBe(1);
  });

  it('has correct definition', () => {
    expect(userProfileHandler.name).toBe('user_profile');
  });
});

describe('theme handler', () => {
  it('lists themes', async () => {
    const result = await themeHandler.execute({ action: 'list' }, ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('dark');
  });

  it('shows current theme', async () => {
    const result = await themeHandler.execute({ action: 'show' }, ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Theme');
  });

  it('has correct definition', () => {
    expect(themeHandler.name).toBe('theme');
  });
});
