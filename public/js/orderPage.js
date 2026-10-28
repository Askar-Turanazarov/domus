// The personal page of a furniture order /o/<no>-<sig> (11 §6.6, 05 §3.3, S): what is ordered, the estimate, the 30%
// prepayment with the offer checkbox and the payment method, the stage strip. The page knows only what
// GET /api/orders/by-ref/:ref says: the link is the key and carries no name or phone. No timer: an order has no hold.
import { t, getLang, onLangChange, initLangSwitcher } from './i18n.js';
import { initTheme } from './theme.js';
import { groupNum, tashkent, linkParts } from './bkFormat.js';

const $ = id => document.getElementById(id);
const ref = decodeURIComponent(location.pathname.split('/')[2] ?? '');
const PROVIDERS = ['card', 'click', 'stripe'];
const FAST_MS = 3000, FAST_FOR = 30_000;   // after ?paid=1 the webhook may still be on its way

let data = null, shown = '', provider = 'card', consentTicked = false, payKey = null, pollTimer = null;
let fastUntil = new URLSearchParams(location.search).get('paid') ? Date.now() + FAST_FOR : 0;
try { provider = localStorage.getItem('fsp3d.payProvider'); } catch { /* storage unavailable */ }
if (!PROVIDERS.includes(provider)) provider = 'card';

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter(k => k != null && k !== false));
  return e;
}

let toastTimer;
function toast(text, isError = false) {
  const box = $('toast');
  box.textContent = text;
  box.className = 'toast' + (isError ? ' error' : '');
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, isError ? 5000 : 3500);
}

async function api(method, path, body, key) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const failText = r => r.body?.message || t('bk.page.fail');

async function load() {
  let r;
  try {
    r = await api('GET', `/api/orders/by-ref/${encodeURIComponent(ref)}?lang=${getLang()}`);
  } catch {
    $('bkNet').hidden = false;
    if (!data) showFail(t('bk.page.loadFail'));
    return;
  }
  $('bkNet').hidden = true;
  if (r.status === 404 && r.body.error === 'link_invalid') return showInvalid();
  if (r.status !== 200) return data ? null : showFail(failText(r));
  data = r.body;
  render();
  clearTimeout(pollTimer);
  if (Date.now() < fastUntil && !data.order.prepaidAt) pollTimer = setTimeout(load, FAST_MS);
}

function showInvalid() {
  for (const id of ['bkLoading', 'bkBody', 'bkFail']) $(id).hidden = true;
  $('bkInvalid').hidden = false;
  $('bkInvalidBack').href = `/${getLang()}`;
}

function showFail(text) {
  $('bkLoading').hidden = true;
  $('bkFailText').textContent = text;
  $('bkFail').hidden = false;
}

const sum = n => groupNum(n);
const linked = (text, href) => linkParts(text).map(p => (p.link
  ? el('a', { href: `${href}?lang=${getLang()}`, target: '_blank', rel: 'noopener noreferrer', textContent: p.text })
  : document.createTextNode(p.text)));

function contentBlock() {
  const o = data.order;
  return el('section', { className: 'bkp-card' },
    el('h3', { textContent: t('od.content') }),
    o.project && el('p', { className: 'bkp-meta', textContent: t('od.project', { name: o.project }) }),
    o.apartmentNo && el('p', { className: 'bkp-meta', textContent: t('od.apt', { no: o.apartmentNo }) }),
    el('ul', { className: 'bkp-steps' }, ...o.rooms.map(r => el('li', {},
      el('b', { textContent: r.name || t('od.room') }), ` — ${t('od.items', { n: r.items.length })}`,
      r.items.length ? el('div', { className: 'hint', textContent: r.items.join(', ') }) : null))),
    o.estimate != null && el('p', { className: 'bkp-price', textContent: t('od.estimate', { sum: sum(o.estimate) }) }));
}

// принят → производство → доставка → сборка → готово; the current one bold, the passed ones ticked.
function stageBlock() {
  const o = data.order;
  if (o.stage === 'cancelled') return el('section', { className: 'bkp-card bkp-note' }, el('p', { textContent: t('od.cancelled') }));
  const steps = o.stages.filter(s => s !== 'new');
  const at = steps.indexOf(o.stage);
  return el('section', { className: 'bkp-card' }, el('h3', { textContent: t('od.stage') }),
    el('ol', { className: 'od-stages' }, ...steps.map((s, i) => el('li', {
      className: i < at ? 'done' : i === at ? 'now' : '', textContent: (i < at ? '✓ ' : '') + t(`od.st.${s}`),
      ...(i === at ? { ariaCurrent: 'step' } : {}) }))));
}

