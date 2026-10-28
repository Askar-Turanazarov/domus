// The personal page of a booking /b/<no>-<sig> (11 §6.1, 05 §11): terms, the offer, the payment method, the timer of
// the hold, the booked and the closed states. The page knows only what GET /api/bookings/by-ref/:ref says: the link is
// the key and carries no name or phone. The timer follows the server's clock, ours does not matter.
import { t, getLang, onLangChange, initLangSwitcher } from './i18n.js';
import { initTheme } from './theme.js';
import { groupNum, tashkent, skewOf, remainingMs, clock, linkParts, versionDate } from './bkFormat.js';

const $ = id => document.getElementById(id);
const ref = decodeURIComponent(location.pathname.split('/')[2] ?? '');
const RESYNC_MS = 10_000;          // the timer is checked with the server (05 §11)
const FAST_MS = 3000, FAST_FOR = 30_000;   // after ?paid=1 the webhook may still be on its way (11 §6.1)
const PROVIDERS = ['card', 'click', 'stripe'];

let data = null, skew = 0, shown = '';
let provider = 'card';
let consentTicked = false;
let payKey = null;                 // the Idempotency-Key of a payment attempt: the same on a retry after a lost answer
let fastUntil = new URLSearchParams(location.search).get('paid') ? Date.now() + FAST_FOR : 0;
let pollTimer = null, reloading = false, timerEl = null;
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

// ---------- server ----------

async function api(method, path, body, key) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const failText = r => r.body?.message || t('bk.page.fail');

async function load() {
  let r;
  try {
    r = await api('GET', `/api/bookings/by-ref/${encodeURIComponent(ref)}?lang=${getLang()}`);
  } catch {
    $('bkNet').hidden = false;
    if (!data) showFail(t('bk.page.loadFail'));
    return schedule();
  }
  $('bkNet').hidden = true;
  if (r.status === 404 && r.body.error === 'link_invalid') return showInvalid();
  if (r.status !== 200) {
    if (!data) showFail(failText(r));
    return schedule();
  }
  data = r.body;
  skew = skewOf(data.serverNow, Date.now());
  reloading = false;
  render();
  schedule();
}

// held: ask the server every 10 s (every 3 s right after the payment page); other states change only by the person.
function schedule() {
  clearTimeout(pollTimer);
  if (data?.booking.status !== 'held' || document.hidden) return;
  pollTimer = setTimeout(load, Date.now() < fastUntil ? FAST_MS : RESYNC_MS);
}

function showInvalid() {
  data = null;
  for (const id of ['bkLoading', 'bkBody', 'bkFail']) $(id).hidden = true;
  $('bkInvalid').hidden = false;
  $('bkInvalidBack').href = `/${getLang()}`;
}

function showFail(text) {
  $('bkLoading').hidden = true;
  $('bkFailText').textContent = text;
  $('bkFail').hidden = false;
}

// ---------- the dialog «are you sure» ----------

function ask(text, yes, no) {
  const dlg = $('bkAsk');
  $('bkAskText').textContent = text;
  $('bkAskYes').textContent = yes;
  $('bkAskNo').textContent = no;
  return new Promise(resolve => {
    const done = v => { dlg.close(); resolve(v); };
    $('bkAskYes').onclick = () => done(true);
    $('bkAskNo').onclick = () => done(false);
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
  });
}

// ---------- the page ----------

const sumOf = n => groupNum(n);
const methodName = p => t(`bk.page.${p}`);

function aptBlock() {
  const { apartment: a } = data;
  const rooms = a.rooms ? t('bk.page.rooms', { n: a.rooms }) : t('bld.type.studio');
  return el('section', { className: 'bkp-card bkp-apt' },
    el('h2', { textContent: `${t('bk.page.apt', { no: a.no })} · ${rooms}` }),
    el('p', { className: 'bkp-meta', textContent: `${String(a.area).replace('.', ',')} ${t('unit.m2')} · ${t('bk.page.floor', { n: a.floor })}` }),
    el('p', { className: 'bkp-price', textContent: `${sumOf(a.price)} ${t('unit.sum')}` }));
}

// The offer as text with a link in the words the translation marks with [brackets].
function linked(text, href) {
  return linkParts(text).map(p => (p.link
    ? el('a', { href: `${href}?lang=${getLang()}`, target: '_blank', rel: 'noopener noreferrer', textContent: p.text })
    : document.createTextNode(p.text)));
}

