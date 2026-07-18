import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMProvider } from '../llm/provider.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { OutputRenderer } from '../ui/renderer.js';
import type { AgentMode } from '../config/types.js';
import { loadAllMemory } from '../agent/memory.js';
import { createAutoSession, generateReadableId } from '../session/store.js';
import { initDefaultProfile, collectOS, collectTechStack, collectSessionStart, sessionEnded } from '../agent/user-profile.js';
import { getCurrentVersion, checkForUpdate, getUpdateCommand } from '../updater.js';
import { ConversationHistory } from './history.js';
import { getSlashCommands, parseSlashCommand, isWriteMode, handleWriteLine, type CommandContext } from './commands.js';
import { logREPL, logInfo, logError, initSessionLog, getLogPath } from '../logger.js';

function getEntryPoint(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const distEntry = join(__dirname, '..', '..', 'dist', 'index.js');
  if (existsSync(distEntry)) return distEntry;
  return join(__dirname, '..', 'index.ts');
}

export async function runRepl(
  provider: LLMProvider,
  registry: ToolRegistry,
  modelLabel: string,
  renderer: OutputRenderer,
  options?: { showThinking?: boolean },
): Promise<void> {
  const sessionId = generateReadableId();
  initSessionLog(sessionId);

  // Auto-collect user profile data
  initDefaultProfile();
  collectOS();
  collectTechStack();
  collectSessionStart();

  const memorySummary = loadAllMemory();

  const currentVer = getCurrentVersion();
  logInfo('REPL', `Started MMA v${currentVer} — ${modelLabel} [${sessionId}]`);

  const updateInfo = checkForUpdate();
  if (updateInfo.available) {
    renderer.writeWarning(`  ⬆ Update available: v${currentVer} → v${updateInfo.latest}`);
    renderer.write(`  ${getUpdateCommand()}`);
    renderer.writeNewline();
  }

  renderer.writeInfo(`  ◉ MMA v${currentVer} — ${modelLabel}`);
  renderer.writeDim(`    session: ${sessionId}`);
  if (memorySummary) {
    renderer.writeLine(memorySummary);
  }
  renderer.writeDim('Type /help for commands, /mode fast|base|pro to switch, /exit to quit');
  renderer.writeNewline();

  let currentMode: AgentMode = 'base';
  renderer.setMode?.(currentMode);

  const cmdMode = (args: string, ctx: CommandContext): void => {
    const mode = args.trim().toLowerCase() as AgentMode;
    if (!['fast', 'base', 'pro'].includes(mode)) {
      ctx.renderer.writeError('  Usage: /mode fast|base|pro');
      return;
    }
    currentMode = mode;
    ctx.renderer.writeSuccess(`  Mode switched to: ${mode}`);

    const descriptions: Record<AgentMode, string> = {
      fast: '  \u26a1 Быстрое выполнение: планирование и скилы отключены, урезанный промпт',
      base: '  \u00b7 Стандартный режим: все инструменты и функции доступны',
      pro: '  \ud83d\udd0d Pro-режим: обязательное использование @grill-me, контекст \u226564K',
    };
    ctx.renderer.writeDim(descriptions[mode]);

    if (mode === 'pro') {
      const currentCtx = ctx.provider.contextWindow;
      if (currentCtx < 64000) {
        ctx.renderer.writeWarning(`  \u26a0 Mode 'pro' requires \u226564K context. Current: ${currentCtx}. Auto-setting to 64000.`);
        ctx.provider.contextWindow = 64000;
      }
    }

    ctx.renderer.updateContextUsage('');
    ctx.renderer.updateStatus({ contextWindow: ctx.provider.contextWindow });
    ctx.renderer.setMode?.(mode);
  };

  const history = new ConversationHistory();
  const commands = getSlashCommands();
  const commandMap = new Map(commands.map(c => [c.name, c.handler]));
  commandMap.set('mode', cmdMode);

  const sigintHandler = () => {
    sessionEnded();
    if (history.length > 0) {
      createAutoSession(history.all, modelLabel, process.cwd(), { totalTokens: 0, compactCount: 0 });
      renderer.writeSuccess('\nSession auto-saved.');
    }
    renderer.destroy();
    process.exit(0);
  };
  process.on('SIGINT', sigintHandler);

  while (true) {
    try {
    let line: string;
    try {
      const promptMsg = `[${currentMode}] MMA> `;
      line = await renderer.prompt(promptMsg);
    } catch {
      break;
    }

    if (!line.trim()) continue;

    if (isWriteMode()) {
      handleWriteLine(line, renderer);
      continue;
    }

    const parsed = parseSlashCommand(line);
    if (parsed) {
      const handler = commandMap.get(parsed.cmd);
      if (handler) {
        const shouldStop = parsed.cmd === 'exit' || parsed.cmd === 'quit' || parsed.cmd === 'stop';
        const result = handler(parsed.args, {
          renderer,
          provider,
          registry,
          history: history.all,
          conversationHistory: history.all,
          modelLabel,
        });
        if (result instanceof Promise) await result;
        if (shouldStop) return;
      } else {
        renderer.writeError(`  Unknown command: /${parsed.cmd}. `);
        renderer.writeDim('Type /help');
      }
      continue;
    }

    // Intercept mma CLI commands inside REPL
    if (line.startsWith('mma ')) {
      try {
        const mmaArgs = line.slice(4);
        renderer.writeDim(`  $ mma ${mmaArgs}`);
        const output = execSync(`node ${getEntryPoint()} ${mmaArgs}`, {
          encoding: 'utf-8',
          windowsHide: true,
          timeout: 15000,
        });
        renderer.write(output.trim());
      } catch (e: any) {
        renderer.writeError(`  Error: ${e.stderr?.trim() || e.message}`);
      }
      renderer.writeNewline();
      continue;
    }

    renderer.writeNewline();
    renderer.writeDim('─'.repeat(40));
    renderer.writeBracketTag('user', ` ${line}`);
    renderer.writeDim('─'.repeat(40));
    renderer.writeNewline();
    logREPL('user', line);
    const result = await history.send(line, provider, registry, renderer, modelLabel, { showThinking: options?.showThinking, mode: currentMode });

    const lastAssistant = [...result.messages].reverse().find(m => m.role === 'assistant');
    if (lastAssistant) logREPL('assistant', lastAssistant.content);

    if (result.questionPending) {
      const { question, choices } = result.questionPending;
      let answer: string;
      if (choices && choices.length > 0 && renderer.promptWithChoices) {
        answer = await renderer.promptWithChoices(question, choices);
      } else {
        renderer.writeNewline();
        renderer.writeWarning(`  Question: ${question}`);
        if (choices && choices.length > 0) {
          for (let i = 0; i < choices.length; i++) {
            renderer.writeLine(`    ${i + 1}. ${choices[i]}`);
          }
        }
        renderer.writeNewline();
        answer = await renderer.prompt('  Your answer: ');
      }
      renderer.writeBracketTag('user', answer);
      history.push('user', answer);

      const answerResult = await history.send(`User answered: ${answer}`, provider, registry, renderer, modelLabel, { showThinking: options?.showThinking, mode: currentMode });
    }
    } catch (err: any) {
      const logPath = getLogPath();
      logError('REPL', `Unhandled error: ${err.stack || err.message}`);
      renderer.writeNewline();
      renderer.writeDim('─'.repeat(40));
      renderer.writeError('  ❌ Internal error');
      renderer.writeLine(`  ${err.message}`);
      renderer.writeDim(`  See log: ${logPath}`);
      renderer.writeNewline();
      if (history.length > 0) {
        try {
          const saved = createAutoSession(history.all, modelLabel, process.cwd(), { totalTokens: 0, compactCount: 0 });
          renderer.writeSuccess(`  Session saved: ${saved}`);
        } catch { /* ignore */ }
      }
      renderer.writeNewline();
      renderer.writeDim('  Type /exit to quit, or continue with another command.');
      renderer.writeNewline();
    }
  }
}
