import { Box, Text } from 'ink';
import { getInkTheme } from '../theme.js';

export function StreamBlock({ content, isReasoning }: { content: string; isReasoning: boolean }) {
  const t = getInkTheme();
  if (isReasoning) {
    return (
      <Box flexDirection="column" marginLeft={1}>
        <Text {...t.colors.dim} italic>{content}</Text>
      </Box>
    );
  }
  return (
    <Box marginLeft={1}>
      <Text>{content}</Text>
    </Box>
  );
}

export function SpinnerLine({ text }: { text?: string }) {
  const t = getInkTheme();
  return (
    <Text>
      <Text {...t.colors.dim}>⏳</Text>
      {text ? <Text> {text}</Text> : null}
    </Text>
  );
}
