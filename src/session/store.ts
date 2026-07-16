import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getTheme } from '../styling/index.js';

const SESSIONS_DIR = join(homedir(), '.mma', 'sessions');
const INDEX_FILE = join(SESSIONS_DIR, 'index.json');
const MAX_SESSIONS = 50;
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string;
}

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
}

interface SessionIndex {
  sessions: { id: string; name: string; created: string; size: number }[];
}

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function loadIndex(): SessionIndex {
  ensureDir();
  try {
    if (existsSync(INDEX_FILE)) {
      return JSON.parse(readFileSync(INDEX_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { sessions: [] };
}

function saveIndex(index: SessionIndex): void {
  ensureDir();
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}

function generateId(): string {
  return `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

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

export function loadSession(id: string): Session | null {
  const filePath = join(SESSIONS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function listSessions(): { id: string; name: string; created: string; size: number }[] {
  return loadIndex().sessions;
}

export function createAutoSession(messages: SessionMessage[], provider: string, cwd: string, context: Session['context']): string {
  const session: Session = {
    id: `auto_${Date.now().toString(36)}`,
    name: '',
    created: new Date().toISOString(),
    provider,
    cwd,
    messages,
    context,
  };
  return saveSession(session);
}

export function createNamedSession(name: string, messages: SessionMessage[], provider: string, cwd: string, context: Session['context']): string {
  const session: Session = {
    id: generateId(),
    name,
    created: new Date().toISOString(),
    provider,
    cwd,
    messages,
    context,
  };
  return saveSession(session);
}

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
