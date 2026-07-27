import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getTheme } from '../styling/index.js';

/**
 * Управление todo-задачами агента.
 *
 * Простой список задач со статусами (pending/done).
 * Хранится в ~/.mma/state/todos.json.
 *
 * @module tools/todo
 */

/** Директория для хранения todo (может быть переопределена через setTodoDir или env TODO_DIR) */
let STATE_DIR = process.env.TODO_DIR || join(homedir(), '.mma', 'state');
let TODO_FILE = join(STATE_DIR, 'todos.json');

/** Переопределяет директорию хранения todo (для тестов) */
export function setTodoDir(dir: string): void {
  STATE_DIR = dir;
  TODO_FILE = join(STATE_DIR, 'todos.json');
}

/** Задача в списке todo */
export interface TodoItem {
  id: number;
  text: string;
  status: 'pending' | 'done';
  createdAt: string;
}

/** Список задач */
export interface TodoList {
  items: TodoItem[];
  nextId: number;
}

/** Создаёт директорию для состояния если не существует */
function ensureDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

/** Загружает список задач из файла */
function loadTodos(): TodoList {
  try {
    if (existsSync(TODO_FILE)) {
      return JSON.parse(readFileSync(TODO_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { items: [], nextId: 1 };
}

/** Сохраняет список задач в файл */
function saveTodos(todos: TodoList): void {
  ensureDir();
  writeFileSync(TODO_FILE, JSON.stringify(todos, null, 2), 'utf-8');
}

/** Добавляет новую задачу в список */
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

/** Отмечает задачу как выполненную (по ID или тексту) */
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

/** Удаляет задачу из списка (по ID или тексту) */
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

/** Показывает все задачи с прогрессом */
export function listTodos(): string {
  return formatTodos(loadTodos());
}

/** Форматирует список задач для отображения */
function formatTodos(todos: TodoList): string {
  const theme = getTheme();
  if (todos.items.length === 0) {
    return 'No tasks. Add one with: todo add <text>';
  }

  const pending = todos.items.filter(t => t.status === 'pending');
  const done = todos.items.filter(t => t.status === 'done');
  const total = todos.items.length;
  const doneCount = done.length;
  const progress = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  const lines: string[] = [];
  lines.push(`${theme.heading(`Tasks:`)} [${doneCount}/${total} ${progress}%]`);
  lines.push('');

  for (const item of pending) {
    lines.push(`  ${theme.dim(theme.icon.pending)} ${theme.dim(String(item.id))}. ${item.text}`);
  }
  for (const item of done) {
    lines.push(`  ${theme.stepIcon('done')} ${theme.dim(String(item.id))}. ${theme.dim(item.text)}`);
  }

  return lines.join('\n');
}

/** Парсит аргументы команды todo (add, done, remove, list) */
export function parseTodoCommand(args: string): { action: string; params: string } {
  const spaceIdx = args.indexOf(' ');
  const action = spaceIdx === -1 ? args.trim() : args.slice(0, spaceIdx).trim();
  const params = spaceIdx === -1 ? '' : args.slice(spaceIdx + 1).trim();
  return { action, params };
}
