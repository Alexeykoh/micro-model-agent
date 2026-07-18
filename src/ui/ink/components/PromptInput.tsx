import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { getInkTheme } from '../theme.js';

interface CommandInfo {
  name: string;
  description: string;
}

const HINTS = [
  'Ctrl+C to exit',
  '/help for commands',
  'Tab for completion',
  '↑/↓ for history',
  'Shift+Enter for newline',
  'Ask me anything',
];

export function PromptInput({
  commands,
  onSubmit,
  disabled,
  mode,
}: {
  commands?: CommandInfo[];
  onSubmit: (value: string) => void;
  disabled?: boolean;
  mode?: string;
}) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [suggestions, setSuggestions] = useState<CommandInfo[]>([]);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const [hintIdx, setHintIdx] = useState(0);
  const t = getInkTheme();

  useEffect(() => {
    if (!disabled) return;
    const id = setInterval(() => setHintIdx((i) => (i + 1) % HINTS.length), 4000);
    return () => clearInterval(id);
  }, [disabled]);

  useInput((input: string, key: Record<string, boolean>) => {
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
      setSuggestions([]);
      return;
    }

    if (key.return && key.shift) {
      setValue((v: string) => v.slice(0, cursor) + '\n' + v.slice(cursor));
      setCursor((c: number) => c + 1);
      return;
    }

    if (key.tab) {
      const line = value.slice(0, cursor);
      const match = line.match(/^\/(\w*)$/);
      if (match && commands) {
        const partial = match[1].toLowerCase();
        const matches = commands.filter((c: CommandInfo) => c.name.startsWith(partial));

        if (matches.length > 0) {
          if (suggestions.length === 0) {
            setSuggestions(matches);
            setSuggestIdx(0);
          }
          const idx = suggestions.length > 0 ? suggestIdx : 0;
          const selected = matches[idx];
          const nextIdx = (suggestIdx + 1) % matches.length;
          setSuggestIdx(nextIdx);
          setValue('/' + selected.name + value.slice(cursor));
          setCursor('/' .length + selected.name.length);
          return;
        }
      }
      setSuggestions([]);
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
      const lastSpace = before.lastIndexOf(' ');
      const keepLen = lastSpace === -1 ? 0 : lastSpace + 1;
      setValue((v: string) => v.slice(0, keepLen) + v.slice(cursor));
      setCursor(keepLen);
      return;
    }
    if (key.ctrl && input === 'l') { return; } // clear-screen noop in Ink

    if (input && !key.ctrl && !key.meta) {
      setValue((v: string) => v.slice(0, cursor) + input + v.slice(cursor));
      setCursor((c: number) => c + input.length);
      setSuggestions([]);
    }
  });

  const showSuggestions = suggestions.length > 0;

  return (
    <Box flexDirection="column" width="100%">
      {showSuggestions && (
        <Box flexDirection="column" marginLeft={1} marginBottom={1}>
          {suggestions.map((s: CommandInfo, i: number) => (
            <Box key={i}>
              <Text inverse={i === suggestIdx} {...t.colors.dim}>
                /{s.name} — {s.description}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      <Box>
        <Text>
          <Text {...(disabled ? t.colors.dim : t.colors.prompt)}>
            {mode ? `[${mode}] ` : ''}{'MMA> '}
          </Text>
          {disabled ? (
            <Text {...t.colors.dim}>{HINTS[hintIdx]}</Text>
          ) : (
            <Text>
              {value.slice(0, cursor)}
              <Text inverse>{value[cursor] || ' '}</Text>
              {value.slice(cursor + 1)}
            </Text>
          )}
        </Text>
      </Box>
    </Box>
  );
}
