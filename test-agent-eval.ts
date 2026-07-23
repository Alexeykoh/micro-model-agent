/**
 * MMA Agent Evaluation — Full verbose output with detailed metrics.
 *
 * Shows everything the agent does: reasoning, responses, tool calls with args,
 * token counts per turn, execution times, and overall grades.
 *
 * Usage:
 *   bun run test-agent-eval.ts --scenario chat
 *   bun run test-agent-eval.ts --scenario code --verbose
 *   bun run test-agent-eval.ts --list
 */
import { LMStudioNative } from './src/llm/lmstudio-native.js';
import { ToolRegistry } from './src/tools/registry.js';
import { runAgentLoop } from './src/agent/loop.js';
import { ContextManager } from './src/agent/context.js';
import type { ChatMessage } from './src/llm/provider.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Config ───────────────────────────────────────────────

const BASE_URL = process.env.MMA_LLM_URL || 'http://localhost:1234/v1';
const MODEL = process.env.MMA_LLM_MODEL || 'qwen/qwen3.5-9b';
const CTX = parseInt(process.env.MMA_CTX || '32768', 10);
const VERBOSE = process.argv.includes('--verbose');

// ─── Scenarios ────────────────────────────────────────────

const SCENARIOS = [
  {
    name: 'chat',
    description: 'Simple conversation',
    prompts: [
      'Hello! How are you?',
      'What is your name?',
      'Tell me a joke',
      'What is your favorite programming language?',
    ],
  },
  {
    name: 'read',
    description: 'Read project files',
    prompts: [
      'Read the file package.json',
      'Show me the content of src/index.ts',
    ],
  },
  {
    name: 'code',
    description: 'Write code files',
    prompts: [
      'Write a fibonacci function in TypeScript',
      'Write a debounce function in TypeScript',
    ],
  },
  {
    name: 'auto-fix',
    description: 'Self-correct syntax errors',
    prompts: [
      'Write a parseJSON function in TypeScript that takes a string and returns an object. Wrap in try-catch.',
    ],
  },
  {
    name: 'code-execute',
    description: 'Write and run code',
    prompts: [
      'Create a file test-run.ts with a factorial(n) function and console.log(factorial(5)). Run it with bun.',
    ],
  },
  {
    name: 'subagent-heavy',
    description: 'Multi-file with subagents',
    prompts: [
      'Create 3 files in multi-file-test: math.ts (add/sub/mul), string.ts (capitalize/reverse), index.ts (re-exports). Make a plan, then implement each file via subagent.',
    ],
  },
  {
    name: 'web-scraping',
    description: 'Parse products from site + search the internet',
    prompts: [
      'Scrape 10-15 Specialized bicycles from https://tvojvelik.by/catalog/velosipedy/specialized/ and save to specialized-bikes.md. Use 4-step pattern: navigate → discover → evaluate → write_file.',
      'Search the internet for Specialized ROCKHOPPER SPORT bicycle — all info: specs, prices, reviews. Save everything to rockhopper-sport.md.',
    ],
  },
];

// ─── Renderer that captures EVERYTHING ────────────────────

interface CapturedEvent {
  type: 'reasoning' | 'content' | 'tool_call' | 'tool_result' | 'error' | 'warning' | 'info' | 'bracket' | 'subagent_start' | 'subagent_result' | 'emergency' | 'empty';
  text: string;
  tag?: string;
  timestamp: number;
}

