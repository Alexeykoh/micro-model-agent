import { generateToolCallId } from '../tools/id-gen.js';
import { showPlan } from '../tools/plan.js';
import type { ParsedCall } from '../tools/parse-tool-call.js';
import type { ChatMessage } from '../llm/provider.js';
import type { OutputRenderer } from '../ui/renderer.js';

export class WriteEnforcer {
  directWriteStreak = 0;

  resetDirectWriteStreak(): void {
    this.directWriteStreak = 0;
  }

  enforcePlan(
    validCalls: ParsedCall[],
    messages: ChatMessage[],
    planEnforcement: boolean,
    quiet?: boolean,
    renderer?: OutputRenderer,
  ): void {
    const planSteps = showPlan();
    const hasMultiStepPlan = planEnforcement && !planSteps.startsWith('No active plan') && (planSteps.match(/\n/g) || []).length >= 3;
    if (!hasMultiStepPlan) return;

    const directWrites = validCalls.filter(c => c.parsed.name === 'write_file' || c.parsed.name === 'edit_file');
    const hasSubagent = validCalls.some(c => c.parsed.name === 'subagent');
    if (directWrites.length === 0 || hasSubagent) return;

    for (const wc of directWrites) {
      const idx = validCalls.indexOf(wc);
      if (idx !== -1) validCalls.splice(idx, 1);
      const blockId = generateToolCallId();
      messages.push({
        role: 'tool',
        content: 'BLOCKED: Multi-step plan active. Use subagent for each step. Example: subagent({task:"Create file X", existingFiles:"Y.ts"}). After subagent completes, mark step done: plan({action:"done", step:N})',
        tool_call_id: blockId,
      });
    }
    if (!quiet) {
      renderer?.writeWarning(`  [blocked ${directWrites.length} direct writes — use subagent for multi-step plans]`);
    }
  }

  enforceWriteStreak(
    validCalls: ParsedCall[],
    messages: ChatMessage[],
    directWriteStreakMax: number,
    quiet?: boolean,
    renderer?: OutputRenderer,
  ): void {
    if (directWriteStreakMax >= Infinity) return;

    const planSteps = showPlan();
    const hasMultiStepPlan = !planSteps.startsWith('No active plan') && (planSteps.match(/\n/g) || []).length >= 3;
    if (hasMultiStepPlan) return;

    const hasWrite = validCalls.some(c => c.parsed.name === 'write_file');
    const hasSubagentNow = validCalls.some(c => c.parsed.name === 'subagent');
    if (hasSubagentNow) {
      this.directWriteStreak = 0;
      return;
    }
    if (!hasWrite) return;

    const writeCount = validCalls.filter(c => c.parsed.name === 'write_file').length;
    this.directWriteStreak += writeCount;
    if (this.directWriteStreak < directWriteStreakMax) return;

    const directWrites = validCalls.filter(c => c.parsed.name === 'write_file');
    for (const wc of directWrites) {
      const idx = validCalls.indexOf(wc);
      if (idx !== -1) validCalls.splice(idx, 1);
    }
    if (directWrites.length > 0) {
      const blockId = generateToolCallId();
      messages.push({
        role: 'tool',
        content: `BLOCKED: You're creating file #${this.directWriteStreak} without subagent. For 3+ new files, use subagent for each one. Example: subagent("Create file X. Context: Y already exists.")`,
        tool_call_id: blockId,
      });
    }
    if (!quiet) {
      renderer?.writeWarning(`  [blocked ${directWrites.length} writes: ${this.directWriteStreak} files without subagent — use subagent for multi-file projects]`);
    }
  }

  enforceSingleWrite(
    validCalls: ParsedCall[],
    messages: ChatMessage[],
    quiet?: boolean,
    renderer?: OutputRenderer,
  ): void {
    const writeCalls = validCalls.filter(c => c.parsed.name === 'write_file' || c.parsed.name === 'edit_file');
    if (writeCalls.length <= 1) return;

    const blocked = writeCalls.slice(1);
    const firstBlocked = blocked[0];
    const startIdx = validCalls.indexOf(firstBlocked);
    if (startIdx !== -1) {
      validCalls.splice(startIdx, blocked.length);
    }
    for (const bc of blocked) {
      const blockId = generateToolCallId();
      messages.push({
        role: 'tool',
        content: `BLOCKED: Only one file write per response is allowed. You wrote ${writeCalls.length} files at once. Complete the first file, then write the next one.`,
        tool_call_id: blockId,
      });
    }
    if (!quiet) {
      renderer?.writeWarning(`  [blocked ${blocked.length} extra file writes — one at a time]`);
    }
  }
}
