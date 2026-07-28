import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import { getInkTheme } from '../theme.js';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative, dirname, basename } from 'node:path';

interface CommandInfo {
  name: string;
  description: string;
}

interface FileSuggestion {
  path: string;
  isDir: boolean;
}

const HINTS = [
  'Ctrl+C to exit',
  '/help for commands',
  'Tab for completion',
  '@file for file refs',
  '↑/↓ for history',
  'Shift+Enter for newline',
];

// ─── File search ───────────────────────────────────────

const MAX_FILE_SUGGESTIONS = 15;

function findFiles(partial: string): FileSuggestion[] {
  const results: FileSuggestion[] = [];

  // Определяем директорию для поиска и паттерн для фильтрации
  let searchDir: string;
  let filterPrefix: string;

  if (partial.includes('/') || partial.includes('\\')) {
    // Есть путь — ищем в последней директории
    const lastSlash = Math.max(partial.lastIndexOf('/'), partial.lastIndexOf('\\'));
    const dirPart = partial.slice(0, lastSlash) || '.';
    const filePart = partial.slice(lastSlash + 1);
    searchDir = resolve(process.cwd(), dirPart);
    filterPrefix = filePart.toLowerCase();
  } else {
    searchDir = process.cwd();
    filterPrefix = partial.toLowerCase();
  }

  if (!existsSync(searchDir) || !statSync(searchDir).isDirectory()) {
    return results;
  }

  try {
    const entries = readdirSync(searchDir);
    for (const entry of entries) {
      // Пропускаем скрытые файлы/папки
      if (entry.startsWith('.')) continue;

      const entryLower = entry.toLowerCase();
      if (filterPrefix && !entryLower.startsWith(filterPrefix)) continue;

      const fullPath = join(searchDir, entry);
      let isDir = false;
      try {
        isDir = statSync(fullPath).isDirectory();
      } catch { continue; }

      // Путь относительно cwd
      const relPath = relative(process.cwd(), fullPath).replace(/\\/g, '/');

      // Для директорий добавляем /
      results.push({
        path: isDir ? relPath + '/' : relPath,
        isDir,
      });

      if (results.length >= MAX_FILE_SUGGESTIONS) break;
    }
  } catch { /* skip */ }

  // Сортируем: папки первые, затем файлы
  results.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.path.localeCompare(b.path);
  });

  return results;
}

// ─── Component ─────────────────────────────────────────