function createCapturingRenderer() {
  const events: CapturedEvent[] = [];
  const ts = () => performance.now();
  let streamBuf = '';
  let lastStreamFlush = 0;

  const flushStream = (force = false) => {
    if (streamBuf.trim() && (force || streamBuf.length > 100 || (ts() - lastStreamFlush > 300))) {
      events.push({ type: 'content', text: streamBuf.trim(), timestamp: ts() });
      streamBuf = '';
      lastStreamFlush = ts();
    }
  };

  return {
    events,
    flushStream,
    // Core output — aggregates streaming chunks
    write: (text: string) => {
      streamBuf += text;
      lastStreamFlush = ts();
    },
    writeLine: (text?: string) => {
      streamBuf += (text || '') + '\n';
      flushStream(true);
    },
    writeNewline: () => { streamBuf += '\n'; },
    // Error/Warning
    writeError: (text: string) => {
      flushStream(true);
      events.push({ type: 'error', text, timestamp: ts() });
    },
    writeWarning: (text: string) => {
      flushStream(true);
      events.push({ type: 'warning', text, timestamp: ts() });
    },
    writeInfo: (text: string) => {
      flushStream(true);
      events.push({ type: 'info', text, timestamp: ts() });
    },
    writeSuccess: (text: string) => {
      flushStream(true);
      events.push({ type: 'info', text: `✅ ${text}`, timestamp: ts() });
    },
    writeDim: (text: string) => {
      flushStream(true);
      events.push({ type: 'info', text, timestamp: ts() });
    },
    writeBracketTag: (tag: string, msg: string) => {
      flushStream(true);
      events.push({ type: 'bracket', text: msg, tag, timestamp: ts() });
    },
    writeHeading: (text: string) => {
      flushStream(true);
      events.push({ type: 'info', text: `\n${text}`, timestamp: ts() });
    },
    // Tool events
    writeToolHeader: (name: string) => {
      flushStream(true);
      events.push({ type: 'tool_call', text: name, timestamp: ts() });
    },
    writeToolPreview: (toolName: string, argsJson: string) => {
      flushStream(true);
      events.push({ type: 'tool_call', text: `${toolName}(${argsJson})`, timestamp: ts() });
    },
    writeToolResult: (time: string, exitCode?: number, result?: string) => {
      flushStream(true);
      events.push({ type: 'tool_result', text: `[${time}] exit=${exitCode ?? '?'} ${result || ''}`, timestamp: ts() });
    },
    writeToolBuffer: (data: { lines: string[]; toolCalls: { name: string; args: string; result: string }[] }) => {
      flushStream(true);
      for (const tc of data.toolCalls) {
        events.push({ type: 'tool_call', text: `[subagent] ${tc.name}(${tc.args.slice(0, 200)})`, timestamp: ts() });
        if (tc.result) {
          events.push({ type: 'tool_result', text: `[subagent result] ${tc.result.slice(0, 300)}`, timestamp: ts() });
        }
      }
      for (const line of data.lines.slice(-5)) {
        events.push({ type: 'info', text: `[subagent] ${line.slice(0, 150)}`, timestamp: ts() });
      }
    },
    writeMarkdownChunk: (chunk: string) => {
      streamBuf += chunk;
      lastStreamFlush = ts();
    },
    writeSpinner: () => {},
    clearSpinner: () => {},
    commitMarkdown: () => { flushStream(true); },
    updateContextUsage: () => {},
    updateStatus: () => {},
    clear: () => {},
    prompt: async () => '',
    promptWithChoices: async () => '',
    setCommands: () => {},
    abort: () => {},
    resetAbort: () => {},
    setMode: () => {},
    writeFileOutput: () => {},
    destroy: () => {},
    abortSignal: undefined,
  } as any;
}

// ─── Message Analysis ─────────────────────────────────────

interface MessageAnalysis {
  role: string;
  contentLength: number;
  contentPreview: string;
  toolCalls: { name: string; argsPreview: string }[];
  toolCallId?: string;
  isReasoning: boolean;
  isToolResult: boolean;
}

function analyzeMessages(messages: ChatMessage[]): MessageAnalysis[] {
  return messages.map(m => {
    const toolCalls: { name: string; argsPreview: string }[] = [];
    if (m.content) {
      const matches = m.content.matchAll(/<tool_call>\{"name":"([^"]+)","arguments":(\{[^}]*\})/g);
      for (const match of matches) {
        toolCalls.push({ name: match[1], argsPreview: match[2].slice(0, 150) });
      }
    }

    return {
      role: m.role,
      contentLength: m.content?.length || 0,
      contentPreview: (m.content || '').slice(0, 300).replace(/\n/g, '↵'),
      toolCalls,
      toolCallId: m.tool_call_id,
      isReasoning: false,
      isToolResult: m.role === 'tool',
    };
  });
}

// ─── Token Estimation ─────────────────────────────────────

function estimateTokens(text: string): number {
  // Rough: ~3.5 chars per token for mixed content
  return Math.round((text?.length || 0) / 3.5);
}

// ─── Full Turn Print ──────────────────────────────────────

