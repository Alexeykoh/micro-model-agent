import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonrepair } from 'jsonrepair';
import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { parseFileRefs } from '../file-loader.js';
import { ContextManager } from './context.js';
import { autoLearnFromError } from './memory.js';
import { loadSkill, loadSkillsFromRefs, formatSkillsBlock } from '../skills/loader.js';
import { runPreToolUseHooks, runPostToolUseHooks } from '../tools/hooks.js';
import { isMCPCommand, parseMCPCommand, callMCPTool } from '../tools/mcp.js';
import { createPlan, updatePlanStep, showPlan, clearPlan, parsePlanCommand } from '../tools/plan.js';
import { addTodo, doneTodo, removeTodo, listTodos, parseTodoCommand } from '../tools/todo.js';
import { parseQuestionCommand } from '../tools/question.js';
import { parseApproveCommand } from '../tools/approve.js';
import { checkFileSyntax } from '../tools/syntax-check.js';
import type { OutputRenderer } from '../ui/renderer.js';
import { buildSystemPrompt } from './system-prompt.js';

function extractAllToolCalls(response: string): string[] {
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

    // Strip markdown code fences
    block = block.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');

    // Find JSON object
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

    // If no closing brace, take everything
    if (depth > 0 && jsonStart < block.length) {
      results.push(block.slice(jsonStart));
    }
  }

  return results;
}

function extractToolCallFallback(response: string): { name: string; cmd: string } | null {
  const patterns = [
    /"name"\s*:\s*"bash"\s*,\s*"arguments"\s*:\s*\{\s*"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    /"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    /name['"]\s*:\s*['"]bash['"]\s*,.*?cmd['"]\s*:\s*['"]((?:[^'\\]|\\.)*)['"]/,
  ];

  for (const re of patterns) {
    const m = response.match(re);
    if (m) {
      let cmd = m[1];
      cmd = cmd.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      return { name: 'bash', cmd };
    }
  }
  return null;
}

function validateToolCall(parsed: any): { valid: boolean; name?: string; cmd?: string; error?: string } {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, error: 'Not an object' };
  }

  const VALID_TOOLS = new Set(['bash', 'read_file', 'write_file', 'edit_file', 'list_dir', 'create_dir', 'delete_file', 'copy_file', 'move_file', 'file_info', 'glob_search', 'grep_search', 'tree']);

  if (!parsed.name || !VALID_TOOLS.has(parsed.name)) {
    return { valid: false, error: `Unknown tool: ${parsed.name}` };
  }
  if (!parsed.arguments || typeof parsed.arguments !== 'object') {
    return { valid: false, error: 'Missing arguments' };
  }

  if (parsed.name === 'bash') {
    const cmd = String(parsed.arguments.cmd ?? '').trim();
    if (!cmd) {
      return { valid: false, error: 'Empty command' };
    }
    return { valid: true, name: parsed.name, cmd };
  }

  const REQUIRED_ARGS: Record<string, string[]> = {
    read_file: ['path'],
    write_file: ['path', 'content'],
    edit_file: ['path', 'old_string', 'new_string'],
    list_dir: [],
    create_dir: ['path'],
    delete_file: ['path'],
    copy_file: ['source', 'destination'],
    move_file: ['source', 'destination'],
    file_info: ['path'],
    glob_search: ['pattern'],
    grep_search: ['pattern'],
    tree: [],
  };

  const required = REQUIRED_ARGS[parsed.name] ?? [];
  const missing = required.filter(k => {
    const v = parsed.arguments[k];
    return v === undefined || v === null || v === '';
  });

  if (missing.length > 0) {
    return { valid: false, error: `Missing required argument(s): ${missing.join(', ')}. Tool "${parsed.name}" requires: ${required.join(', ')}` };
  }

  return { valid: true, name: parsed.name };
}

