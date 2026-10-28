// Data comes from the planner (order.js): sessionStorage, else window.opener.__printData.
const data = (() => {
  try { const s = sessionStorage.getItem('fsp3d.print'); if (s) return JSON.parse(s); } catch { /* fall through */ }
  try { return window.opener && window.opener.__printData; } catch { return null; }
})();
const main = document.getElementById('pages');
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
if (!data || !data.pages || !data.pages.length) {
  main.append(el('p', { className: 'empty', textContent:
    'Откройте эту страницу из планировщика (Заявка → Чертёж / PDF). · Rejalashtiruvchidan oching. · Open this page from the planner.' }));
} else {
  document.documentElement.lang = data.lang;
  document.title = data.pages.map(p => p.title).join(' · ');
  const first = data.pages[0];
  document.getElementById('printBtn').textContent = first.print;
  document.getElementById('closeBtn').textContent = first.close;
  document.getElementById('bar').hidden = false;
  for (const p of data.pages) {
    const table = el('table', {},
      el('thead', {}, el('tr', {}, ...p.head.map(h => el('th', { textContent: h })))),
      el('tbody', {}, ...p.rows.map(r => el('tr', {}, ...r.map((v, i) =>
        el('td', { textContent: v, className: i === 0 || i === 5 ? 'num' : '' }))))));
    main.append(el('section', { className: 'sheet' },
      el('img', { src: p.png, alt: p.title }),
      el('div', { className: 'spec' },
        el('h2', { textContent: p.title }), table,
        el('p', { className: 'total', textContent: p.total }),
        el('p', { className: 'note', textContent: p.note }))));
  }
  document.getElementById('printBtn').addEventListener('click', () => window.print());
  document.getElementById('closeBtn').addEventListener('click', () => {
    window.close();
    setTimeout(() => history.back(), 150);   // opened in the same tab: back to the planner
  });
}