function printTurnDetail(turnNum: number, messages: ChatMessage[], startTime: number, events: CapturedEvent[]) {
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  ┌─ Turn ${turnNum} (${elapsed}s elapsed) ─────────────────────────────────`);

  // Find new messages since last turn (approximately)
  const analysis = analyzeMessages(messages);
  const lastAssistant = analysis.filter(m => m.role === 'assistant').pop();
  const toolResults = analysis.filter(m => m.role === 'tool');

  // Print assistant message
  if (lastAssistant) {
    const inputTokens = messages.slice(0, messages.length - 1).reduce((s, m) => s + estimateTokens(m.content), 0);
    const outputTokens = estimateTokens(lastAssistant.contentPreview);
    console.log(`  │ 📤 Output: ${outputTokens} tokens (${lastAssistant.contentLength} chars)`);
    console.log(`  │ 📥 Input:  ${inputTokens} tokens (estimated from context)`);

    if (lastAssistant.toolCalls.length > 0) {
      for (const tc of lastAssistant.toolCalls) {
        console.log(`  │ 🔧 Tool call: ${tc.name}`);
        console.log(`  │    Args: ${tc.argsPreview}`);
      }
    }

    // Print content preview (non-tool-call content)
    const contentOnly = (lastAssistant.contentPreview || '').replace(/<tool_call>[^<]*<\/tool_call>/g, '').trim();
    if (contentOnly) {
      console.log(`  │ 💬 Response: "${contentOnly.slice(0, 200)}"`);
    }
  }

  // Print tool results
  for (const tr of toolResults) {
    const preview = tr.contentPreview.slice(0, 200);
    console.log(`  │ 📥 Tool result (${tr.contentLength} chars): ${preview}`);
  }

  // Print captured events for this turn
  const turnEvents = events.filter(e => e.timestamp >= startTime);
  for (const evt of turnEvents) {
    if (evt.type === 'warning') console.log(`  │ ⚠️  ${evt.text}`);
    if (evt.type === 'error') console.log(`  │ ❌ ${evt.text}`);
    if (evt.type === 'bracket') console.log(`  │ [${evt.tag}] ${evt.text}`);
    if (evt.type === 'emergency') console.log(`  │ 🚨 ${evt.text}`);
  }

  console.log(`  └──────────────────────────────────────────`);
}

// ─── Runner ───────────────────────────────────────────────

async function runScenarioFull(
  provider: OpenAICompat,
  registry: ToolRegistry,
  scenario: { name: string; description: string; prompts: string[] },
) {
  const allResults: {
    prompt: string;
    messages: ChatMessage[];
    totalTimeMs: number;
    events: CapturedEvent[];
    toolCalls: string[];
    subagentCalls: number;
    emptyResponses: number;
    errors: string[];
  }[] = [];

  for (const prompt of scenario.prompts) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  PROMPT: "${prompt}"`);
    console.log(`${'═'.repeat(70)}`);

    const promptStart = performance.now();
    const renderer = createCapturingRenderer();
    const ctx = new ContextManager(CTX);

    let agentResult: any;
    try {
      agentResult = await runAgentLoop(
        provider,
        registry,
        prompt,
        ctx,
        undefined,
        renderer,
        'lmstudio',
        { quiet: true, mode: 'base' },
      );
    } catch (err: any) {
      console.log(`\n  ❌ AGENT ERROR: ${err.message}`);
      allResults.push({
        prompt,
        messages: [],
        totalTimeMs: performance.now() - promptStart,
        events: renderer.events,
        toolCalls: [],
        subagentCalls: 0,
        emptyResponses: 1,
        errors: [err.message],
      });
      continue;
    }

    const totalTimeMs = performance.now() - promptStart;
    const messages = agentResult.messages;

    // ── Print full message history ──
    console.log(`\n  📋 Full message history (${messages.length} messages):`);
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const tokens = estimateTokens(m.content);

      if (m.role === 'system') {
        console.log(`\n  [${i}] SYSTEM (${tokens} tokens):`);
        if (VERBOSE) {
          console.log(`      ${m.content.slice(0, 500).replace(/\n/g, '\n      ')}`);
        } else {
          console.log(`      ${m.content.slice(0, 200).replace(/\n/g, ' ')}...`);
        }
      } else if (m.role === 'user') {
        console.log(`\n  [${i}] USER (${tokens} tokens):`);
        console.log(`      "${m.content.slice(0, 300).replace(/\n/g, ' ')}"`);
      } else if (m.role === 'assistant') {
        console.log(`\n  [${i}] ASSISTANT (${tokens} tokens):`);
        // Extract tool calls
        const toolMatches = [...m.content.matchAll(/<tool_call>\{"name":"([^"]+)","arguments":(\{[^}]*\})\}<\/tool_call>/g)];
        const contentOnly = m.content.replace(/<tool_call>[^<]*<\/tool_call>/g, '').trim();

        if (toolMatches.length > 0) {
          for (const tm of toolMatches) {
            console.log(`      🔧 ${tm[1]}(${tm[2].slice(0, 120)})`);
          }
        }
        if (contentOnly) {
          console.log(`      💬 "${contentOnly.slice(0, 300).replace(/\n/g, ' ')}"`);
        }
        if (!contentOnly && toolMatches.length === 0) {
          console.log(`      ⚠️  EMPTY RESPONSE`);
        }
      } else if (m.role === 'tool') {
        const preview = m.content.slice(0, 200).replace(/\n/g, ' ');
        console.log(`\n  [${i}] TOOL RESULT (${tokens} chars):`);
        console.log(`      ${preview}${m.content.length > 200 ? '...' : ''}`);
      }
    }

    // ── Captured events summary ──
    const meaningfulEvents = renderer.events.filter(e => e.type !== 'content');
    if (meaningfulEvents.length > 0) {
      console.log(`\n  📡 Events (${meaningfulEvents.length}):`);
      for (const evt of meaningfulEvents.slice(-20)) {
        const icon = evt.type === 'error' ? '❌' : evt.type === 'warning' ? '⚠️' : evt.type === 'tool_call' ? '🔧' : evt.type === 'tool_result' ? '📥' : evt.type === 'bracket' ? `[${evt.tag}]` : 'ℹ️';
        console.log(`      ${icon} ${evt.text.slice(0, 150)}`);
      }
    }

    // ── Per-prompt summary ──
    const toolCalls: string[] = [];
    let subagentCalls = 0;
    let emptyResponses = 0;
    for (const m of messages) {
      if (m.role === 'assistant' && m.content) {
        const matches = m.content.matchAll(/<tool_call>\{"name":"([^"]+)"/g);
        for (const match of matches) {
          toolCalls.push(match[1]);
          if (match[1] === 'subagent') subagentCalls++;
        }
      }
    }

    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant?.content?.trim()) emptyResponses++;

    const assistantMsgs = messages.filter(m => m.role === 'assistant');
    const totalOutputTokens = assistantMsgs.reduce((s, m) => s + estimateTokens(m.content), 0);
    const totalInputTokens = messages.reduce((s, m) => s + (m.role !== 'assistant' ? estimateTokens(m.content) : 0), 0);

    console.log(`\n  📊 Prompt Summary:`);
    console.log(`     Time: ${(totalTimeMs / 1000).toFixed(1)}s`);
    console.log(`     Turns: ${assistantMsgs.length}`);
    console.log(`     Input tokens (est): ${totalInputTokens}`);
    console.log(`     Output tokens (est): ${totalOutputTokens}`);
    console.log(`     Tool calls: ${toolCalls.length > 0 ? toolCalls.join(', ') : 'none'}`);
    console.log(`     Subagent calls: ${subagentCalls}`);
    console.log(`     Empty responses: ${emptyResponses}`);

    allResults.push({
      prompt,
      messages,
      totalTimeMs,
      events: renderer.events,
      toolCalls,
      subagentCalls,
      emptyResponses,
      errors: [],
    });
  }

  return allResults;
}