function heldBlocks() {
  const { booking: b, payment: p } = data;
  const out = [];
  const open = p && ['pending', 'processing'].includes(p.status);
  if (p?.status === 'failed') {
    out.push(el('p', { className: 'bkp-err', role: 'alert', textContent: t('bk.page.failed', { reason: p.failureText || p.failureReason || '' }) }));
  }
  if (new URLSearchParams(location.search).get('paid')) out.push(el('p', { className: 'bkp-note', role: 'status', textContent: t('bk.page.checking') }));

  timerEl = el('p', { className: 'bkp-timer', role: 'timer' });
  out.push(el('section', { className: 'bkp-card' }, el('h3', { textContent: t('bk.page.status') }), timerEl));

  const terms = data.terms ?? {};
  out.push(el('section', { className: 'bkp-card' }, el('h3', { textContent: t('bk.page.terms') }),
    el('p', { textContent: t('bk.page.termsText', { deposit: sumOf(b.depositAmount), hours: terms.bookingHours ?? 72, min: terms.holdMinutes ?? 15 }) })));

  if (open) {
    const method = methodName(p.provider);
    out.push(el('section', { className: 'bkp-card' },
      el('p', { textContent: p.mask ? t('bk.page.started', { method: `${method}${p.brand ? ` ${p.brand}` : ''}`, mask: p.mask }) : t('bk.page.startedNoMask', { method }) }),
      el('div', { className: 'bkp-row' },
        p.provider !== 'stripe' && el('a', { className: 'btn primary', href: `/pay/${p.provider}/${p.id}?lang=${getLang()}`, textContent: t('bk.page.continue') }),
        el('button', { type: 'button', className: 'btn', textContent: t('bk.page.other'), onclick: e => otherMethod(e.target, p.id) }))));
  } else {
    const needConsent = !b.consentAt;
    const payBtn = el('button', { type: 'button', className: 'btn primary', textContent: t('bk.page.pay', { sum: sumOf(b.depositAmount) }) });
    const sync = () => { payBtn.disabled = needConsent && !consentTicked; };
    const consent = needConsent
      ? el('label', { className: 'check' }, el('input', { type: 'checkbox', checked: consentTicked,
        onchange: e => { consentTicked = e.target.checked; sync(); } }), el('span', {}, ...linked(t('bk.page.consent'), '/legal/offer')))
      : el('p', { className: 'bkp-done', textContent: t('bk.page.consentDone', { version: versionDate(data.offerVersion, getLang()), when: tashkent(b.consentAt, getLang()) }) });
    out.push(el('section', { className: 'bkp-card' }, consent));
    out.push(el('section', { className: 'bkp-card' }, el('h3', { textContent: t('bk.page.method') }),
      el('div', { className: 'bkp-methods', role: 'radiogroup' }, ...PROVIDERS.map(id => el('label', { className: 'bkp-method' },
        el('input', { type: 'radio', name: 'provider', value: id, checked: id === provider, onchange: () => {
          provider = id;
          try { localStorage.setItem('fsp3d.payProvider', id); } catch { /* storage unavailable */ }
          stripeNote.hidden = provider !== 'stripe';
        } }), el('span', { textContent: methodName(id) })))),
      payBtn));
    const stripeNote = el('p', { className: 'hint', textContent: t('bk.page.stripeNote'), hidden: provider !== 'stripe' });
    out[out.length - 1].insertBefore(stripeNote, payBtn);
    payBtn.onclick = () => pay(payBtn, needConsent);
    sync();
  }
  out.push(el('div', { className: 'bkp-row' }, el('button', { type: 'button', className: 'btn ghost', textContent: t('bk.page.release'),
    onclick: releaseHold })));
  return out;
}

function bookedBlocks() {
  const { booking: b, payment: p, apartment: a } = data;
  const out = [el('section', { className: 'bkp-card bkp-ok' },
    el('h3', { textContent: t('bk.page.booked', { no: a.no, until: tashkent(b.expiresAt, getLang()) }) }),
    el('p', { textContent: t('bk.page.deposit', { sum: sumOf(b.depositAmount) }) }),
    p && el('p', { className: 'hint', textContent: [t('bk.page.payment', { code: p.code }),
      t('bk.page.paidBy', { method: `${methodName(p.provider)}${p.mask ? ` ${p.mask}` : ''}` })].join(' · ') }))];
  out.push(el('section', { className: 'bkp-card' }, el('h3', { textContent: t('bk.page.next') }),
    el('ol', { className: 'bkp-steps' }, ...['next1', 'next2', 'next3'].map(k => el('li', { textContent: t(`bk.page.${k}`) })))));
  out.push(el('div', { className: 'bkp-row' }, el('a', { className: 'btn', href: `/b/${encodeURIComponent(ref)}/confirmation.pdf?lang=${getLang()}`,
    download: '', textContent: t('bk.page.pdf') })));
  out.push(el('div', { className: 'bkp-row' }, data.telegramLinked
    ? el('p', { className: 'hint', textContent: t('bk.page.tgOn') })
    : el('button', { type: 'button', className: 'btn', textContent: t('bk.page.tg'), onclick: e => telegramLink(e.currentTarget) })));
  out.push(el('div', { className: 'bkp-row' }, el('button', { type: 'button', className: 'btn ghost danger', textContent: t('bk.page.cancelBooked'),
    onclick: cancelBooked })));
  return out;
}

