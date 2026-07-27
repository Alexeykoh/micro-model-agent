import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// --- Plan tests ---
import { createPlan, updatePlanStep, showPlan, clearPlan, parsePlanCommand, setPlanDir } from '../src/tools/plan.js';
// --- Todo tests ---
import { addTodo, doneTodo, removeTodo, listTodos, parseTodoCommand, setTodoDir } from '../src/tools/todo.js';
// --- Memory tests ---
import { saveMemory, loadMemory, searchMemory, exportMemory } from '../src/agent/memory.js';

// --- Session tests ---
import { saveSession, loadSession, listSessions, createAutoSession } from '../src/session/store.js';

const TEST_DIR = join(tmpdir(), 'mma-test-' + Date.now());
const PLAN_FILE = join(TEST_DIR, 'current-plan.json');
const TODO_FILE = join(TEST_DIR, 'todos.json');

function setupTestDir() {
  mkdirSync(TEST_DIR, { recursive: true });
  setPlanDir(TEST_DIR);
  setTodoDir(TEST_DIR);
}

function cleanupState() {
  try { rmSync(PLAN_FILE); } catch {}
  try { rmSync(TODO_FILE); } catch {}
}

describe('Plan', () => {
  beforeAll(setupTestDir);
  afterAll(() => { try { rmSync(TEST_DIR, { recursive: true }); } catch {} });

  it('creates a plan with steps', () => {
    const result = createPlan('TestProject', ['step1', 'step2', 'step3']);
    expect(result).toContain('TestProject');
    expect(result).toContain('step1');
    expect(result).toContain('step2');
    expect(result).toContain('step3');
  });

  it('shows current plan', () => {
    const result = showPlan();
    expect(result).toContain('TestProject');
  });

  it('updates step status to in_progress', () => {
    const result = updatePlanStep(1, 'in_progress');
    expect(result).toContain('TestProject');
  });

  it('updates step status to done', () => {
    const result = updatePlanStep(1, 'done');
    expect(result).toContain('TestProject');
  });

  it('fails on invalid step id', () => {
    const result = updatePlanStep(999, 'done');
    expect(result).toContain('not found');
  });

  it('clears the plan', () => {
    const result = clearPlan();
    expect(result).toContain('cleared');
  });

  it('shows empty after clear', () => {
    const result = showPlan();
    expect(result).toContain('No active plan');
  });

  it('parses plan command', () => {
    expect(parsePlanCommand('create MyProject a b c')).toEqual({
      action: 'create',
      params: ['MyProject', 'a', 'b', 'c'],
    });
  });

  it('defaults action to show', () => {
    expect(parsePlanCommand('')).toEqual({ action: 'show', params: [] });
  });
});

describe('Todo', () => {
  beforeAll(cleanupState);
  afterAll(cleanupState);

  it('adds a todo item', () => {
    const result = addTodo('Write tests');
    expect(result).toContain('Write tests');
    expect(result).toContain('0/1');
  });

  it('adds multiple items', () => {
    addTodo('Fix bug');
    addTodo('Deploy');
    const result = listTodos();
    expect(result).toContain('Write tests');
    expect(result).toContain('Fix bug');
    expect(result).toContain('Deploy');
  });

  it('marks todo as done by id', () => {
    const result = doneTodo('1');
    expect(result).toContain('1/3');
  });

  it('marks todo as done by text', () => {
    const result = doneTodo('Fix bug');
    expect(result).toContain('2/3');
  });

  it('fails on invalid id', () => {
    const result = doneTodo('999');
    expect(result).toContain('not found');
  });

  it('removes a todo', () => {
    const result = removeTodo('3');
    expect(result).not.toContain('Deploy');
  });

  it('shows progress percentage', () => {
    const result = listTodos();
    expect(result).toMatch(/\d+\/\d+/);
  });

  it('parses todo command', () => {
    expect(parseTodoCommand('add Buy milk')).toEqual({
      action: 'add',
      params: 'Buy milk',
    });
  });

  it('handles empty list', () => {
    cleanupState();
    const result = listTodos();
    expect(result).toContain('No tasks');
  });
});

describe('Memory', () => {
  const MEMORY_DIR = join(homedir(), '.mma', 'memory');
  const TEST_MEMORY_FILE = join(MEMORY_DIR, 'decisions.md');

  beforeAll(() => {
    mkdirSync(MEMORY_DIR, { recursive: true });
  });

  it('saves a memory entry', () => {
    saveMemory('decisions', 'Use TypeScript', 'We decided to use TypeScript for the project');
    const content = loadMemory('decisions');
    expect(content).toContain('Use TypeScript');
    expect(content).toContain('TypeScript');
  });

  it('appends to existing memory', () => {
    saveMemory('decisions', 'Use Vitest', 'We chose vitest for testing');
    const content = loadMemory('decisions');
    expect(content).toContain('Use TypeScript');
    expect(content).toContain('Use Vitest');
  });

  it('loads empty memory gracefully', () => {
    const content = loadMemory('nonexistent');
    expect(content).toContain('No entries yet');
  });

  it('searches memory by keyword', () => {
    const results = searchMemory('TypeScript');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].match).toContain('TypeScript');
  });

  it('returns empty for no matches', () => {
    const results = searchMemory('xyznonexistent');
    expect(results.length).toBe(0);
  });

  it('searches across all types', () => {
    saveMemory('conventions', 'Code style', 'Use single quotes');
    const results = searchMemory('quotes');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe('conventions');
  });

  it('exports memory', () => {
    const result = exportMemory();
    expect(result).toContain('memory-export');
  });
});

describe('Session Store', () => {
  it('saves and loads a session', () => {
    const session = {
      id: 'test_session_001',
      name: 'test-session',
      created: new Date().toISOString(),
      provider: 'lmstudio',
      cwd: process.cwd(),
      messages: [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there!' },
      ],
      context: { totalTokens: 100, compactCount: 0 },
    };

    const saved = saveSession(session);
    expect(saved).toBeTruthy();

    const loaded = loadSession('test_session_001');
    expect(loaded).toBeDefined();
    expect(loaded!.messages.length).toBe(2);
    expect(loaded!.messages[0].content).toBe('Hello');
    expect(loaded!.messages[1].content).toBe('Hi there!');
  });

  it('lists sessions', () => {
    const sessions = listSessions();
    expect(sessions.length).toBeGreaterThan(0);
  });

  it('creates auto session', () => {
    const messages = [
      { role: 'user' as const, content: 'Test auto' },
      { role: 'assistant' as const, content: 'Auto response' },
    ];
    const id = createAutoSession(messages, 'test-model', '/tmp', { totalTokens: 50, compactCount: 0 });
    expect(id).toBeTruthy();
    expect(id).toContain('.json');
  });
});
