// Golden set of the knowledge base (09 §8): hit@3, MRR, refusal precision, false refusals. Search only — no model answers,
// so the run is cheap and repeatable; the journal kb_queries is not touched.

export const TARGETS = { hit3: 0.90, mrr: 0.75, refusals: 0.90, falseRefusals: 0.10 };

const round = x => Math.round(x * 1000) / 1000;

// → { rows, metrics, pass }; `kb` is createKb(...), `golden` the list of { id, lang, q, inBase, expect? }
export async function runEval({ kb, golden }) {
  const rows = [];
  for (const g of golden) {
    const r = await kb.retrieve({ query: g.q, lang: g.lang, journal: false });
    const docs = r.answered ? r.chunks.map(c => c.doc) : [];
    const place = g.inBase ? docs.findIndex(d => g.expect.includes(d)) + 1 : 0;      // 0 = not found
    rows.push({ id: g.id, lang: g.lang, q: g.q, inBase: g.inBase, answered: r.answered, mode: r.mode, top: r.topScore,
      docs, place, hit3: g.inBase && place > 0 && place <= 3 });
  }
  const inB = rows.filter(r => r.inBase);
  const outB = rows.filter(r => !r.inBase);
  const share = (list, f) => (list.length ? list.filter(f).length / list.length : 0);
  const metrics = {
    hit3: round(share(inB, r => r.hit3)),
    mrr: round(inB.length ? inB.reduce((s, r) => s + (r.place ? 1 / r.place : 0), 0) / inB.length : 0),
    refusals: round(share(outB, r => !r.answered)),
    falseRefusals: round(share(inB, r => !r.answered))
  };
  const pass = metrics.hit3 >= TARGETS.hit3 && metrics.mrr >= TARGETS.mrr && metrics.refusals >= TARGETS.refusals
    && metrics.falseRefusals <= TARGETS.falseRefusals;
  return { rows, metrics, pass };
}

// Markdown report: the metrics against the targets, then every question (failures first in the reader's eye: «✗»).
export function renderReport({ rows, metrics, pass }, { date, minScore, mode }) {
  const mark = ok => (ok ? '✓' : '✗');
  const out = [
    `# Контрольный набор базы знаний — ${date}`, '',
    `Порог \`KB_MIN_SCORE\`: ${minScore}. Режим эмбеддингов: ${mode}. Вопросов: ${rows.length} (в базе ${rows.filter(r => r.inBase).length}, вне базы ${rows.filter(r => !r.inBase).length}).`, '',
    '| Метрика | Значение | Цель | |', '|---|---|---|---|',
    `| hit@3 | ${metrics.hit3} | ≥ ${TARGETS.hit3} | ${mark(metrics.hit3 >= TARGETS.hit3)} |`,
    `| MRR | ${metrics.mrr} | ≥ ${TARGETS.mrr} | ${mark(metrics.mrr >= TARGETS.mrr)} |`,
    `| Точность отказов | ${metrics.refusals} | ≥ ${TARGETS.refusals} | ${mark(metrics.refusals >= TARGETS.refusals)} |`,
    `| Ложные отказы | ${metrics.falseRefusals} | ≤ ${TARGETS.falseRefusals} | ${mark(metrics.falseRefusals <= TARGETS.falseRefusals)} |`,
    '', `Итог: ${pass ? 'цели достигнуты' : 'цели НЕ достигнуты'}.`, '',
    '| id | язык | вопрос | ответ | лучший балл | место | документы | |', '|---|---|---|---|---|---|---|---|'
  ];
  for (const r of rows) {
    const ok = r.inBase ? r.hit3 : !r.answered;
    out.push(`| ${r.id} | ${r.lang} | ${r.q.replace(/\|/g, '/')} | ${r.answered ? 'да' : 'отказ'} | ${r.top == null ? '—' : r.top.toFixed(3)} | ${r.inBase ? (r.place || '—') : '—'} | ${r.docs.join(', ') || '—'} | ${mark(ok)} |`);
  }
  return `${out.join('\n')}\n`;
}
