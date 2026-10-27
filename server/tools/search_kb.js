// search_kb (08 §3.1, 09 §5): the knowledge base of the complex — fragments with numbers [1]…[4], or an honest «nothing».
import { z } from 'zod';
import { defineTool } from './define.js';
import { createKb } from '../kb/retrieve.js';

export default defineTool({
  name: 'search_kb',
  title: { ru: 'Поиск по базе знаний ЖК', uz: 'Majmua bilimlar bazasidan qidirish', en: 'Search the complex knowledge base' },
  description: 'Searches the knowledge base of the residential complex (handover dates, construction, materials, finishing, '
    + 'parking, yard and surroundings, documents, deal steps, deposit and installment rules, mortgage, sales office, '
    + 'furniture service). Returns up to 4 numbered fragments, or answered=false when the base has nothing close. '
    + 'It has no prices and no free/booked status of apartments: use the other tools for those.',
  input: z.strictObject({
    query: z.string().trim().min(2).max(500).describe('The client\'s question, as a short self-contained sentence'),
    lang: z.enum(['ru', 'uz', 'en']).optional().describe('Language of the question; default is the dialog language')
  }),
  output: z.object({ answered: z.boolean() }).loose(),
  roles: ['client', 'head'],
  mutates: false,
  async run({ query, lang }, ctx) {
    const kb = ctx.kb ?? createKb({ db: ctx.db, env: ctx.env });                       // without an embedding model: words only
    return kb.retrieve({ query, lang: lang ?? ctx.lang ?? 'ru', conversationId: ctx.conversationId ?? null });
  },
  // The model needs the numbers and the words, not the scores or the ids.
  forModel: out => (out.answered
    ? { answered: true, fragments: out.chunks.map(({ n, heading, text }) => ({ n, heading, text })) }
    : { answered: false, note: 'The knowledge base has no answer. Say so honestly; do not answer from your own knowledge.' })
});
