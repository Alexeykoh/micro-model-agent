import { Box, Text } from 'ink';
import { getInkTheme } from '../theme.js';

export function InfoTag({ children }: { children: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.info}>ℹ {children}</Text>;
}

export function SuccessTag({ children }: { children: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.success}>✓ {children}</Text>;
}

export function WarningTag({ children }: { children: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.warning}>⚠ {children}</Text>;
}

export function ErrorTag({ children }: { children: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.error}>✗ {children}</Text>;
}

export function DimText({ children }: { children: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.dim}>{children}</Text>;
}

export function HeadingTag({ children }: { children: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.heading}>{children}</Text>;
}

export function BracketTag({ tag, message }: { tag: string; message: string }) {
  const t = getInkTheme();
  const tagColor = tag === 'user' ? 'yellow' : 'dim';
  return (
    <Box>
      <Text bold color={tagColor}>[{tag}]</Text>
      <Text> {message}</Text>
    </Box>
  );
}

export function LineNumbers({ text }: { text: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.lineNumbers}>{text}</Text>;
}
