import type { LLMProvider } from '../llm/provider.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { OutputRenderer } from '../ui/renderer.js';
import { loadAllMemory } from '../agent/memory.js';
import { createAutoSession } from '../session/store.js';
import { ConversationHistory } from './history.js';
import { getSlashCommands, parseSlashCommand, isWriteMode, handleWriteLine } from './commands.js';

export async function runRepl(
  provider: LLMProvider,
  registry: ToolRegistry,
  modelLabel: string,
  renderer: OutputRenderer,
): Promise<void> {
  const memorySummary = loadAllMemory();

  renderer.writeHeading(`MMA v0.1 — ${modelLabel}`);
  if (memorySummary) {
    renderer.writeLine(memorySummary);
  }
  renderer.writeDim('Type /help for commands, /exit to quit');
  renderer.writeNewline();

  const history = new ConversationHistory();
  const commands = getSlashCommands();
  const commandMap = new Map(commands.map(c => [c.name, c.handler]));

  const sigintHandler = () => {
    if (history.length > 0) {
      createAutoSession(history.all, modelLabel, process.cwd(), { totalTokens: 0, compactCount: 0 });
      renderer.writeSuccess('\nSession auto-saved.');
    }
    renderer.destroy();
    process.exit(0);
  };
  process.on('SIGINT', sigintHandler);

  while (true) {
    let line: string;
    try {
      line = await renderer.prompt('MMA> ');
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

    renderer.writeBracketTag('user', line)
    const result = await history.send(line, provider, registry, renderer, modelLabel);

    if (result.questionPending) {
      const { question, choices } = result.questionPending;
      renderer.writeNewline();
      renderer.writeWarning(`  Question: ${question}`);
      if (choices && choices.length > 0) {
        for (let i = 0; i < choices.length; i++) {
          renderer.writeLine(`    ${i + 1}. ${choices[i]}`);
        }
      }
      renderer.writeNewline();
      const answer = await renderer.prompt('  Your answer: ');
      renderer.writeBracketTag('user', answer);
      history.push('user', answer);

      const answerResult = await history.send(`User answered: ${answer}`, provider, registry, renderer, modelLabel);
    }
  }
}
