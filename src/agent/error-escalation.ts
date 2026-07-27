import { generateToolCallId } from '../tools/id-gen.js';
import { logInfo, logError } from '../logger.js';
import { loadConfig, getSpecialistConfig } from '../config/config.js';
import { buildSpecialistTask, buildSubagentContext, isTrivialError, runIsolatedLoop } from '../tools/subagent.js';
import { SubagentRenderer } from '../ui/subagent-renderer.js';
import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutor } from './tool-executor.js';
import type { OutputRenderer } from '../ui/renderer.js';

/**
 * Параметры для specialist'а — изолированного суб-агента,
 * который решает повторяющуюся ошибку инструмента.
 */
interface SpecialistParams {
  provider: LLMProvider; registry: ToolRegistry; toolExecutor: ToolExecutor;
  modeConfig: any; llmCfg: any; specialistCfg: any;
  quiet: boolean; renderer: any; messages: ChatMessage[];
  toolId: string; createdFiles: string[];
  toolName: string; toolArgs: Record<string, unknown>;
  errorOutput: string; errorCount: number; enrichedPrompt: string;
}

/**
 * Запускает specialist'а для решения повторяющейся ошибки.
 */
async function spawnSpecialist(p: SpecialistParams): Promise<boolean> {
  if (!p.quiet) {
    p.renderer?.writeBracketTag('specialist', `solving '${p.errorOutput.slice(0, 60).replace(/\n/g, ' ')}' error...`);
  }
  const task = buildSpecialistTask(p.toolName, p.toolArgs, p.errorOutput, p.enrichedPrompt, p.errorCount);
  const ctx = buildSubagentContext(process.cwd());
  const sub = new SubagentRenderer();
  try {
    logInfo('LOOP', `spawning specialist for ${p.toolName} (attempt #${p.errorCount})`);
    const r = await runIsolatedLoop(
      p.provider, p.registry, task, ctx, process.cwd(),
      p.quiet, sub, p.toolExecutor, p.modeConfig.subagentMode, p.llmCfg.toolModel, p.specialistCfg.maxSteps,
    );
    for (let i = p.messages.length - 1; i >= 0; i--) {
      if (p.messages[i].role === 'tool' && p.messages[i].tool_call_id === p.toolId) {
        const text = r.errors.length > 0
          ? `[Specialist attempted to fix "${p.toolName}" but failed:\n${r.errors.join('\n')}\n${r.summary}]\nTry a different approach.`
          : `[Specialist resolved "${p.toolName}" error.\n${r.summary}]\nContinue with the task.`;
        p.messages[i].content = truncateToolOutput(p.toolName, text, 0);
        break;
      }
    }
    for (const f of r.createdFiles) { if (!p.createdFiles.includes(f)) p.createdFiles.push(f); }
    const buf = sub.getBuffer();
    if (!p.quiet && p.renderer?.writeToolBuffer) p.renderer.writeToolBuffer({ lines: buf.lines, toolCalls: buf.toolCalls });
    logInfo('LOOP', `specialist done | files: ${r.createdFiles.length} | turns: ${r.turns} | errors: ${r.errors.length}`);
    return true;
  } catch (e: any) {
    logError('LOOP', `specialist error: ${e.message}`);
    if (!p.quiet) p.renderer?.writeError(`  [specialist failed: ${e.message}]`);
    return false;
  }
}

function truncateToolOutput(toolName: string, output: string, exitCode: number): string {
  if (exitCode !== 0) {
    return output.length > 3000 ? output.slice(0, 3000) + '\n...[truncated]' : output;
  }

  const LIMITS: Record<string, number> = {
    read_file: 2000,
    write_file: 200,
    edit_file: 300,
    bash: 1500,
    list_dir: 1500,
    glob_search: 1000,
    grep_search: 1500,
    tree: 1500,
    subagent: 500,
    web_search: 1000,
    web_fetch: 1500,
    web_browse: 2000,
  };

  const limit = LIMITS[toolName] ?? 800;
  if (output.length <= limit) return output;
  return output.slice(0, limit) + '\n...[truncated]';
}

/**
 * Управляет эскалацией ошибок инструментов: отслеживание,
 * вызов specialist'а, переключение стратегии и блокировка.
 */
export class ErrorEscalator {
  consecutiveToolErrors = new Map<string, number>();
  totalToolErrors = 0;
  specialistSpawnedFor: string | null = null;
  errorStrategy: 'normal' | 'subagent-hint' | 'force-subagent' = 'normal';

