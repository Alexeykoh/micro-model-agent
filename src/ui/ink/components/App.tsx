import React, { useReducer, useEffect } from 'react';
import { Box } from 'ink';
import { Conversation, type ConversationEntry } from './Conversation.js';
import { StreamBlock, SpinnerLine } from './StreamBlock.js';
import { StatusBar } from './StatusBar.js';
import { PromptInput } from './PromptInput.js';

interface StatusInfo {
  provider?: string;
  model?: string;
  tokens?: number;
  contextWindow?: number;
  step?: number;
  maxSteps?: number;
}

interface AppState {
  entries: ConversationEntry[];
  streaming: boolean;
  streamingContent: string;
  isReasoning: boolean;
  showSpinner: boolean;
  status: StatusInfo;
  contextUsage: string;
  showPrompt: boolean;
  promptMessage: string;
  toolCallIndex: number;
}

export type Action =
  | { type: 'ADD_MESSAGE'; kind: 'message'; data: any }
  | { type: 'ADD_TOOL_CALL'; data: any }
  | { type: 'TOOL_PREVIEW'; data: any }
  | { type: 'TOOL_END'; data: any }
  | { type: 'STREAM_CHUNK'; chunk: string }
  | { type: 'STREAM_REASONING'; text: string }
  | { type: 'STREAM_END' }
  | { type: 'SPINNER'; show: boolean }
  | { type: 'STATUS'; info: StatusInfo }
  | { type: 'CONTEXT'; text: string }
  | { type: 'SHOW_PROMPT'; message: string }
  | { type: 'HIDE_PROMPT' }
  | { type: 'CLEAR' };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'ADD_MESSAGE':
      return { ...state, entries: [...state.entries, { kind: 'message', data: action.data }] };
    case 'ADD_TOOL_CALL':
      return {
        ...state,
        toolCallIndex: state.entries.length,
        entries: [...state.entries, { kind: 'tool_call', data: { name: action.data.name, args: action.data.args || '', result: '', time: '' } }],
      };
    case 'TOOL_PREVIEW': {
      const idx = state.toolCallIndex;
      if (idx < 0 || idx >= state.entries.length) return state;
      const entry = state.entries[idx];
      if (entry.kind !== 'tool_call') return state;
      const updated = { ...entry, data: { ...entry.data, args: action.data.args || entry.data.args } };
      const entries = [...state.entries];
      entries[idx] = updated;
      return { ...state, entries };
    }
    case 'TOOL_END': {
      const idx = state.toolCallIndex;
      if (idx < 0 || idx >= state.entries.length) return state;
      const entry = state.entries[idx];
      if (entry.kind !== 'tool_call') return state;
      const updated = {
        ...entry,
        data: {
          ...entry.data,
          result: action.data.result || '',
          time: action.data.time || '',
          exitCode: action.data.exitCode,
        },
      };
      const entries = [...state.entries];
      entries[idx] = updated;
      return { ...state, entries };
    }
    case 'STREAM_CHUNK':
      return { ...state, streaming: true, streamingContent: state.streamingContent + action.chunk };
    case 'STREAM_REASONING':
      return { ...state, streaming: true, streamingContent: action.text, isReasoning: true };
    case 'STREAM_END': {
      const content = state.streamingContent;
      if (!content) return { ...state, streaming: false, streamingContent: '', isReasoning: false };
      const newEntry: ConversationEntry = { kind: 'message', data: { type: 'message', content } };
      return {
        ...state,
        entries: [...state.entries, newEntry],
        streaming: false,
        streamingContent: '',
        isReasoning: false,
      };
    }
    case 'SPINNER':
      return { ...state, showSpinner: action.show };
    case 'STATUS':
      return { ...state, status: { ...state.status, ...action.info } };
    case 'CONTEXT':
      return { ...state, contextUsage: action.text };
    case 'SHOW_PROMPT':
      return { ...state, showPrompt: true, promptMessage: action.message };
    case 'HIDE_PROMPT':
      return { ...state, showPrompt: false, promptMessage: '' };
    case 'CLEAR':
      return {
        entries: [],
        streaming: false,
        streamingContent: '',
        isReasoning: false,
        showSpinner: false,
        status: {},
        contextUsage: '',
        showPrompt: false,
        promptMessage: '',
        toolCallIndex: -1,
      };
    default:
      return state;
  }
}

const initialState: AppState = {
  entries: [],
  streaming: false,
  streamingContent: '',
  isReasoning: false,
  showSpinner: false,
  status: {},
  contextUsage: '',
  showPrompt: false,
  promptMessage: '',
  toolCallIndex: -1,
};

export interface AppHandle {
  dispatch(action: Action): void;
  setPromptResolve(fn: ((value: string) => void) | null): void;
  getPromptResolve(): ((value: string) => void) | null;
}

interface AppProps {
  onReady: (handle: AppHandle) => void;
  commands?: { name: string; description: string }[];
}

export function App({ onReady, commands }: AppProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const promptResolveRef = React.useRef<((value: string) => void) | null>(null);

  useEffect(() => {
    onReady({
      dispatch,
      setPromptResolve(fn) { promptResolveRef.current = fn; },
      getPromptResolve() { return promptResolveRef.current; },
    });
  }, []);

  return (
    <Box flexDirection="column" height="100%">
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        <Conversation entries={state.entries} />
        {state.showSpinner && !state.streaming && <SpinnerLine />}
        {state.streaming && <StreamBlock content={state.streamingContent} isReasoning={state.isReasoning} />}
      </Box>
      {state.showPrompt && (
        <PromptInput
          commands={commands}
          onSubmit={(value) => {
            const resolve = promptResolveRef.current;
            if (resolve) {
              promptResolveRef.current = null;
              resolve(value);
            }
            dispatch({ type: 'HIDE_PROMPT' });
          }}
        />
      )}
      <StatusBar info={state.status} usage={state.contextUsage} />
    </Box>
  );
}
