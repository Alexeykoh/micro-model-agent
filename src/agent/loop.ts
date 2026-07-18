import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonrepair } from 'jsonrepair';
import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { parseFileRefs } from '../file-loader.js';
import { ContextManager } from './context.js';
import { autoLearnFromError } from './memory.js';
import { appendNote, collectCodingStyle, loadProfile } from './user-profile.js';
import { loadSkill, loadSkillsFromRefs, formatSkillsBlock } from '../skills/loader.js';
import { runPreToolUseHooks, runPostToolUseHooks } from '../tools/hooks.js';
import { isMCPCommand, parseMCPCommand, callMCPTool } from '../tools/mcp.js';
import { createPlan, updatePlanStep, showPlan, clearPlan, parsePlanCommand } from '../tools/plan.js';
import { addTodo, doneTodo, removeTodo, listTodos, parseTodoCommand } from '../tools/todo.js';
import { parseQuestionCommand } from '../tools/question.js';
import { parseApproveCommand } from '../tools/approve.js';
import { checkFileSyntax } from '../tools/syntax-check.js';
import { listThemes, switchTheme } from '../styling/index.js';
import { loadThemeConfig, installTheme, removeTheme } from '../styling/loader.js';
import { loadConfig, saveConfig } from '../config/config.js';
import type { OutputRenderer } from '../ui/renderer.js';
import { buildSystemPrompt } from './system-prompt.js';
import { logInfo, logWarn, logDebug, logLLMRequest, logLLMResponse, logToolCall, setStatusWriter, writeStatus } from '../logger.js';
import type { AgentMode } from '../config/types.js';

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

  const VALID_TOOLS = new Set(['bash', 'plan', 'todo', 'question', 'approve', 'theme', 'user_profile', 'read_file', 'write_file', 'edit_file', 'list_dir', 'create_dir', 'delete_file', 'copy_file', 'move_file', 'file_info', 'glob_search', 'grep_search', 'tree', 'web_search', 'web_fetch']);

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
    web_search: ['query'],
    web_fetch: ['url'],
    user_profile: [],
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
  signal?: AbortSignal,
  retries = 1,
  showThinking = false,
): Promise<{ response: string; genTimeMs: number }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const startTime = performance.now();
    const fullText: string[] = [];
    let started = false;
    let reasoningBuf: string | false = false;

    if (signal?.aborted) return { response: '', genTimeMs: 0 };

    const lastMsg = messages[messages.length - 1];
    logLLMRequest(provider.model, messages.length, lastMsg?.content || '');

    renderer.writeSpinner();

    try {
      let buf = '';
      for await (const chunk of provider.chat(messages, { temperature: 0.7, max_tokens: 8192, signal, showThinking })) {
        if (!chunk.content && !chunk.reasoning) continue;
        if (chunk.content) fullText.push(chunk.content);

        if (!started) {
          renderer.clearSpinner();
          started = true;
        }

        if (chunk.reasoning) {
          if (showThinking) {
            if (reasoningBuf === false) {
              renderer.writeNewline();
              renderer.writeDim('┈ reasoning ┈');
              reasoningBuf = '';
            }
            reasoningBuf += chunk.reasoning;
          }
          continue;
        }

        if (reasoningBuf !== false) {
          renderer.writeNewline();
          renderer.writeDim(reasoningBuf);
          reasoningBuf = false;
        }

        buf += chunk.content;

        while (buf.length > 0) {
          const tcStart = buf.indexOf('<tool_call>');
          const tcEnd = buf.indexOf('</tool_call>');

          if (tcStart === -1 && tcEnd === -1) {
            if (buf) renderer.writeMarkdownChunk(buf);
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
    if (reasoningBuf !== false) {
      renderer.writeNewline();
      renderer.writeDim(reasoningBuf);
    }

    } catch (e: any) {
      if (e.name === 'AbortError') {
        logLLMResponse(provider.model, 0, performance.now() - startTime, 'Aborted');
        return { response: '', genTimeMs: 0 };
      }
      logLLMResponse(provider.model, 0, performance.now() - startTime, e.message);
      renderer.writeError(`\n[LLM] ${e.message}`);
      renderer.writeWarning('[LLM] Check that your server is running (LM Studio on localhost:1234 or Ollama)');
      return { response: '', genTimeMs: 0 };
    }

    const genTimeMs = performance.now() - startTime;
    const response = fullText.join('');
    renderer.commitMarkdown();

    if (response.trim()) {
      logLLMResponse(provider.model, response.length, genTimeMs);
      return { response, genTimeMs };
    }

    if (attempt < retries) {
      renderer.writeDim(`[retry ${attempt + 1}/${retries}]`);
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
  options?: { quiet?: boolean; showThinking?: boolean; mode?: AgentMode },
): Promise<AgentLoopResult> {
  logInfo('LOOP', `runAgentLoop started: "${prompt.slice(0, 50)}"`);
  renderer?.resetAbort?.();
  const { prompt: enrichedPrompt, files } = await parseFileRefs(prompt);
  logDebug('LOOP', `parseFileRefs: ${files.length} files, prompt len: ${enrichedPrompt.length}`);
  const quiet = options?.quiet ?? false;

  const loadedSkills = loadSkillsFromRefs(prompt, process.cwd());
  const loadedSkillNames = new Set(loadedSkills.map(s => s.name));
  if (loadedSkills.length > 0) {
    logInfo('LOOP', `loaded ${loadedSkills.length} skills: ${loadedSkills.map(s => s.name).join(', ')}`);
    renderer?.writeInfo(`  Loaded ${loadedSkills.length} skill(s): ${loadedSkills.map(s => s.name).join(', ')}`);
  }

  if (options?.mode === 'pro' && !loadedSkillNames.has('grill-me')) {
    const grill = loadSkill('grill-me', process.cwd());
    if (grill) {
      loadedSkills.push(grill);
      loadedSkillNames.add('grill-me');
      logInfo('LOOP', 'auto-loaded grill-me skill for pro mode');
      renderer?.writeInfo('  Auto-loaded @grill-me skill for pro mode');
    } else {
      logWarn('LOOP', 'grill-me skill not found for pro mode');
      renderer?.writeWarning('  Warning: @grill-me skill not found (required for pro mode)');
    }
  }

  if (files.length > 0) {
    const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
    const totalLines = files.reduce((sum, f) => sum + f.content.split('\n').length, 0);
    logInfo('LOOP', `loaded ${files.length} files (${totalLines} lines, ~${totalTokens} tokens)`);
    renderer?.writeInfo(`  Loaded ${files.length} files (${totalLines} lines, ~${totalTokens} tokens)`);
    renderer?.writeNewline();
  }

  setStatusWriter(renderer ? (msg) => renderer.writeDim(`  ${msg}`) : null);
  writeStatus('Initializing...');
  const sysStart = performance.now();
  const systemPrompt = buildSystemPrompt(loadedSkills.length > 0 ? loadedSkills : undefined, options?.mode);
  const sysElapsed = ((performance.now() - sysStart) / 1000).toFixed(1);
  writeStatus(`Done (${sysElapsed}s)`);
  setStatusWriter(null);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(previousMessages || []),
    { role: 'user', content: enrichedPrompt },
  ];

  const ctx = contextManager ?? new ContextManager(provider.contextWindow);
  const config = loadConfig();
  const maxSteps = config.agent.maxSteps ?? 100;
  let consecutiveEmpty = 0;
  let pendingSyntaxError = '';
  let aborted = false;
  let continuationNudges = 0;

  // Reset abort signal for this run
  if (renderer?.abortSignal === undefined) {
    // Renderer doesn't support abort — fine
  }

  renderer?.updateStatus({
    provider: providerName,
    model: provider.model,
    contextWindow: provider.contextWindow,
    step: 0,
    maxSteps,
  });

  for (let step = 0; step < maxSteps; step++) {
    if (renderer?.abortSignal?.aborted) {
      aborted = true;
      break;
    }
    let skillsAutoLoaded = false;
    logDebug('LOOP', `step ${step + 1}/${maxSteps} starting, ${messages.length} messages`);
    await ctx.updateTokens(messages);
    const skillNames = loadedSkills.map(s => s.name).join(', ');
    const usageText = ctx.formatUsage() + (skillNames ? ` │ skills: ${skillNames}` : '');
    renderer?.updateContextUsage(usageText);

    renderer?.updateStatus({
      provider: providerName,
      model: provider.model,
      tokens: ctx.totalTokens,
      contextWindow: provider.contextWindow,
      step: step + 1,
      maxSteps,
    });

    if (ctx.needsCompact && messages.length > 6) {
      const before = messages.length;
      messages.splice(0, messages.length, ...ctx.compact(messages));
      if (!quiet) {
        renderer?.writeBracketTag('compact', `${before} → ${messages.length} messages`);
      }
      await ctx.updateTokens(messages);
    }

    logInfo('LOOP', `calling doChat, messages: ${messages.length}, options.showThinking: ${options?.showThinking}`);
    const { response } = await doChat(provider, messages, renderer!, renderer?.abortSignal, 1, options?.showThinking);

    // Check if aborted during generation
    if (renderer?.abortSignal?.aborted) {
      aborted = true;
      break;
    }

    // Auto-load skills if model suggested them in response (disabled in fast mode)
    if (options?.mode !== 'fast') {
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
      messages[0] = { role: 'system', content: buildSystemPrompt(loadedSkills, options?.mode) };
      messages.push({ role: 'user', content: `[System: Skills loaded: ${newSkillNames.join(', ')}. They are in your context now. IMPORTANT: Use filesystem tools (write_file, create_dir, edit_file, read_file, etc.) for all file operations — NOT bash. Skills show bash examples for reference only. Create a plan and start working NOW — do NOT wait for user confirmation.]` });
      // Force model to continue working after skills are loaded
      continue;
    }
    } // end fast-mode skill block

    if (!response.trim()) {
      logWarn('LOOP', `empty response #${consecutiveEmpty + 1}`);
      consecutiveEmpty++;
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'tool' && consecutiveEmpty <= 3) {
        const retryPrompt = consecutiveEmpty === 1
          ? 'The tool result is above. Your turn now. Either: (1) call the next tool using <tool_call>{"name":"...","arguments":{...}}</tool_call>, or (2) write a text reply to the user summarizing progress. Do NOT output nothing.'
          : 'You returned an empty response again. You MUST write something now. Example of what to write: "File created. Now I will create the next file..." or call another tool. Silence is not allowed.';
        messages.push({ role: 'user', content: retryPrompt });
        if (!quiet) {
          renderer?.writeDim(`  [empty response #${consecutiveEmpty}, retrying]`);
        }
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
    const invalidCalls: string[] = [];
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
        } else if (v.error) {
          invalidCalls.push(v.error);
        }
      }
    }

    if (validCalls.length === 0) {
      const fallback = extractToolCallFallback(response);
      if (fallback) {
        validCalls.push({ parsed: { name: 'bash', arguments: { cmd: fallback.cmd } }, cmd: fallback.cmd });
        if (!quiet) {
          renderer?.writeBracketTag('fallback', 'regex extracted command');
        }
      }
    }

    if (validCalls.length === 0) {
      if (invalidCalls.length > 0) {
        const feedback = `[Tool call error(s)]\n${invalidCalls.join('\n')}\n\nFix the tool call format and try again. Use ONLY valid tool names: bash, read_file, write_file, edit_file, list_dir, create_dir, delete_file, copy_file, move_file, file_info, glob_search, grep_search, tree, web_search, web_fetch, plan, todo, question, approve.`;
        if (!quiet) {
          renderer?.writeError(`  [invalid tool call: ${invalidCalls[0]}]`);
        }
        messages.push({ role: 'tool', content: feedback, tool_call_id: `invalid-${Date.now()}` });
        continue;
      }

      // Nudge model to continue working after a tool result
      if (continuationNudges < 2) {
        const lastThree = messages.slice(-3);
        const hasRecentToolResult = lastThree.some(m => m.role === 'tool');
        if (hasRecentToolResult) {
          continuationNudges++;
          if (!quiet) {
            renderer?.writeDim(`  [nudge ${continuationNudges}/2: continue working]`);
          }
          messages.push({ role: 'user', content: '[Tool result received. Continue: call the next tool or write the final summary. Do NOT just repeat the plan — take action.]' });
          continue;
        }
      }

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
        : JSON.stringify(parsed.arguments);
      const toolId = `call-${Date.now()}-${step}-${Math.random().toString(36).slice(2, 6)}`;

      logToolCall(parsed.name, preview);

      if (!quiet) {
        renderer?.writeToolHeader(parsed.name);
        renderer?.writeToolPreview(parsed.name, preview);
      }

      const hookCmd = isBash ? cmd! : `${parsed.name} ${JSON.stringify(parsed.arguments)}`;
      const preHook = runPreToolUseHooks(process.cwd(), parsed.name, hookCmd);
      if (!preHook.continue) {
        if (!quiet) {
          renderer?.writeBracketTag('hook blocked', preHook.message || '');
        }
        messages.push({ role: 'tool', content: `Hook blocked: ${preHook.message || ''}`, tool_call_id: toolId });
        continue;
      }

      if (pendingSyntaxError && !isBash) {
        const isWriteOp = parsed.name === 'write_file' || parsed.name === 'edit_file';
        if (isWriteOp && String(parsed.arguments.path ?? '') !== pendingSyntaxError) {
          const blocked = `BLOCKED: You have a syntax error in ${pendingSyntaxError}. Fix it first before writing new files.`;
          if (!quiet) {
            renderer?.writeError(`  [blocked: fix syntax error in ${pendingSyntaxError} first]`);
          }
          messages.push({ role: 'tool', content: blocked, tool_call_id: toolId });
          continue;
        }
      }

      let toolOutput = '';
      let toolExitCode = 0;
      const toolStart = performance.now();

      // Native tool calls: plan/todo/question/approve
      if (parsed.name === 'plan') {
        const planName = String(parsed.arguments.TaskName || parsed.arguments.name || parsed.arguments.plan || 'Untitled');
        const stepsRaw = parsed.arguments.Steps || parsed.arguments.steps || [];
        const steps = Array.isArray(stepsRaw) ? stepsRaw : String(stepsRaw).split('\n').filter((s: string) => s.trim());
        if (!quiet) {
          renderer?.writeBracketTag('plan', 'create');
        }
        toolOutput = createPlan(planName, steps);
        if (!quiet && toolOutput) {
          renderer?.writeNewline();
          renderer?.writeLine(toolOutput);
        }
      } else if (parsed.name === 'todo') {
        const action = String(parsed.arguments.action || 'list');
        const text = String(parsed.arguments.text || '');
        if (!quiet) {
          renderer?.writeBracketTag('todo', action);
        }
        switch (action) {
          case 'add': toolOutput = addTodo(text); break;
          case 'done': toolOutput = doneTodo(text); break;
          case 'remove': case 'rm': toolOutput = removeTodo(text); break;
          case 'list': case 'ls': toolOutput = listTodos(); break;
          default: toolOutput = 'Unknown todo action. Use: add, done, remove, list'; toolExitCode = 1;
        }
        if (!quiet && toolExitCode === 0 && toolOutput) {
          renderer?.writeNewline();
          renderer?.writeLine(toolOutput);
        }
      } else if (parsed.name === 'question') {
        const question = String(parsed.arguments.question || parsed.arguments.text || '');
        const choicesArr = Array.isArray(parsed.arguments.choices) ? parsed.arguments.choices : [];
        if (!quiet) {
          renderer?.writeBracketTag('question', question);
        }
        messages.push({
          role: 'tool',
          content: `Question asked: ${question}`,
          tool_call_id: toolId,
        });
        return {
          messages,
          questionPending: { question, choices: choicesArr.length > 0 ? choicesArr : undefined },
        };
      } else if (parsed.name === 'approve') {
        const action = String(parsed.arguments.action || parsed.arguments.text || '');
        if (!quiet) {
          renderer?.writeBracketTag('approve', action);
        }
        messages.push({
          role: 'tool',
          content: `Approval requested: ${action}`,
          tool_call_id: toolId,
        });
        return {
          messages,
          questionPending: { question: `Approve: ${action}?`, choices: ['Yes', 'No'] },
        };
      } else if (parsed.name === 'user_profile') {
        const action = String(parsed.arguments.action || 'show');
        if (!quiet) {
          renderer?.writeBracketTag('user_profile', action);
        }
        switch (action) {
          case 'show': {
            const content = loadProfile();
            toolOutput = content || 'User profile is empty.';
            break;
          }
          case 'add_note': {
            const note = String(parsed.arguments.note || parsed.arguments.text || '');
            const section = String(parsed.arguments.section || 'Notes');
            if (!note) {
              toolOutput = 'Usage: user_profile action=add_note section=Notes note=...';
              toolExitCode = 1;
              break;
            }
            appendNote(note, section as any);
            toolOutput = `Note added to "${section}" section.`;
            break;
          }
          default:
            toolOutput = 'Unknown user_profile action. Use: show, add_note';
            toolExitCode = 1;
        }
      } else if (parsed.name === 'theme') {
        const action = String(parsed.arguments.action || 'list');
        const name = String(parsed.arguments.name || '');
        const url = String(parsed.arguments.url || '');
        if (!quiet) {
          renderer?.writeBracketTag('theme', action);
        }
        switch (action) {
          case 'list': {
            const allThemes = listThemes();
            const current = loadThemeConfig().name;
            toolOutput = `Available themes (${allThemes.length}):\n`;
            for (const t of allThemes) {
              toolOutput += `  ${t}${t === current ? ' (active)' : ''}\n`;
            }
            break;
          }
          case 'show': {
            const config = loadThemeConfig();
            toolOutput = `Theme: ${config.name}\nColors: ${JSON.stringify(config.colors, null, 2)}\nIcons: ${JSON.stringify(config.icons, null, 2)}`;
            break;
          }
          case 'switch': {
            const allThemes = listThemes();
            if (!allThemes.includes(name)) {
              toolOutput = `Unknown theme "${name}". Available: ${allThemes.join(', ')}`;
              toolExitCode = 1;
              break;
            }
            const appConfig = loadConfig();
            appConfig.theme = name;
            saveConfig(appConfig);
            switchTheme(name);
            try {
              const { resetInkTheme } = await import('../ui/ink/theme.js');
              resetInkTheme();
            } catch { /* not in ink mode */ }
            toolOutput = `Theme switched to "${name}"`;
            break;
          }
          case 'install': {
            if (!name || !url) {
              toolOutput = 'Usage: theme install <name> <url>';
              toolExitCode = 1;
              break;
            }
            try {
              const resp = await fetch(url);
              const text = await resp.text();
              JSON.parse(text);
              installTheme(name, text);
              toolOutput = `Theme "${name}" installed from ${url}`;
            } catch (e: any) {
              toolOutput = `Failed to install theme: ${e.message}`;
              toolExitCode = 1;
            }
            break;
          }
          case 'remove': {
            if (!removeTheme(name)) {
              toolOutput = `Theme "${name}" not found`;
              toolExitCode = 1;
              break;
            }
            toolOutput = `Theme "${name}" removed`;
            break;
          }
          default:
            toolOutput = 'Unknown theme action. Use: list, show, switch, install, remove';
            toolExitCode = 1;
        }
      } else if (isBash && cmd!.startsWith('plan ')) {
        const planArgs = cmd!.slice(5).trim();
        const { action, params } = parsePlanCommand(planArgs);
        if (!quiet) {
          renderer?.writeBracketTag('plan', action);
        }
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
        if (!quiet) {
          renderer?.writeBracketTag('todo', action);
        }
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
        if (!quiet) {
          renderer?.writeBracketTag('question', question);
        }
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
        if (!quiet) {
          renderer?.writeBracketTag('approve', action);
        }
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
          if (!quiet) {
            renderer?.writeBracketTag('mcp', `${mcpCmd.server}/${mcpCmd.tool}`);
          }
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
      logToolCall(parsed.name, preview, toolExitCode !== 0 ? `exit:${toolExitCode} ${toolOutput.slice(0, 100)}` : `ok (${toolTime}s)`);
      if (toolExitCode !== 0) {
        const errText = toolOutput;
        if (!quiet) {
          for (const line of errText.split('\n').slice(0, 5)) {
            renderer?.writeError(`  ${line}`);
          }
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
              if (!quiet) {
                renderer?.writeBracketTag('syntax', `${shown.join('; ')}${extra}`);
              }

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

            // Auto-detect coding style from file content
            if (toolExitCode === 0 && filePath) {
              try {
                const fullContent = readFileSync(join(process.cwd(), filePath), 'utf-8');
                collectCodingStyle(filePath, fullContent);
              } catch { /* ignore */ }
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
  if (aborted) {
    renderer?.writeWarning('Agent stopped (double ESC)');
  }
  logInfo('LOOP', `runAgentLoop done: ${messages.length} total messages, aborted=${aborted}`);
  return { messages };
}
