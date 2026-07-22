import type { ToolDefinition } from '../registry.js';
import type { ToolHandler, ToolResult } from '../types.js';
import { createPlan, updatePlanStep, showPlan, clearPlan } from '../plan.js';

/**
 * Native plan tool — task plan management.
 *
 * @module tools/native/plan
 */

export const planDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'plan',
    description: 'Manage task plans. Create plans, mark steps done, show progress, or clear.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'done', 'progress', 'show', 'clear'], description: 'Action: create (with name+steps), done (mark step N done), progress (show plan), show (same as progress), clear (delete plan)' },
        name: { type: 'string', description: 'Plan name (required for create)' },
        steps: { type: 'array', items: { type: 'string' }, description: 'List of steps (required for create)' },
        step: { type: 'number', description: 'Step number to mark as done (required for done)' },
      },
      required: ['action'],
    },
  },
};

export const planHandler: ToolHandler = {
  name: 'plan',
  definition: planDefinition,
  async execute(args, ctx) {
    const action = String(args.action || 'show');

    if (!ctx.quiet) {
      ctx.renderer?.writeBracketTag('plan', action);
    }

    let output = '';

    switch (action) {
      case 'create': {
        const planName = String(args.name || 'Untitled');
        const stepsRaw = args.steps || [];
        const steps = Array.isArray(stepsRaw) ? stepsRaw.map(String) : String(stepsRaw).split('\n').filter((s: string) => s.trim());
        output = createPlan(planName, steps);

        if (steps.length >= 3) {
          output += `\n\nIMPORTANT: Plan has ${steps.length} steps. Use subagent tool for EACH step to work in isolation:\n`;
          for (let i = 0; i < steps.length; i++) {
            output += `subagent("Step ${i + 1}: ${steps[i].replace(/^\d+\.\s*/, '')}. List existing files and packages.")\n`;
          }
          output += `After each subagent completes, mark the step done: plan({action:'done', step:${1}})`;
        }
        break;
      }
      case 'done': {
        const stepNum = Number(args.step);
        if (!stepNum || stepNum < 1) {
          output = 'Usage: plan({action:"done", step:1}) — marks step 1 as done.';
        } else {
          output = updatePlanStep(stepNum, 'done');
        }
        break;
      }
      case 'progress':
      case 'show': {
        output = showPlan();
        break;
      }
      case 'clear': {
        output = clearPlan();
        break;
      }
      default:
        output = showPlan();
    }

    if (!ctx.quiet && output) {
      ctx.renderer?.writeLine(output);
    }

    return { stdout: output, stderr: '', exitCode: 0, truncated: false };
  },
};