function closedBlocks() {
  const { booking: b, payment: p, apartment: a, refund } = data;
  const out = [];
  const paid = p && ['succeeded', 'refund_due', 'refunded'].includes(p.status);
  if (paid && b.status !== 'converted') {   // the money came after the end of the hold: it goes back by itself (05 §11)
    out.push(el('section', { className: 'bkp-card bkp-note' },
      el('p', { textContent: t('bk.page.late', { sum: sumOf(refund?.amount ?? b.depositAmount) }) }),
      refund && el('p', { className: 'hint', textContent: t(`bk.page.refund.${refund.status}`) })));
  }
  out.push(el('section', { className: 'bkp-card' },
    el('p', { textContent: t(`bk.page.closed.${b.closedReason}`) }),
    el('p', { className: 'hint', textContent: t('bk.page.aptNow', { no: a.no, status: t(`bld.st.${a.status}`) }) }),
    el('div', { className: 'bkp-row' },
      a.status === 'free' && el('a', { className: 'btn primary', href: `/${getLang()}#apt=${a.no}&book=1`, textContent: t('bk.page.again') }),
      el('a', { className: 'btn', href: `/${getLang()}`, textContent: t('bk.page.back') }))));
  return out;
}

function render() {
  const sig = JSON.stringify({ ...data, serverNow: 0 }) + getLang() + provider;
  document.title = `${t('bk.page.title', { no: data.booking.no })} · Chinor Park`;
  $('bkTitle').textContent = `Chinor Park · ${t('bk.page.title', { no: data.booking.no })}`;
  for (const id of ['bkLoading', 'bkInvalid', 'bkFail']) $(id).hidden = true;
  $('bkBody').hidden = false;
  if (sig === shown) return tick();
  shown = sig;
  timerEl = null;
  const status = data.booking.status;
  $('bkBody').replaceChildren(aptBlock(), ...(status === 'held' ? heldBlocks() : status === 'booked' ? bookedBlocks() : closedBlocks()));
  if (status !== 'held' && new URLSearchParams(location.search).has('paid')) history.replaceState(null, '', location.pathname);
  tick();
}

// Every second: the time left by the server's clock; at 0:00 the page asks the server what became of the hold.
function tick() {
  if (!data || data.booking.status !== 'held' || !timerEl) return;
  const ms = remainingMs(data.booking.expiresAt, skew, Date.now());
  timerEl.textContent = t('bk.page.timer', { time: clock(ms) });
  timerEl.classList.toggle('low', ms < 120_000);
  if (ms === 0 && !reloading) { reloading = true; load(); }
}

// ---------- actions ----------

async function pay(btn, needConsent) {
  btn.disabled = true;
  btn.textContent = t('bk.page.paying');
  payKey ??= crypto.randomUUID();
  let r;
  try {
    r = await api('POST', '/api/payments', { ref, provider, lang: getLang(), ...(needConsent ? { consent: { version: data.offerVersion } } : {}) }, payKey);
  } catch {
    toast(t('bk.page.offline'), true);   // the answer may be lost: the same key goes again, the server repeats its answer
    btn.disabled = false;
    btn.textContent = t('bk.page.pay', { sum: sumOf(data.booking.depositAmount) });
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

async function otherMethod(btn, paymentId) {
  btn.disabled = true;
  const r = await api('POST', `/api/payments/${encodeURIComponent(paymentId)}/cancel`, {}).catch(() => null);
  if (r && r.status >= 400 && r.body.error !== 'payment_closed') toast(failText(r), true);
  await load();
}

// 11 §6.1, 03 §9.1 R6: a one-time t.me link; the bot joins this booking's client card with the Telegram user.
async function telegramLink(btn) {
  btn.disabled = true;
  const r = await api('POST', `/api/bookings/by-ref/${encodeURIComponent(ref)}/telegram-link`, {}).catch(() => null);
  btn.disabled = false;
  if (r?.status !== 200 || !r.body.url) return toast(r ? failText(r) : t('bk.page.fail'), true);
  if (!window.open(r.body.url, '_blank', 'noopener')) location.assign(r.body.url);
}

async function releaseHold() {
  if (!await ask(t('bk.page.releaseAsk'), t('bk.page.release'), t('bk.page.keep'))) return;
  const r = await api('POST', `/api/bookings/by-ref/${encodeURIComponent(ref)}/release`, {}).catch(() => null);
  if (!r) return toast(t('bk.page.offline'), true);
  if (r.status >= 400) toast(failText(r), true);
  await load();
}

async function cancelBooked() {
  if (!await ask(t('bk.page.cancelAsk'), t('bk.page.cancelYes'), t('bk.page.keep'))) return;
  const r = await api('POST', `/api/bookings/by-ref/${encodeURIComponent(ref)}/cancel`, {}).catch(() => null);
  if (!r) return toast(t('bk.page.offline'), true);
  if (r.status >= 400) toast(failText(r), true);
  await load();
}

// ---------- start ----------

initLangSwitcher();
initTheme();
$('bkRetry').addEventListener('click', () => { $('bkFail').hidden = true; $('bkLoading').hidden = false; load(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); else clearTimeout(pollTimer); });
window.addEventListener('online', load);
onLangChange(() => { shown = ''; load(); });
setInterval(tick, 1000);
load();
