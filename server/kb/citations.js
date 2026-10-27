// Citations of an answer from the knowledge base (09 §6): the numbers [n] must exist in the search result; the block
// `citations` carries only the chunks the text mentions. Pure.

// → { text, used: [n…] in order of appearance, citations: [{ n, heading, text, doc, score }] }
export function applyCitations(text, chunks = []) {
  const byN = new Map(chunks.map(c => [c.n, c]));
  const used = [];
  const cleaned = String(text ?? '').replace(/[ \t]?\[(\d{1,2})\]/g, (whole, d) => {
    const n = Number(d);
    if (!byN.has(n)) return '';                                              // a number that was never given: removed
    if (!used.includes(n)) used.push(n);
    return whole;
  });
  const citations = used.map(n => {
    const c = byN.get(n);
    return { n, heading: c.heading, text: c.text, doc: c.doc, score: c.score ?? null };
  });
  return { text: cleaned, used, citations };
}
