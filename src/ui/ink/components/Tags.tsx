import React from 'react';
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
  return <Text bold>{children}</Text>;
}

export function BracketTag({ tag, message }: { tag: string; message: string }) {
  const t = getInkTheme();
  const tagStyle = tag === 'user' ? { color: 'yellow' as const, bold: true } : { ...t.colors.info, bold: true };
  return (
    <Box>
      <Text {...tagStyle}>[{tag}]</Text>
      <Text> {message}</Text>
    </Box>
  );
}

export function LineNumbers({ text }: { text: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.lineNumbers}>{text}</Text>;
}

/** Визуальный разделитель между блоками */
export function TurnSeparator() {
  const t = getInkTheme();
  return (
    <Box marginTop={0} marginBottom={0}>
      <Text {...t.colors.dim}>{'─'.repeat(60)}</Text>
    </Box>
  );
}
