import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getTheme } from '../styling/index.js';

/**
 * Хранение сессий агента.
 *
 * Сессии сохраняются в ~/.mma/sessions/ в виде JSON-файлов.
 * Индекс сессий в ~/.mma/sessions/index.json.
 *
 * Особенности:
 * - Читаемые ID (00001-snake-base-tutorial)
 * - Автосохранение при завершении
 * - Ограничение: 50 сессий, 10MB каждая
 * - Автообрезка при превышении лимита
 *
 * @module session/store
 */

// ─── Константы ──────────────────────────────────────────
const SESSIONS_DIR = join(homedir(), '.mma', 'sessions');
const INDEX_FILE = join(SESSIONS_DIR, 'index.json');
const MAX_SESSIONS = 50;
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// ─── Словарь для генерации читаемых ID ───────────────────
const WORDS = [
  'snake', 'base', 'tutorial', 'quick', 'silver', 'golden', 'crimson',
  'azure', 'emerald', 'amber', 'cobalt', 'jade', 'ruby', 'sapphire',
  'shadow', 'blade', 'storm', 'stone', 'oak', 'pine', 'maple', 'cedar',
  'river', 'lake', 'ocean', 'peak', 'valley', 'ridge', 'cove', 'grove',
  'falcon', 'eagle', 'hawk', 'raven', 'owl', 'dove', 'swan', 'wren',
  'wolf', 'bear', 'fox', 'deer', 'mole', 'hare', 'lynx', 'stag',
  'cypher', 'vector', 'matrix', 'pixel', 'vertex', 'proxy', 'relay',
  'nexus', 'forge', 'helix', 'torch', 'beacon', 'prism', 'mantle',
  'solar', 'lunar', 'nova', 'comet', 'aster', 'nebula', 'cosmos',
  'teal', 'mint', 'coral', 'rose', 'swift', 'brave', 'calm', 'eager',
  'fleet', 'grand', 'keen', 'proud', 'rustic', 'meadow', 'forest',
  'garden', 'orchard', 'harbor', 'castle', 'anchor', 'bridge', 'cabin',
  'creek', 'dunes', 'field', 'glade', 'hill', 'lantern', 'marble',
  'noble', 'palace', 'quarry', 'shrine', 'temple', 'barrel', 'candle',
  'fable', 'gadget', 'humble', 'jigsaw', 'kettle', 'lagoon', 'mellow',
  'napkin', 'paddle', 'rabbit', 'saddle', 'tangle', 'walnut', 'zephyr',
  'acorn', 'beetle', 'cactus', 'echo', 'flute', 'guitar', 'harp',
  'ivory', 'jazz', 'lute', 'march', 'opera', 'piano', 'sonata',
  'ukulele', 'viola', 'waltz', 'yodel', 'brisk', 'crisp', 'dusk',
  'ember', 'frost', 'gleam', 'haze', 'mist', 'shade', 'dawn',
];

/** Выбирает случайный элемент из массива */
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Генерирует читаемый ID сессии: 00001-snake-base-tutorial.
 * Формат: номер-слово-слово-слово.
 */
export function generateReadableId(): string {
  const counterFile = join(SESSIONS_DIR, '.counter');
  let num = 1;
  try {
    if (existsSync(counterFile)) {
      num = parseInt(readFileSync(counterFile, 'utf-8').trim(), 10) + 1;
    }
  } catch { /* ignore */ }
  try { writeFileSync(counterFile, String(num), 'utf-8'); } catch { /* ignore */ }
  const word1 = pick(WORDS);
  const word2 = pick(WORDS);
  const word3 = pick(WORDS);
  return `${String(num).padStart(5, '0')}-${word1}-${word2}-${word3}`;
}

/** Сообщение сессии */
export interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string;
}

/** Сессия агента */
export interface Session {
  id: string;
  name: string;
  created: string;
  provider: string;
  cwd: string;
  messages: SessionMessage[];
  context: {
    totalTokens: number;
    compactCount: number;
  };
  /** Режим агента (fast/base/pro/custom) */
  mode?: string;
}

interface SessionIndex {
  sessions: { id: string; name: string; created: string; size: number }[];
}

/** Создаёт директорию сессий если не существует */
function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

/** Загружает индекс сессий */
function loadIndex(): SessionIndex {
  ensureDir();
  try {
    if (existsSync(INDEX_FILE)) {
      return JSON.parse(readFileSync(INDEX_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { sessions: [] };
}

/** Сохраняет индекс сессий */
function saveIndex(index: SessionIndex): void {
  ensureDir();
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}

function generateId(): string {
  return generateReadableId();
}

/** Сохраняет сессию в файл. Автосокращение при превышении 10MB. */
export function saveSession(session: Session): string {
  ensureDir();

  const filePath = join(SESSIONS_DIR, `${session.id}.json`);
  const content = JSON.stringify(session, null, 2);

  if (content.length > MAX_SIZE_BYTES) {
    console.log(getTheme().warning(`  Warning: session too large (${Math.round(content.length / 1024)}KB), truncating messages`));
    session.messages = session.messages.slice(-50);
    return saveSession(session);
  }

  writeFileSync(filePath, content, 'utf-8');

  const index = loadIndex();
  const existing = index.sessions.findIndex(s => s.id === session.id);
  const entry = { id: session.id, name: session.name, created: session.created, size: content.length };

  if (existing >= 0) {
    index.sessions[existing] = entry;
  } else {
    index.sessions.unshift(entry);
  }

  // Cleanup old sessions
  while (index.sessions.length > MAX_SESSIONS) {
    const oldest = index.sessions.pop();
    if (oldest) {
      const oldPath = join(SESSIONS_DIR, `${oldest.id}.json`);
      try { unlinkSync(oldPath); } catch { /* ignore */ }
    }
  }

  saveIndex(index);
  return filePath;
}

/** Загружает сессию по ID */
export function loadSession(id: string): Session | null {
  const filePath = join(SESSIONS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Возвращает список всех сессий из индекса */
export function listSessions(): { id: string; name: string; created: string; size: number }[] {
  return loadIndex().sessions;
}

/** Создаёт автосессию (без имени, при завершении REPL) */
export function createAutoSession(messages: SessionMessage[], provider: string, cwd: string, context: Session['context'], mode?: string): string {
  const session: Session = {
    id: generateReadableId(),
    name: '',
    created: new Date().toISOString(),
    provider,
    cwd,
    messages,
    context,
    mode,
  };
  return saveSession(session);
}

/** Создаёт именованную сессию (при команде /save) */
export function createNamedSession(name: string, messages: SessionMessage[], provider: string, cwd: string, context: Session['context'], mode?: string): string {
  const session: Session = {
    id: generateId(),
    name,
    created: new Date().toISOString(),
    provider,
    cwd,
    messages,
    context,
    mode,
  };
  return saveSession(session);
}

/** Форматирует список сессий для отображения */
export function formatSessionList(sessions: { id: string; name: string; created: string; size: number }[]): string {
  const theme = getTheme();
  if (sessions.length === 0) return theme.dim('  No saved sessions.');

  const lines: string[] = [theme.info(`  Saved sessions (${sessions.length}):`)];
  for (const s of sessions) {
    const date = new Date(s.created).toLocaleString('ru-RU');
    const name = s.name || '(auto)';
    const size = `${Math.round(s.size / 1024)}KB`;
    lines.push(`    ${theme.highlight(s.id)}  ${name}  ${theme.dim(date)}  ${size}`);
  }
  return lines.join('\n');
}
