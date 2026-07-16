import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = join(homedir(), '.mma', 'state');
const TODO_FILE = join(STATE_DIR, 'todos.json');

export interface TodoItem {
  id: number;
  text: string;
  status: 'pending' | 'done';
  createdAt: string;
}

export interface TodoList {
  items: TodoItem[];
  nextId: number;
}

function ensureDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function loadTodos(): TodoList {
  try {
    if (existsSync(TODO_FILE)) {
      return JSON.parse(readFileSync(TODO_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { items: [], nextId: 1 };
}

function saveTodos(todos: TodoList): void {
  ensureDir();
  writeFileSync(TODO_FILE, JSON.stringify(todos, null, 2), 'utf-8');
}

export function addTodo(text: string): string {
  const todos = loadTodos();
  todos.items.push({
    id: todos.nextId++,
    text,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  saveTodos(todos);
  return formatTodos(todos);
}

export function doneTodo(idOrText: string): string {
  const todos = loadTodos();
  const id = parseInt(idOrText);

  if (!isNaN(id)) {
    const item = todos.items.find(t => t.id === id);
    if (!item) return `Task ${id} not found.`;
    item.status = 'done';
  } else {
    // Find by text match
    const item = todos.items.find(t => t.text.toLowerCase().includes(idOrText.toLowerCase()) && t.status === 'pending');
    if (!item) return `Task matching "${idOrText}" not found.`;
    item.status = 'done';
  }

  saveTodos(todos);
  return formatTodos(todos);
}

export function removeTodo(idOrText: string): string {
  const todos = loadTodos();
  const id = parseInt(idOrText);

  if (!isNaN(id)) {
    const idx = todos.items.findIndex(t => t.id === id);
    if (idx === -1) return `Task ${id} not found.`;
    todos.items.splice(idx, 1);
  } else {
    const idx = todos.items.findIndex(t => t.text.toLowerCase().includes(idOrText.toLowerCase()));
    if (idx === -1) return `Task matching "${idOrText}" not found.`;
    todos.items.splice(idx, 1);
  }

  saveTodos(todos);
  return formatTodos(todos);
}

export function listTodos(): string {
  return formatTodos(loadTodos());
}

function formatTodos(todos: TodoList): string {
  if (todos.items.length === 0) {
    return 'No tasks. Add one with: todo add <text>';
  }

  const pending = todos.items.filter(t => t.status === 'pending');
  const done = todos.items.filter(t => t.status === 'done');
  const total = todos.items.length;
  const doneCount = done.length;
  const progress = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  const lines: string[] = [];
  lines.push(`Tasks: [${doneCount}/${total} ${progress}%]`);
  lines.push('');

  for (const item of pending) {
    lines.push(`  [ ] ${item.id}. ${item.text}`);
  }
  for (const item of done) {
    lines.push(`  [✓] ${item.id}. ${item.text}`);
  }

  return lines.join('\n');
}

export function parseTodoCommand(args: string): { action: string; params: string } {
  const spaceIdx = args.indexOf(' ');
  const action = spaceIdx === -1 ? args.trim() : args.slice(0, spaceIdx).trim();
  const params = spaceIdx === -1 ? '' : args.slice(spaceIdx + 1).trim();
  return { action, params };
}
