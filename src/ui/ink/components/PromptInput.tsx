import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getInkTheme } from '../theme.js';

interface CommandInfo {
  name: string;
  description: string;
}

export function PromptInput({
  commands,
  onSubmit,
  disabled,
}: {
  commands?: CommandInfo[];
  onSubmit: (value: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [suggestions, setSuggestions] = useState<CommandInfo[]>([]);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const t = getInkTheme();

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
      <Box width="100%">
        <Text {...(disabled ? t.colors.dim : t.colors.prompt)}>{'MMA> '}</Text>
        {disabled ? (
          <Text {...t.colors.dim}>{'...'}</Text>
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