async function doChat(
  provider: LLMProvider,
  messages: ChatMessage[],
  renderer: OutputRenderer,
  retries = 3,
): Promise<{ response: string; genTimeMs: number }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const startTime = performance.now();
    const fullText: string[] = [];
    let started = false;

    renderer.writeSpinner();

    try {
      let buf = '';
      for await (const chunk of provider.chat(messages, { temperature: 0.7, max_tokens: 8192 })) {
        if (!chunk.content) continue;
        fullText.push(chunk.content);

        if (!started) {
          renderer.clearSpinner();
          started = true;
        }

        buf += chunk.content;

        while (buf.length > 0) {
          const tcStart = buf.indexOf('<tool_call>');
          const tcEnd = buf.indexOf('</tool_call>');

          if (tcStart === -1 && tcEnd === -1) {
            renderer.writeMarkdownChunk(buf);
            buf = '';
            break;
          }

          if (tcStart !== -1 && (tcEnd === -1 || tcStart < tcEnd)) {
            if (tcStart > 0) {
              renderer.writeMarkdownChunk(buf.slice(0, tcStart));
            }
            buf = buf.slice(tcStart);
            const closeIdx = buf.indexOf('</tool_call>');
            if (closeIdx !== -1) {
              buf = buf.slice(closeIdx + '</tool_call>'.length);
            }
            break;
          }

          if (tcEnd !== -1 && (tcStart === -1 || tcEnd < tcStart)) {
            renderer.writeMarkdownChunk(buf.slice(0, tcEnd));
            buf = buf.slice(tcEnd + '</tool_call>'.length);
          }
        }
      }
    } catch (e: any) {
      renderer.writeError(`\n[LLM] ${e.message}`);
      renderer.writeWarning('[LLM] Check that your server is running (LM Studio on localhost:1234 or Ollama)');
      return { response: '', genTimeMs: 0 };
    }

    const genTimeMs = performance.now() - startTime;
    const response = fullText.join('');
    renderer.commitMarkdown();

    if (response.trim()) {
      renderer.writeToolResult((genTimeMs / 1000).toFixed(1));
      return { response, genTimeMs };
    }

    if (attempt < retries) {
      renderer.writeBracketTag('retry', `${attempt + 1}/${retries}`);
    }
  }

  return { response: '', genTimeMs: 0 };
}

export interface AgentLoopResult {
  messages: ChatMessage[];
  questionPending?: { question: string; choices?: string[] };
}

