import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getInkTheme } from '../theme.js';

interface SelectInputProps {
  question: string;
  choices: string[];
  onSelect: (value: string) => void;
}

export function SelectInput({ question, choices, onSelect }: SelectInputProps) {
  const [selected, setSelected] = useState(0);
  const t = getInkTheme();

  useInput((input: string, key: Record<string, boolean>) => {
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
    // Number keys for quick selection
    const num = parseInt(input, 10);
    if (num >= 1 && num <= choices.length) {
      onSelect(choices[num - 1]);
      return;
    }
  });

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Text {...t.colors.warning}>
        {question}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {choices.map((choice, i) => (
          <Box key={i}>
            <Text>
              {i === selected ? (
                <Text inverse> {choice} </Text>
              ) : (
                <Text>  {choice}  </Text>
              )}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text {...t.colors.dim}>  Use arrows to navigate, Enter to select</Text>
      </Box>
    </Box>
  );
}
