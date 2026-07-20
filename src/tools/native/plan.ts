import type { ToolDefinition } from '../registry.js';
import type { ToolHandler, ToolResult } from '../types.js';
import { createPlan } from '../plan.js';

/**
 * Нативный инструмент plan — управление планами задач.
 *
 * @module tools/native/plan
 */

export const planDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'plan',
    description: 'Create a task plan with named steps. Use before starting multi-step work.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Plan name' },
        steps: { type: 'array', items: { type: 'string' }, description: 'List of steps' },
      },
      required: ['name', 'steps'],
    },
  },
};

export const planHandler: ToolHandler = {
  name: 'plan',
  definition: planDefinition,
  async execute(args, ctx) {
    const planName = String(args.name || 'Untitled');
    const stepsRaw = args.steps || [];
    const steps = Array.isArray(stepsRaw) ? stepsRaw.map(String) : String(stepsRaw).split('\n').filter((s: string) => s.trim());

    if (!ctx.quiet) {
      ctx.renderer?.writeBracketTag('plan', 'create');
    }

    let output = createPlan(planName, steps);

    if (steps.length >= 3) {
      output += `\n\nIMPORTANT: Plan has ${steps.length} steps. Use subagent tool for EACH step to work in isolation:\n`;
      for (let i = 0; i < steps.length; i++) {
        output += `subagent("Step ${i + 1}: ${steps[i]}. List existing files and packages.")\n`;
      }
      output += `This prevents context loss. Do NOT use write_file directly — delegate to subagents.`;
    }

    if (!ctx.quiet && output) {
      ctx.renderer?.writeLine(output);
    }

    return { stdout: output, stderr: '', exitCode: 0, truncated: false };
  },
};
