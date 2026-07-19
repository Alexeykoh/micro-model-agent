import React, { useReducer, useEffect } from 'react';
import { Box, useInput } from 'ink';
import { Conversation, type ConversationEntry } from './Conversation.js';
import { StatusBar } from './StatusBar.js';
import { PromptInput } from './PromptInput.js';
import { SelectInput } from './SelectInput.js';

/**
 * Главный компонент Ink-приложения.
 *
 * Управляет:
 * - Состоянием диалога (входы, tool calls, streaming)
 * - Статус-баром (модель, шаги, токены)
 * - Вводом пользователя (с автодополнением)
 * - Выбором (question tool)
 * - Прерыванием (double ESC)
 *
 * @module ui/ink/components/App
 */

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
  nextId: number;
  streaming: boolean;
  streamingContent: string;
  isReasoning: boolean;
  showSpinner: boolean;
  status: StatusInfo;
  contextUsage: string;
  showPrompt: boolean;
  promptMessage: string;
  showSelect: boolean;
  selectQuestion: string;
  selectChoices: string[];
  toolCallIndex: number;
  mode: string;
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
  | { type: 'SHOW_SELECT'; question: string; choices: string[] }
  | { type: 'HIDE_SELECT' }
  | { type: 'SET_MODE'; mode: string }
  | { type: 'CLEAR' };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'ADD_MESSAGE': {
      const data = { ...action.data };
      if (data.tag === 'user') data.role = 'user';
      return {
        ...state,
        nextId: state.nextId + 1,
        entries: [...state.entries, { id: state.nextId, kind: 'message', data }],
      };
    }
    case 'ADD_TOOL_CALL':
      return {
        ...state,
        nextId: state.nextId + 1,
        toolCallIndex: state.entries.length,
        entries: [...state.entries, { id: state.nextId, kind: 'tool_call', data: { name: action.data.name, args: action.data.args || '', result: '', time: '' } }],
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
      const newEntry: ConversationEntry = { id: state.nextId, kind: 'message', data: { type: 'message', content, role: 'assistant' } };
      return {
        ...state,
        nextId: state.nextId + 1,
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
    case 'SHOW_SELECT':
      return { ...state, showSelect: true, selectQuestion: action.question, selectChoices: action.choices };
    case 'HIDE_SELECT':
      return { ...state, showSelect: false, selectQuestion: '', selectChoices: [] };
    case 'SET_MODE':
      return { ...state, mode: action.mode };
    case 'CLEAR':
      return {
        entries: [],
        nextId: 1,
        streaming: false,
        streamingContent: '',
        isReasoning: false,
        showSpinner: false,
        status: {},
        contextUsage: '',
        showPrompt: false,
        promptMessage: '',
        showSelect: false,
        selectQuestion: '',
        selectChoices: [],
        toolCallIndex: -1,
        mode: '',
      };
    default:
      return state;
  }
}

const initialState: AppState = {
  entries: [],
  nextId: 1,
  streaming: false,
  streamingContent: '',
  isReasoning: false,
  showSpinner: false,
  status: {},
  contextUsage: '',
  showPrompt: false,
  promptMessage: '',
  showSelect: false,
  selectQuestion: '',
  selectChoices: [],
  toolCallIndex: -1,
  mode: '',
};

export interface AppHandle {
  dispatch(action: Action): void;
  setPromptResolve(fn: ((value: string) => void) | null): void;
  getPromptResolve(): ((value: string) => void) | null;
  setSelectResolve(fn: ((value: string) => void) | null): void;
  getSelectResolve(): ((value: string) => void) | null;
}

interface AppProps {
  onReady: (handle: AppHandle) => void;
  commands?: { name: string; description: string }[];
  onAbort?: () => void;
}

export function App({ onReady, commands, onAbort }: AppProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const promptResolveRef = React.useRef<((value: string) => void) | null>(null);
  const selectResolveRef = React.useRef<((value: string) => void) | null>(null);
  const lastCtrlCTime = React.useRef<number>(0);

  // Handle Escape key to abort agent execution + double Ctrl+C to exit
  useInput((input: string, key: Record<string, boolean>) => {
    if (key.escape && onAbort && !state.showPrompt && !state.showSelect) {
      onAbort();
      return;
    }
    // Double Ctrl+C to exit
    if (key.ctrl && input === 'c') {
      const now = Date.now();
      if (now - lastCtrlCTime.current < 500) {
        // Double Ctrl+C — exit
        process.exit(0);
      }
      lastCtrlCTime.current = now;
      // Show hint via dispatch
      if (!state.showPrompt && !state.showSelect) {
        dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'dim', content: '  Press Ctrl+C again to exit' } });
      }
    }
  });

  useEffect(() => {
    onReady({
      dispatch,
      setPromptResolve(fn) { promptResolveRef.current = fn; },
      getPromptResolve() { return promptResolveRef.current; },
      setSelectResolve(fn) { selectResolveRef.current = fn; },
      getSelectResolve() { return selectResolveRef.current; },
    });
  }, []);

  return (
    <Box flexDirection="column" height="100%">
      <Conversation
        entries={state.entries}
        streaming={state.streaming}
        streamingContent={state.streamingContent}
        isReasoning={state.isReasoning}
        showSpinner={state.showSpinner}
      />
      <Box flexShrink={0} marginTop={1}>
        {state.showSelect ? (
          <SelectInput
            question={state.selectQuestion}
            choices={state.selectChoices}
            onSelect={(value) => {
              const resolve = selectResolveRef.current;
              if (resolve) {
                selectResolveRef.current = null;
                resolve(value);
              }
              dispatch({ type: 'HIDE_SELECT' });
            }}
          />
        ) : (
          <PromptInput
            commands={commands}
            disabled={!state.showPrompt}
            mode={state.mode}
            onSubmit={(value) => {
              const resolve = promptResolveRef.current;
              if (resolve) {
                promptResolveRef.current = null;
                resolve(value);
              }
              dispatch({ type: 'HIDE_PROMPT' });
            }}
            onAbort={onAbort}
          />
        )}
      </Box>
      <Box flexShrink={0}>
        <StatusBar info={state.status} usage={state.contextUsage} />
      </Box>
    </Box>
  );
}
