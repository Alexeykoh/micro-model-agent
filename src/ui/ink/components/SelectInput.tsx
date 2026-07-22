import React, { useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import { getInkTheme } from '../theme.js';

interface SelectInputProps {
  question: string;
  choices: string[];
  onSelect: (value: string) => void;
}

export function SelectInput({ question, choices, onSelect }: SelectInputProps) {
  const [selected, setSelected] = useState(0);
  const t = getInkTheme();

  useInput((input: string, key: Key) => {
    if (key.upArrow) {
      setSelected((i) => (i > 0 ? i - 1 : choices.length - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((i) => (i < choices.length - 1 ? i + 1 : 0));
      return;
    }
    if (key.return) {
      onSelect(choices[selected]);
      return;
    }
    const num = parseInt(input, 10);
    if (num >= 1 && num <= choices.length) {
      onSelect(choices[num - 1]);
      return;
    }
  });

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Text bold color="yellow">{'> '}{question}</Text>
      <Box marginTop={1} flexDirection="column">
        {choices.map((choice, i) => (
          <Box key={i}>
            <Text>
              {i === selected ? (
                <Text bold color="yellow">{'  ▸ '}{choice}{' '}</Text>
              ) : (
                <Text {...t.colors.dim}>{`  ${i + 1}. ${choice}  `}</Text>
              )}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text {...t.colors.dim}>{'  '}↑↓ navigate · Enter select · 1-9 quick</Text>
      </Box>
    </Box>
  );
}