// ─── Grading ──────────────────────────────────────────────

function gradeScenarioResults(name: string, results: any[]) {
  const count = results.length;
  const totalTime = results.reduce((s, r) => s + r.totalTimeMs, 0);
  const totalEmpty = results.reduce((s, r) => s + r.emptyResponses, 0);
  const totalErrors = results.reduce((s, r) => s + r.errors.length, 0);
  const totalToolCalls = results.reduce((s, r) => s + r.toolCalls.length, 0);
  const hasSubagent = results.some(r => r.subagentCalls > 0);

  let grade = 'A';
  const issues: string[] = [];

  if (totalEmpty / count > 0.3) { grade = 'F'; issues.push(`${Math.round(totalEmpty / count * 100)}% empty responses`); }
  else if (totalErrors > 0) { grade = 'D'; issues.push(`${totalErrors} errors`); }
  else if (totalEmpty > 0) { grade = 'C'; issues.push(`${totalEmpty} empty responses`); }

  if (name === 'subagent-heavy' && !hasSubagent) {
    grade = 'D';
    issues.push('Did not use subagents');
  }

  // Web scraping specific grading
  if (name === 'web-scraping') {
    const allToolCalls = results.flatMap(r => r.toolCalls);
    const usedDiscover = allToolCalls.includes('discover');
    const usedWebBrowse = allToolCalls.includes('web_browse');
    const usedWebSearch = allToolCalls.includes('web_search');
    const usedWriteFile = allToolCalls.includes('write_file');

    console.log(`\n  🔍 Web scraping details:`);
    console.log(`     discover used: ${usedDiscover ? '✅' : '❌'}`);
    console.log(`     web_browse used: ${usedWebBrowse ? '✅' : '❌'}`);
    console.log(`     web_search used: ${usedWebSearch ? '✅' : '❌'}`);
    console.log(`     write_file used: ${usedWriteFile ? '✅' : '❌'}`);

    if (!usedDiscover && usedWebBrowse) {
      issues.push('Did not use discover — guessed selectors');
      if (grade === 'A') grade = 'B';
    }
    if (!usedWriteFile) {
      issues.push('Did not write output files');
      grade = 'D';
    }
  }

  console.log(`\n  🏆 Scenario Grade: ${grade}`);
  if (issues.length > 0) console.log(`     Issues: ${issues.join('; ')}`);

  return { grade, issues, totalTime, totalToolCalls, totalEmpty, hasSubagent };
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    console.log('Scenarios:\n');
    for (const s of SCENARIOS) {
      console.log(`  ${s.name.padEnd(18)} ${s.description} (${s.prompts.length} prompts)`);
    }
    return;
  }

  const scenarioIdx = args.indexOf('--scenario');
  const filterName = scenarioIdx !== -1 ? args[scenarioIdx + 1] : null;
  const scenarios = filterName
    ? SCENARIOS.filter(s => s.name === filterName)
    : SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`Scenario "${filterName}" not found. Use --list.`);
    process.exit(1);
  }

  console.log('MMA Agent Evaluation — Full Verbose\n');
  console.log(`Provider:  ${BASE_URL}`);
  console.log(`Model:     ${MODEL}`);
  console.log(`Context:   ${CTX}`);
  console.log(`Scenarios: ${scenarios.length}\n`);

  // Check LLM
  try {
    const res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('Not OK');
    console.log('✅ LLM available\n');
  } catch {
    console.error('❌ LLM unavailable. Start LM Studio.');
    process.exit(1);
  }

  const provider = new LMStudioNative(BASE_URL, MODEL, CTX);

  // Create isolated temp directory
  const testDir = mkdtempSync(join(tmpdir(), 'mma-eval-'));
  const origCwd = process.cwd();
  process.chdir(testDir);

  writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'eval-project', version: '1.0.0', type: 'module' }, null, 2));

  console.log(`📁 Test dir: ${testDir}\n`);

  const registry = new ToolRegistry(testDir);
  const allGrades: any[] = [];

  try {
    for (const scenario of scenarios) {
      console.log(`\n${'━'.repeat(70)}`);
      console.log(`  SCENARIO: ${scenario.name} — ${scenario.description}`);
      console.log(`${'━'.repeat(70)}`);

      const results = await runScenarioFull(provider, registry, scenario);
      const gradeInfo = gradeScenarioResults(scenario.name, results);
      allGrades.push({ name: scenario.name, ...gradeInfo });
    }

    // ── Final Report ──
    console.log(`\n${'═'.repeat(70)}`);
    console.log('  FINAL REPORT');
    console.log(`${'═'.repeat(70)}`);

    const totalTime = allGrades.reduce((s, g) => s + g.totalTime, 0);
    const totalTools = allGrades.reduce((s, g) => s + g.totalToolCalls, 0);
    const totalEmpty = allGrades.reduce((s, g) => s + g.totalEmpty, 0);
    const avgGrade = allGrades.every(g => g.grade === 'A') ? 'A'
      : allGrades.some(g => g.grade === 'F') ? 'F'
      : allGrades.some(g => g.grade === 'D') ? 'D'
      : allGrades.some(g => g.grade === 'C') ? 'C' : 'B';

    console.log(`\n  Total time:      ${(totalTime / 1000).toFixed(1)}s`);
    console.log(`  Total tool calls: ${totalTools}`);
    console.log(`  Total empty:     ${totalEmpty}`);
    console.log(`  Overall grade:   ${avgGrade}\n`);

    for (const g of allGrades) {
      const icon = g.grade === 'A' ? '✅' : g.grade === 'B' ? '🔵' : g.grade === 'C' ? '🟡' : g.grade === 'D' ? '🟠' : '❌';
      console.log(`  ${icon} ${g.name.padEnd(18)} ${g.grade}  (${(g.totalTime / 1000).toFixed(1)}s, ${g.totalToolCalls} tools, ${g.totalEmpty} empty)`);
      if (g.issues.length > 0) console.log(`     └─ ${g.issues.join('; ')}`);
    }

    console.log('\n' + '═'.repeat(70));

  } finally {
    process.chdir(origCwd);
    if (args.includes('--keep')) {
      console.log(`\n📂 Files kept in: ${testDir}`);
    } else {
      rmSync(testDir, { recursive: true, force: true });
      console.log(`\n🧹 Cleaned up: ${testDir}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
