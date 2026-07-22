import React from 'react';
import { Box } from 'ink';
import { MessageBlock, type MessageItem } from './MessageBlock.js';
import { ToolCallBlock, type ToolCallData } from './ToolCallBlock.js';
import { StreamBlock, SpinnerLine } from './StreamBlock.js';

export type ConversationEntry =
  | { id: number; kind: 'message'; data: MessageItem }
  | { id: number; kind: 'tool_call'; data: ToolCallData };

export function Conversation({
  entries,
  streaming,
  streamingContent,
  isReasoning,
  showSpinner,
}: {
  entries: ConversationEntry[];
  streaming: boolean;
  streamingContent: string;
  isReasoning: boolean;
  showSpinner: boolean;
}) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {entries.map((entry: ConversationEntry) => (
        entry.kind === 'message' ? (
          <MessageBlock key={entry.id} item={entry.data as MessageItem} />
        ) : (
          <ToolCallBlock key={entry.id} data={entry.data as ToolCallData} />
        )
      ))}
      {showSpinner && !streaming && <SpinnerLine />}
      {streaming && <StreamBlock content={streamingContent} isReasoning={isReasoning} />}
    </Box>
  );
}