export function PromptInput({
  commands,
  onSubmit,
  disabled,
  mode,
  onAbort,
}: {
  commands?: CommandInfo[];
  onSubmit: (value: string) => void;
  disabled?: boolean;
  mode?: string;
  onAbort?: () => void;
}) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [cmdSuggestions, setCmdSuggestions] = useState<CommandInfo[]>([]);
  const [fileSuggestions, setFileSuggestions] = useState<FileSuggestion[]>([]);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const [hintIdx, setHintIdx] = useState(0);
  const t = getInkTheme();

  // Объединённые подсказки для отображения
  const suggestions = cmdSuggestions.length > 0
    ? cmdSuggestions.map(c => ({ label: `/${c.name}`, desc: c.description }))
    : fileSuggestions.map(f => ({ label: f.path, desc: f.isDir ? 'dir' : '' }));
  const showSuggestions = suggestions.length > 0;

  useEffect(() => {
    if (!disabled) return;
    const id = setInterval(() => setHintIdx((i) => (i + 1) % HINTS.length), 4000);
    return () => clearInterval(id);
  }, [disabled]);

  useInput((input: string, key: Key) => {
    if (key.escape && onAbort) {
      onAbort();
      return;
    }
    if (disabled) return;
    if (key.return && !key.shift) {
      const trimmed = value.trim();
      if (trimmed) {
        onSubmit(trimmed);
        setHistory((h: string[]) => [trimmed, ...h].slice(0, 50));
      }
      setValue('');
      setCursor(0);
      setHistoryIdx(-1);
      setCmdSuggestions([]);
      setFileSuggestions([]);
      return;
    }

    if (key.return && key.shift) {
      setValue((v: string) => v.slice(0, cursor) + '\n' + v.slice(cursor));
      setCursor((c: number) => c + 1);
      return;
    }

    if (key.tab) {
      const beforeCursor = value.slice(0, cursor);

      // ─── Slash-команды ──────────────────────────────
      const cmdMatch = beforeCursor.match(/^\/(\w*)$/);
      if (cmdMatch && commands) {
        const partial = cmdMatch[1].toLowerCase();
        const matches = commands.filter((c: CommandInfo) => c.name.startsWith(partial));

        if (matches.length > 0) {
          if (cmdSuggestions.length === 0) {
            setCmdSuggestions(matches);
            setFileSuggestions([]);
            setSuggestIdx(0);
          }
          const idx = cmdSuggestions.length > 0 ? suggestIdx : 0;
          const selected = matches[idx % matches.length];
          const nextIdx = (suggestIdx + 1) % matches.length;
          setSuggestIdx(nextIdx);
          setValue('/' + selected.name + value.slice(cursor));
          setCursor('/' .length + selected.name.length);
          return;
        }
      }

      // ─── @file ссылки ──────────────────────────────
      const atMatch = beforeCursor.match(/@([^\s"'|;]*)$/);
      if (atMatch) {
        const partial = atMatch[1];
        const files = findFiles(partial);

        if (files.length > 0) {
          if (fileSuggestions.length === 0) {
            setFileSuggestions(files);
            setCmdSuggestions([]);
            setSuggestIdx(0);
          }
          const idx = fileSuggestions.length > 0 ? suggestIdx : 0;
          const selected = files[idx % files.length];
          const nextIdx = (suggestIdx + 1) % files.length;
          setSuggestIdx(nextIdx);

          // Заменяем @partial на @path
          const atIdx = beforeCursor.lastIndexOf('@');
          const afterCursor = value.slice(cursor);
          const newValue = value.slice(0, atIdx) + '@' + selected.path + afterCursor;
          setValue(newValue);
          setCursor(atIdx + 1 + selected.path.length);
          return;
        }
      }

      setCmdSuggestions([]);
      setFileSuggestions([]);
      setSuggestIdx(0);
      return;
    }

    if (key.upArrow) {
      const beforeCursor = value.slice(0, cursor);
      if (beforeCursor === '' && history.length > 0) {
        const newIdx = historyIdx < history.length - 1 ? historyIdx + 1 : historyIdx;
        if (newIdx !== historyIdx) {
          setHistoryIdx(newIdx);
          setValue(history[newIdx]);
          setCursor(history[newIdx].length);
        }
      }
      return;
    }

    if (key.downArrow) {
      if (historyIdx >= 0) {
        const newIdx = historyIdx - 1;
        if (newIdx >= 0) {
          setHistoryIdx(newIdx);
          setValue(history[newIdx]);
          setCursor(history[newIdx].length);
        } else {
          setHistoryIdx(-1);
          setValue('');
          setCursor(0);
        }
      }
      return;
    }

    if (key.leftArrow) {
      if (cursor > 0) setCursor((c: number) => c - 1);
      return;
    }

    if (key.rightArrow) {
      if (cursor < value.length) setCursor((c: number) => c + 1);
      return;
    }

    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setValue((v: string) => v.slice(0, cursor - 1) + v.slice(cursor));
        setCursor((c: number) => c - 1);
        // Обновить подсказки после удаления
        const newBefore = value.slice(0, cursor - 1);
        const atMatch = newBefore.match(/@([^\s"'|;]*)$/);
        if (atMatch) {
          const files = findFiles(atMatch[1]);
          setFileSuggestions(files);
          setCmdSuggestions([]);
          setSuggestIdx(0);
        } else {
          setCmdSuggestions([]);
          setFileSuggestions([]);
          setSuggestIdx(0);
        }
      }
      return;
    }

    if (key.ctrl && input === 'c') {
      onSubmit('');
      return;
    }

    if (key.ctrl && input === 'a') { setCursor(0); return; }
    if (key.ctrl && input === 'e') { setCursor(value.length); return; }
    if (key.ctrl && input === 'u') { setValue(''); setCursor(0); return; }
    if (key.ctrl && input === 'k') { setValue((v: string) => v.slice(0, cursor)); return; }
    if (key.ctrl && input === 'w') {
      const before = value.slice(0, cursor);
      let i = before.length - 1;
      while (i >= 0 && before[i] === ' ') i--;
      while (i >= 0 && before[i] !== ' ') i--;
      const keepLen = i + 1;
      setValue((v: string) => v.slice(0, keepLen) + v.slice(cursor));
      setCursor(keepLen);
      return;
    }
    if (key.ctrl && input === 'l') { return; }

    if (input && !key.ctrl && !key.meta) {
      setValue((v: string) => v.slice(0, cursor) + input + v.slice(cursor));
      setCursor((c: number) => c + input.length);
      // При вводе после @ — обновить подсказки файлов
      const newBefore = value.slice(0, cursor) + input;
      const atMatch = newBefore.match(/@([^\s"'|;]*)$/);
      if (atMatch) {
        const files = findFiles(atMatch[1]);
        setFileSuggestions(files);
        setCmdSuggestions([]);
        setSuggestIdx(0);
      } else {
        setCmdSuggestions([]);
        setFileSuggestions([]);
        setSuggestIdx(0);
      }
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      {showSuggestions && (
        <Box flexDirection="column" marginLeft={1} marginBottom={1}>
          {suggestions.map((s, i) => (
            <Box key={i}>
              {i === suggestIdx ? (
                <Text bold color={fileSuggestions.length > 0 ? 'green' : 'cyan'}>{'  '}{s.label}</Text>
              ) : (
                <Text {...t.colors.dim}>{'  '}{s.label}</Text>
              )}
              {s.desc ? <Text {...t.colors.dim}> — {s.desc}</Text> : null}
            </Box>
          ))}
        </Box>
      )}
      <Box>
        <Text bold color="cyan">{'▸ '}</Text>
        {mode ? <Text color="magenta">[{mode}] </Text> : null}
        {disabled ? (
          <Text {...t.colors.dim}>{HINTS[hintIdx]}</Text>
        ) : (
          <Text>
            {value.slice(0, cursor)}
            <Text inverse>{value[cursor] || ' '}</Text>
            {value.slice(cursor + 1)}
          </Text>
        )}
      </Box>
    </Box>
  );
}