  resetForTool(toolName: string): void {
    for (const [key] of this.consecutiveToolErrors) {
      if (key.startsWith(toolName + '::')) this.consecutiveToolErrors.delete(key);
    }
    this.specialistSpawnedFor = null;
  }

  reset(): void {
    this.consecutiveToolErrors.clear();
    this.totalToolErrors = 0;
    this.specialistSpawnedFor = null;
    this.errorStrategy = 'normal';
  }

  async handleToolError(
    toolName: string,
    toolOutput: string,
    toolArgs: Record<string, unknown>,
    toolId: string,
    messages: ChatMessage[],
    createdFiles: string[],
    enrichedPrompt: string,
    renderer: OutputRenderer | undefined,
    quiet: boolean,
    provider: LLMProvider,
    registry: ToolRegistry,
    toolExecutor: ToolExecutor,
    modeConfig: any,
    llmCfg: any,
  ): Promise<'continue' | 'block'> {
    this.totalToolErrors++;
    const errKey = `${toolName}::${toolOutput.slice(0, 100).replace(/[A-Z]:\\[^\s"']+/gi, '<PATH>').replace(/\/[^\s"']+/g, '<PATH>')}`;
    const prevCount = this.consecutiveToolErrors.get(errKey) ?? 0;
    this.consecutiveToolErrors.set(errKey, prevCount + 1);
    const errorCount = prevCount + 1;

    const config = loadConfig();
    const specialistCfg = getSpecialistConfig(config);

    if (
      specialistCfg.enabled &&
      errorCount === specialistCfg.triggerThreshold &&
      this.specialistSpawnedFor !== errKey &&
      !isTrivialError(toolName, toolOutput) &&
      toolOutput.length >= specialistCfg.minErrorLength
    ) {
      this.specialistSpawnedFor = errKey;
      const spawned = await spawnSpecialist({
        provider, registry, toolExecutor, modeConfig, llmCfg, specialistCfg,
        quiet, renderer, messages, toolId, createdFiles,
        toolName, toolArgs,
        errorOutput: toolOutput, errorCount, enrichedPrompt,
      });
      if (spawned) return 'continue';
    }

    if (errorCount > specialistCfg.triggerThreshold) {
      let webHint = '';
      if (toolName === 'web_browse' && String(toolArgs?.action) === 'evaluate') {
        webHint = ' For web scraping: use web_browse(action:"discover") to find real CSS selectors, or web_browse(action:"get_links") to see all links, or web_browse(action:"extract", format:"html") to inspect the page structure.';
      } else if (toolName === 'web_browse' && String(toolArgs?.action) === 'navigate' && toolOutput.includes('Status: 40')) {
        webHint = ' Page returned HTTP error. Try navigating to the site homepage first, then use web_browse(action:"get_links") or web_browse(action:"discover") to explore available categories and sections instead of guessing URLs.';
      }

      const msg = errorCount === specialistCfg.triggerThreshold + 1
        ? `[System: Tool "${toolName}" failed with the SAME error ${errorCount} times. Read the error message carefully. The input is likely wrong — try a completely different approach, or use subagent for a fresh context.]${webHint}`
        : `[System: Tool "${toolName}" failed ${errorCount} times with the same error. STOP. Do NOT retry the same call. Use subagent(task="...") for a fresh context, or tell the user you're stuck.]${webHint}`;
      messages.push({ role: 'user', content: msg });
      if (!quiet) renderer?.writeWarning(`  [error escalation: ${toolName} failed ${errorCount} times]`);
    }

    if (this.totalToolErrors >= 5 && this.errorStrategy === 'normal') {
      this.errorStrategy = 'subagent-hint';
      messages.push({ role: 'user', content: `[System: ${this.totalToolErrors} tool errors. Use subagent(task="...") for a fresh context.]` });
      if (!quiet) renderer?.writeWarning(`  [strategy: subagent-hint after ${this.totalToolErrors} errors]`);
    }

    if (errorCount >= 4) {
      const blockId = generateToolCallId();
      messages.push({ role: 'tool', content: `BLOCKED: Tool "${toolName}" failed ${errorCount} times. Temporarily blocked.`, tool_call_id: blockId });
      if (!quiet) renderer?.writeWarning(`  [blocked ${toolName}: too many repeated errors]`);
      return 'block';
    }

    return 'block';
  }
}
