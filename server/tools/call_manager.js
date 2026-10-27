// call_manager (08 §3.1, 07 §9, S): call a person — the dialog goes to a manager. Chat only: the MCP client token does not
// get it (08 §5).
import { z } from 'zod';
import { defineTool } from './define.js';
import { DomainError } from '../core/errors.js';
import { requestHandoff } from '../core/clients.js';

export default defineTool({
  name: 'call_manager',
  title: { ru: 'Позвать менеджера', uz: 'Menejerni chaqirish', en: 'Call a manager' },
  description: 'Hands the conversation over to a human sales manager, who answers in this chat during working hours. Use when the '
    + 'client asks for a person, complains, or the question cannot be answered. A repeat within 10 minutes changes nothing.',
  input: z.strictObject({
    reason: z.enum(['question', 'complaint', 'booking', 'other']).optional().describe('Why the manager is needed')
  }),
  output: z.object({ requested: z.boolean(), repeated: z.boolean() }),
  roles: ['client'],
  sources: ['agent'],
  mutates: false,
  async run({ reason }, ctx) {
    if (!ctx.actor.id) throw new DomainError('not_found');
    return requestHandoff(ctx.db, { clientId: ctx.actor.id, conversationId: ctx.conversationId ?? null, reason: reason ?? 'other',
      context: ctx.summary ?? '' }, ctx.actor, ctx.core);
  }
});