function payBlocks() {
  const { order: o, payment: p } = data;
  if (o.stage === 'cancelled') return [];
  if (o.prepaidAt) return [el('section', { className: 'bkp-card bkp-ok' }, el('p', { textContent: t('od.paid', { sum: sum(o.prepayAmount), when: tashkent(o.prepaidAt, getLang()) }) }))];
  if (!o.prepayAmount) return [el('section', { className: 'bkp-card' }, el('p', { textContent: t('od.noPrepay') }))];
  const out = [];
  if (p?.status === 'failed') {
    out.push(el('p', { className: 'bkp-err', role: 'alert', textContent: t('bk.page.failed', { reason: p.failureText || p.failureReason || '' }) }));
  }
  if (new URLSearchParams(location.search).get('paid')) out.push(el('p', { className: 'bkp-note', role: 'status', textContent: t('bk.page.checking') }));
  out.push(el('section', { className: 'bkp-card' }, el('h3', { textContent: t('od.prepay', { pct: data.prepayPct, sum: sum(o.prepayAmount) }) }),
    el('p', { className: 'hint', textContent: t('od.prepayNote') })));
  if (p && ['pending', 'processing'].includes(p.status) && p.provider !== 'stripe') {
    out.push(el('section', { className: 'bkp-card' }, el('div', { className: 'bkp-row' },
      el('a', { className: 'btn primary', href: `/pay/${p.provider}/${p.id}?lang=${getLang()}`, textContent: t('bk.page.continue') }))));
  }
  const needConsent = o.consentVersion !== data.offerVersion;
  const payBtn = el('button', { type: 'button', className: 'btn primary', textContent: t('bk.page.pay', { sum: sum(o.prepayAmount) }) });
  const sync = () => { payBtn.disabled = needConsent && !consentTicked; };
  if (needConsent) {
    out.push(el('section', { className: 'bkp-card' }, el('label', { className: 'check' }, el('input', { type: 'checkbox', checked: consentTicked,
      onchange: e => { consentTicked = e.target.checked; sync(); } }), el('span', {}, ...linked(t('bk.page.consent'), '/legal/offer')))));
  }
  const stripeNote = el('p', { className: 'hint', textContent: t('bk.page.stripeNote'), hidden: provider !== 'stripe' });
  out.push(el('section', { className: 'bkp-card' }, el('h3', { textContent: t('bk.page.method') }),
    el('div', { className: 'bkp-methods', role: 'radiogroup' }, ...PROVIDERS.map(id => el('label', { className: 'bkp-method' },
      el('input', { type: 'radio', name: 'provider', value: id, checked: id === provider, onchange: () => {
        provider = id;
        try { localStorage.setItem('fsp3d.payProvider', id); } catch { /* storage unavailable */ }
        stripeNote.hidden = provider !== 'stripe';
      } }), el('span', { textContent: t(`bk.page.${id}`) })))),
    stripeNote, payBtn));
  payBtn.onclick = () => pay(payBtn, needConsent);
  sync();
  return out;
}

function render() {
  const sig = JSON.stringify({ ...data, serverNow: 0 }) + getLang() + provider;
  document.title = `${t('od.title', { no: data.order.no })} · Chinor Park`;
  $('bkTitle').textContent = `Chinor Park · ${t('od.title', { no: data.order.no })}`;
  for (const id of ['bkLoading', 'bkInvalid', 'bkFail']) $(id).hidden = true;
  $('bkBody').hidden = false;
  if (sig === shown) return;
  shown = sig;
  $('bkBody').replaceChildren(contentBlock(), stageBlock(), ...payBlocks());
  if (data.order.prepaidAt && new URLSearchParams(location.search).has('paid')) history.replaceState(null, '', location.pathname);
}

async function pay(btn, needConsent) {
  btn.disabled = true;
  btn.textContent = t('bk.page.paying');
  payKey ??= crypto.randomUUID();
  let r;
  try {
    r = await api('POST', '/api/payments', { ref: `o:${ref}`, provider, lang: getLang(),
      ...(needConsent ? { consent: { version: data.offerVersion } } : {}) }, payKey);
  } catch {
    toast(t('bk.page.offline'), true);   // the answer may be lost: the same key goes again, the server repeats its answer
    btn.disabled = false;
    btn.textContent = t('bk.page.pay', { sum: sum(data.order.prepayAmount) });
    return;
  }
  if (r.status === 201 && /^(\/(?!\/)|https:\/\/)/.test(r.body.url ?? '')) {
    location.assign(r.body.url);
    return;
  }
  payKey = null;
  toast(failText(r), true);
  shown = '';
  await load();
}

initLangSwitcher();
initTheme();
$('bkRetry').addEventListener('click', () => { $('bkFail').hidden = true; $('bkLoading').hidden = false; load(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
window.addEventListener('online', load);
onLangChange(() => { shown = ''; load(); });
load();
