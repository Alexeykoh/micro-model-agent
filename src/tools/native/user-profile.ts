import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';
import { loadProfile, appendNote } from '../../agent/user-profile.js';

/**
 * Нативный инструмент user_profile — управление профилем пользователя.
 *
 * @module tools/native/user-profile
 */

export const userProfileDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'user_profile',
    description: 'View or add notes to user profile. Actions: show, add_note.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'show or add_note' },
        note: { type: 'string', description: 'Note text (for add_note)' },
        section: { type: 'string', description: 'Section name (for add_note, default: Notes)' },
      },
      required: ['action'],
    },
  },
};

export const userProfileHandler: ToolHandler = {
  name: 'user_profile',
  definition: userProfileDefinition,
  async execute(args, ctx) {
    const action = String(args.action || 'show');

    if (!ctx.quiet) {
      ctx.renderer?.writeBracketTag('user_profile', action);
    }

    let output = '';
    let exitCode = 0;

    switch (action) {
      case 'show': {
        const content = loadProfile();
        output = content || 'User profile is empty.';
        break;
      }
      case 'add_note': {
        const note = String(args.note || args.text || '');
        const section = String(args.section || 'Notes');
        if (!note) {
          output = 'Usage: user_profile action=add_note section=Notes note=...';
          exitCode = 1;
          break;
        }
        appendNote(note, section as any);
        output = `Note added to "${section}" section.`;
        break;
      }
      default:
        output = 'Unknown user_profile action. Use: show, add_note';
        exitCode = 1;
    }

    return { stdout: output, stderr: '', exitCode, truncated: false };
  },
};
