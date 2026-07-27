import { jsonrepair } from 'jsonrepair';
import { validateToolCall } from './subagent.js';

export interface ParsedCall {
  parsed: Record<string, unknown>;
  cmd?: string;
}

export interface ParseResult {
  validCalls: ParsedCall[];
  invalidCalls: string[];
}

export function extractAllToolCalls(response: string): string[] {
  const results: string[] = [];
  let text = response;

  while (true) {
    const tcStart = text.indexOf('<tool_call>');
    if (tcStart === -1) break;

    const tcEnd = text.indexOf('</tool_call>', tcStart);
    let block: string;
    if (tcEnd !== -1) {
      block = text.slice(tcStart + '<tool_call>'.length, tcEnd);
      text = text.slice(tcEnd + '</tool_call>'.length);
    } else {
      block = text.slice(tcStart + '<tool_call>'.length);
      text = '';
    }

    block = block.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');

    const jsonStart = block.indexOf('{');
    if (jsonStart === -1) continue;

    let depth = 0;
    let inStr = false;
    let esc = false;

    for (let i = jsonStart; i < block.length; i++) {
      const ch = block[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth === 0) {
        results.push(block.slice(jsonStart, i + 1));
        break;
      }
    }

    if (depth > 0 && jsonStart < block.length) {
      results.push(block.slice(jsonStart));
    }
  }

  return results;
}

export function parseToolCalls(response: string): ParseResult {
  const allJsonRaw = extractAllToolCalls(response);
  const validCalls: ParsedCall[] = [];
  const invalidCalls: string[] = [];

  for (const jsonRaw of allJsonRaw) {
    let p: Record<string, unknown> | null = null;
    try {
      p = JSON.parse(jsonrepair(jsonRaw)) as Record<string, unknown>;
    } catch {
      try { p = JSON.parse(jsonRaw) as Record<string, unknown>; } catch { /* skip */ }
    }

    if (p) {
      const v = validateToolCall(p);
      if (v.valid) {
        validCalls.push({ parsed: p, cmd: v.cmd });
      } else if (v.error) {
        invalidCalls.push(v.error);
      }
    }
  }

  return { validCalls, invalidCalls };
}
