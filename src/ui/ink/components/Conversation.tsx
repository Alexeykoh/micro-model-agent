import React from 'react';
import { Box } from 'ink';
import { MessageBlock, type MessageItem } from './MessageBlock.js';
import { ToolCallBlock, type ToolCallData } from './ToolCallBlock.js';

export type ConversationEntry =
  | { kind: 'message'; data: MessageItem }
  | { kind: 'tool_call'; data: ToolCallData };

export function Conversation({ entries }: { entries: ConversationEntry[] }) {
  const visible = entries.slice(-100);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {visible.map((entry, i) => {
        if (entry.kind === 'message') {
          return React.createElement(MessageBlock, { key: i, item: entry.data });
        }
        return React.createElement(ToolCallBlock, { key: i, data: entry.data });
      })}
    </Box>
  );
}