export async function runAgentLoop(
  provider: LLMProvider,
  registry: ToolRegistry,
  prompt: string,
  contextManager?: ContextManager,
  previousMessages?: ChatMessage[],
  renderer?: OutputRenderer,
  providerName?: string,
): Promise<AgentLoopResult> {
  const { prompt: enrichedPrompt, files } = await parseFileRefs(prompt);

  const loadedSkills = loadSkillsFromRefs(prompt, process.cwd());
  const loadedSkillNames = new Set(loadedSkills.map(s => s.name));
  if (loadedSkills.length > 0) {
    renderer?.writeInfo(`  Loaded ${loadedSkills.length} skill(s): ${loadedSkills.map(s => s.name).join(', ')} (~${loadedSkills.reduce((s, sk) => s + sk.tokens, 0)} tokens)`);
  }

  if (files.length > 0) {
    const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
    const totalLines = files.reduce((sum, f) => sum + f.content.split('\n').length, 0);
    renderer?.writeInfo(`  Loaded ${files.length} files (${totalLines} lines, ~${totalTokens} tokens)`);
    renderer?.writeNewline();
  }

  const systemPrompt = buildSystemPrompt(loadedSkills.length > 0 ? loadedSkills : undefined);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(previousMessages || []),
    { role: 'user', content: enrichedPrompt },
  ];

  const ctx = contextManager ?? new ContextManager(provider.contextWindow);
  let consecutiveEmpty = 0;
  let pendingSyntaxError = '';

  renderer?.updateStatus({
    provider: providerName,
    model: provider.model,
    contextWindow: provider.contextWindow,
    step: 0,
    maxSteps: 25,
  });

  for (let step = 0; step < 25; step++) {
    let skillsAutoLoaded = false;
    await ctx.updateTokens(messages);
    renderer?.updateContextUsage(ctx.formatUsage());

    renderer?.updateStatus({
      provider: providerName,
      model: provider.model,
      tokens: ctx.totalTokens,
      contextWindow: provider.contextWindow,
      step: step + 1,
      maxSteps: 25,
    });

    if (ctx.needsCompact && messages.length > 6) {
      const before = messages.length;
      messages.splice(0, messages.length, ...ctx.compact(messages));
      renderer?.writeBracketTag('compact', `${before} → ${messages.length} messages`);
      await ctx.updateTokens(messages);
    }

    const { response } = await doChat(provider, messages, renderer!);

    // Auto-load skills if model suggested them in response
    const suggestedSkillRefs = response.matchAll(/@(\w[\w-]*)/g);
    const newSkillNames: string[] = [];
    for (const match of suggestedSkillRefs) {
      const name = match[1];
      if (['email', 'api', 'id', 'json', 'url', 'http', 'https', 'localhost'].includes(name)) continue;
      if (!loadedSkillNames.has(name)) {
        const skill = loadSkill(name, process.cwd());
        if (skill) {
          newSkillNames.push(name);
          loadedSkills.push(skill);
          loadedSkillNames.add(name);
        }
      }
    }
    if (newSkillNames.length > 0) {
      skillsAutoLoaded = true;
      renderer?.writeInfo(`  Auto-loaded ${newSkillNames.length} skill(s): ${newSkillNames.join(', ')}`);
      messages[0] = { role: 'system', content: buildSystemPrompt(loadedSkills) };
      messages.push({ role: 'user', content: `[System: Skills loaded: ${newSkillNames.join(', ')}. They are in your context now. IMPORTANT: Use filesystem tools (write_file, create_dir, edit_file, read_file, etc.) for all file operations — NOT bash. Skills show bash examples for reference only. Create a plan and start working.]` });
    }

    if (!response.trim()) {
      consecutiveEmpty++;
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'tool' && consecutiveEmpty <= 3) {
        const retryPrompt = consecutiveEmpty === 1
          ? 'The tool result is above. Your turn now. Either: (1) call the next tool using <tool_call>{"name":"...","arguments":{...}}</tool_call>, or (2) write a text reply to the user summarizing progress. Do NOT output nothing.'
          : 'You returned an empty response again. You MUST write something now. Example of what to write: "File created. Now I will create the next file..." or call another tool. Silence is not allowed.';
        messages.push({ role: 'user', content: retryPrompt });
        renderer?.writeDim(`  [empty response #${consecutiveEmpty}, retrying]`);
        continue;
      }
      renderer?.writeError(consecutiveEmpty > 3
        ? `[model returned empty response ${consecutiveEmpty} times in a row — stopping]`
        : '[model returned empty response]');
      return { messages };
    }
    consecutiveEmpty = 0;

    messages.push({ role: 'assistant', content: response });

    const allJsonRaw = extractAllToolCalls(response);

    const validCalls: { parsed: any; cmd?: string }[] = [];
    for (const jsonRaw of allJsonRaw) {
      let p: any = null;
      try {
        p = JSON.parse(jsonrepair(jsonRaw));
      } catch {
        try { p = JSON.parse(jsonRaw); } catch { /* continue */ }
      }

      if (p) {
        const v = validateToolCall(p);
        if (v.valid) {
          validCalls.push({ parsed: p, cmd: v.cmd });
        }
      }
    }

    if (validCalls.length === 0) {
      const fallback = extractToolCallFallback(response);
      if (fallback) {
        validCalls.push({ parsed: { name: 'bash', arguments: { cmd: fallback.cmd } }, cmd: fallback.cmd });
        renderer?.writeBracketTag('fallback', 'regex extracted command');
      }
    }

    if (validCalls.length === 0) {
      if (!skillsAutoLoaded) {
        return { messages };
      }
      continue;
    }

    for (const call of validCalls) {
      const { parsed, cmd } = call;
      const isBash = parsed.name === 'bash';
      const preview = isBash
        ? (cmd!.length > 200 ? cmd!.slice(0, 200) + '...' : cmd!)
        : JSON.stringify(parsed.arguments).slice(0, 200);
      const toolId = `call-${Date.now()}-${step}-${Math.random().toString(36).slice(2, 6)}`;

      renderer?.writeToolHeader(parsed.name);
      renderer?.writeToolPreview(preview);

      const hookCmd = isBash ? cmd! : `${parsed.name} ${JSON.stringify(parsed.arguments)}`;
      const preHook = runPreToolUseHooks(process.cwd(), parsed.name, hookCmd);
      if (!preHook.continue) {
        renderer?.writeBracketTag('hook blocked', preHook.message || '');
        messages.push({ role: 'tool', content: `Hook blocked: ${preHook.message || ''}`, tool_call_id: toolId });
        continue;
      }

      if (pendingSyntaxError && !isBash) {
        const isWriteOp = parsed.name === 'write_file' || parsed.name === 'edit_file';
        if (isWriteOp && String(parsed.arguments.path ?? '') !== pendingSyntaxError) {
          const blocked = `BLOCKED: You have a syntax error in ${pendingSyntaxError}. Fix it first before writing new files.`;
          renderer?.writeError(`  [blocked: fix syntax error in ${pendingSyntaxError} first]`);
          messages.push({ role: 'tool', content: blocked, tool_call_id: toolId });
          continue;
        }
      }

      let toolOutput = '';
      let toolExitCode = 0;
      const toolStart = performance.now();

      // Bash-specific prefix commands (plan/todo/question/approve/mcp)
      if (isBash && cmd!.startsWith('plan ')) {
        const planArgs = cmd!.slice(5).trim();
        const { action, params } = parsePlanCommand(planArgs);
        renderer?.writeBracketTag('plan', action);
        switch (action) {
          case 'create':
            toolOutput = createPlan(params[0] || 'Untitled Plan', params.slice(1));
            break;
          case 'done':
            toolOutput = updatePlanStep(parseInt(params[0]) || 0, 'done');
            break;
          case 'progress':
            toolOutput = updatePlanStep(parseInt(params[0]) || 0, 'in_progress');
            break;
          case 'show':
            toolOutput = showPlan();
            break;
          case 'clear':
            toolOutput = clearPlan();
            break;
          default:
            toolOutput = 'Unknown plan action. Use: create, done, progress, show, clear';
            toolExitCode = 1;
        }
      } else if (isBash && cmd!.startsWith('todo ')) {
        const todoArgs = cmd!.slice(5).trim();
        const { action, params } = parseTodoCommand(todoArgs);
        renderer?.writeBracketTag('todo', action);
        switch (action) {
          case 'add':
            toolOutput = addTodo(params);
            break;
          case 'done':
            toolOutput = doneTodo(params);
            break;
          case 'remove':
          case 'rm':
            toolOutput = removeTodo(params);
            break;
          case 'list':
          case 'ls':
            toolOutput = listTodos();
            break;
          default:
            toolOutput = 'Unknown todo action. Use: add, done, remove, list';
            toolExitCode = 1;
        }
      } else if (isBash && cmd!.startsWith('question ')) {
        const qArgs = cmd!.slice(9).trim();
        const { question, choices } = parseQuestionCommand(qArgs);
        renderer?.writeBracketTag('question', question);
        messages.push({
          role: 'tool',
          content: `Question asked: ${question}`,
          tool_call_id: toolId,
        });
        return {
          messages,
          questionPending: { question, choices: choices.length > 0 ? choices : undefined },
        };
      } else if (isBash && cmd!.startsWith('approve ')) {
        const approveArgs = cmd!.slice(8).trim();
        const action = parseApproveCommand(approveArgs);
        renderer?.writeBracketTag('approve', action);
        messages.push({
          role: 'tool',
          content: `Approval requested: ${action}`,
          tool_call_id: toolId,
        });
        return {
          messages,
          questionPending: { question: `Approve: ${action}?`, choices: ['Yes', 'No'] },
        };
      } else if (isBash && isMCPCommand(cmd!)) {
        const mcpCmd = parseMCPCommand(cmd!);
        if (mcpCmd) {
          renderer?.writeBracketTag('mcp', `${mcpCmd.server}/${mcpCmd.tool}`);
          toolOutput = callMCPTool(process.cwd(), mcpCmd.server, mcpCmd.tool, mcpCmd.args);
        } else {
          toolOutput = 'Invalid MCP command. Format: mcp <server> <tool> [args_json]';
          toolExitCode = 1;
        }
      } else if (!isBash) {
        const result = await registry.execute({ id: toolId, name: parsed.name, arguments: parsed.arguments });
        toolOutput = result.stdout || result.stderr || '(no output)';
        toolExitCode = result.exitCode;
      } else {
        const result = await registry.execute({ id: toolId, name: 'bash', arguments: { cmd, timeout: parsed.arguments?.timeout ?? 120 } });
        toolOutput = result.stdout || result.stderr || '(no output)';
        toolExitCode = result.exitCode;
      }

      const toolTime = ((performance.now() - toolStart) / 1000).toFixed(1);
      renderer?.writeToolResult(toolTime, toolExitCode);
      if (toolExitCode !== 0) {
        const errText = toolOutput;
        for (const line of errText.split('\n').slice(0, 5)) {
          renderer?.writeError(`  ${line}`);
        }
        autoLearnFromError(hookCmd, toolExitCode !== 0 ? toolOutput : '', '');
      }

      runPostToolUseHooks(process.cwd(), parsed.name, hookCmd, toolOutput, toolExitCode);

      // Syntax check after file write operations
      let hasSyntaxError = false;
      if (toolExitCode === 0) {
        const isWriteOp = isBash
          ? (cmd!.match(/Set-Content|Add-Content/))
          : (parsed.name === 'write_file' || parsed.name === 'edit_file');
        if (isWriteOp) {
          const rawPath = isBash
            ? cmd!.match(/-Path\s+['"]?([^'"]+\.(?:ts|tsx|js|jsx|json))['"]?/i)?.[1]?.replace(/\\/g, '/')
            : String(parsed.arguments.path ?? '');
          if (rawPath && /\.(ts|tsx|js|jsx|json)$/.test(rawPath)) {
            const { isAbsolute, relative } = await import('node:path');
            const filePath = isAbsolute(rawPath) ? relative(process.cwd(), rawPath).replace(/\\/g, '/') : rawPath;
            const syntaxResult = checkFileSyntax(filePath, process.cwd());
            if (syntaxResult !== 'OK') {
              const errorLines = syntaxResult.split('\n').filter(l => l.trim());
              const shown = errorLines.slice(0, 3);
              const extra = errorLines.length > 3 ? ` (+${errorLines.length - 3} more)` : '';
              renderer?.writeBracketTag('syntax', `${shown.join('; ')}${extra}`);

              const fullPath = join(process.cwd(), filePath);
              let contextLines = '';
              try {
                const fileContent = readFileSync(fullPath, 'utf-8').split('\n');
                for (const errLine of shown) {
                  const lineMatch = errLine.match(/\((\d+),\d+\)/);
                  if (lineMatch) {
                    const lineNum = parseInt(lineMatch[1]);
                    if (lineNum > 0 && lineNum <= fileContent.length) {
                      const start = Math.max(0, lineNum - 2);
                      const end = Math.min(fileContent.length, lineNum + 1);
                      contextLines += `\n--- Line ${lineNum} ---\n`;
                      for (let i = start; i < end; i++) {
                        const marker = i === lineNum - 1 ? ' >> ' : '    ';
                        contextLines += `${marker}${i + 1}: ${fileContent[i]}\n`;
                      }
                    }
                  }
                }
              } catch { /* ignore read errors */ }

              toolOutput = `SYNTAX ERROR in ${filePath}:\n${syntaxResult}${contextLines}\n\nDo NOT rewrite the entire file. Use edit_file to fix the specific broken line:\n{"name":"edit_file","arguments":{"path":"${filePath}","old_string":"broken code here","new_string":"fixed code here"}}`;
              hasSyntaxError = true;
              pendingSyntaxError = filePath;
            } else {
              if (pendingSyntaxError === filePath) {
                pendingSyntaxError = '';
              }
            }
          }
        }
      }

      if (isBash && cmd!.startsWith('plan ') && toolExitCode === 0) {
        const planOutput = showPlan();
        if (planOutput && !planOutput.startsWith('No active plan')) {
          renderer?.writeNewline();
          renderer?.writeLine(planOutput);
        }
      }

      if (isBash && cmd!.startsWith('todo ') && toolExitCode === 0) {
        const todoOutput = listTodos();
        if (todoOutput) {
          renderer?.writeNewline();
          renderer?.writeLine(todoOutput);
        }
      }

      messages.push({
        role: 'tool',
        content: toolOutput.slice(0, 4000),
        tool_call_id: toolId,
      });

      if (hasSyntaxError) {
        break;
      }
    }
  }
  return { messages };
}
