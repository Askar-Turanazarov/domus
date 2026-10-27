// The emulators of UzCard / HUMO (/pay/card/:id) and Click (/pay/click/:id) (11 §6.3, 6.4; 05 §4, §5): a card and an
// expiry → the «SMS» from the bank (the code comes in the server's answer) → the code → back to the booking page.
// The card number lives in this page's memory until the request leaves; it goes to no URL, storage or log (14).
import { t, getLang, onLangChange, initLangSwitcher } from './i18n.js';
import { initTheme } from './theme.js';
import { groupNum, cardNumber, expiry, clock, brandOf } from './bkFormat.js';

const $ = id => document.getElementById(id);
const mode = document.body.dataset.mode === 'click' ? 'click' : 'card';
const id = decodeURIComponent(location.pathname.split('/')[3] ?? '');
const base = `/api/payments/${encodeURIComponent(id)}`;
const route = mode === 'click' ? { card: `${base}/click/card`, confirm: `${base}/click/confirm` } : { card: `${base}/card`, confirm: `${base}/card/confirm` };

// 05 §4.2: the only numbers the emulator accepts.
const TEST_CARDS = [
  ['9860000000090001', 'HUMO', 'success'], ['8600000000060001', 'UZCARD', 'success'], ['5614000000060001', 'UZCARD', 'success'],
  ['9860000000000000', 'HUMO', 'bank_declined'], ['8600000000070000', 'UZCARD', 'bank_declined'],
  ['8600000000050002', 'UZCARD', 'insufficient_funds'], ['9860000000080002', 'HUMO', 'insufficient_funds']
];

let pay = null, card = null, codeUntil = 0, codeTimer = null, smsTimer = null, busy = false;

async function api(path, body) {
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let toastTimer;
function toast(text, isError = false) {
  const box = $('toast');
  box.textContent = text;
  box.className = 'toast' + (isError ? ' error' : '');
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 5000);
}

const back = () => pay?.target?.link ?? '/';
const setBusy = (on, ...btns) => { busy = on; btns.forEach(b => { b.disabled = on; }); };

// ---------- steps ----------

function show(step) {
  $('stepCard').hidden = step !== 'card';
  $('stepCode').hidden = step !== 'code';
  $('payResult').hidden = step !== 'result';
  $('payCancel').hidden = step === 'result';
}

function showClosed(text, ok = false) {
  show('result');
  $('payResultTitle').textContent = ok ? t('pay.done') : t('pay.failedTitle');
  $('payResultText').textContent = text;
  $('payBack').href = back();
}

function renderCards() {
  $('testCards').replaceChildren(...TEST_CARDS.map(([number, brand, scenario]) => {
    const li = document.createElement('li');
    const use = Object.assign(document.createElement('button'), { type: 'button', className: 'btn ghost', textContent: t('pay.use'),
      onclick: () => { $('fNumber').value = cardNumber(number); $('fExpiry').value = nextYearExpiry(); showBrand(); $('fNumber').focus(); } });
    li.append(Object.assign(document.createElement('code'), { textContent: cardNumber(number) }), ` ${brand} — ${t(`pay.scenario.${scenario}`)} `, use);
    return li;
  }));
}

// Any date in the future will do for the emulator: December of next year.
const nextYearExpiry = () => `12/${String((new Date().getFullYear() + 1) % 100).padStart(2, '0')}`;

function showBrand() {
  const digits = $('fNumber').value.replace(/\D/g, '');
  $('payBrand').textContent = brandOf(digits) ?? '';
}

function showSms(text) {
  $('paySmsText').textContent = text;
  $('paySms').hidden = false;
  clearTimeout(smsTimer);
  smsTimer = setTimeout(() => { $('paySms').hidden = true; }, 20_000);
}

function tickCode() {
  const left = codeUntil - Date.now();
  $('codeLeft').textContent = left > 0 ? t('pay.codeLeft', { time: clock(left) }) : t('pay.codeExpired');
}

// Step 1 (also «send again»): the card and the expiry → the SMS.
async function sendCard() {
  if (busy) return;
  const digits = $('fNumber').value.replace(/\D/g, '');
  card = { number: digits, expiry: $('fExpiry').value };
  const btns = [$('cardGo'), $('codeResend')];
  setBusy(true, ...btns);
  $('cardErr').textContent = '';
  let r;
  try {
    r = await api(route.card, { ...card, lang: getLang() });
  } catch {
    setBusy(false, ...btns);
    $('cardErr').textContent = t('pay.loadFail');
    return;
  }
  setBusy(false, ...btns);
  if (r.status !== 200) {
    if (r.body.error === 'payment_closed') return load();
    $('cardErr').textContent = r.body.message ?? t('bk.page.fail');
    show('card');
    return;
  }
  codeUntil = Date.parse(r.body.codeExpiresAt);
  $('payMask').textContent = `${r.body.brand ?? ''} ${r.body.mask ?? ''}`.trim();
  $('fCode').value = '';
  $('codeErr').textContent = '';
  show('code');
  tickCode();
  clearInterval(codeTimer);
  codeTimer = setInterval(tickCode, 1000);
  showSms(r.body.sms.text);
  $('fCode').focus();
}

// Step 2: the code. The answer carries where to go next: the booking page, `?paid=1` on success.
async function sendCode() {
  if (busy) return;
  setBusy(true, $('codeGo'), $('codeResend'));
  $('codeErr').textContent = '';
  let r;
  try {
    r = await api(route.confirm, { code: $('fCode').value.trim(), lang: getLang() });
  } catch {
    setBusy(false, $('codeGo'), $('codeResend'));
    $('codeErr').textContent = t('pay.loadFail');
    return;
  }
  setBusy(false, $('codeGo'), $('codeResend'));
  if (r.status === 200) {
    clearInterval(codeTimer);
    card = null;
    $('paySms').hidden = true;
    const ok = r.body.status === 'succeeded';
    showClosed(ok ? t('pay.redirecting') : (r.body.failureText ?? ''), ok);
    $('payBack').href = r.body.redirect ?? back();
    if (ok || r.body.failureReason === 'hold_expired') setTimeout(() => location.assign(r.body.redirect ?? back()), ok ? 1200 : 4000);
    return;
  }
  if (r.body.error === 'payment_closed') return load();
  $('codeErr').textContent = r.body.message ?? t('bk.page.fail');
  $('fCode').select();
}

async function cancelPayment() {
  if (busy) return;
  await api(`${base}/cancel`, {}).catch(() => null);
  location.assign(back());
}

// ---------- start ----------

async function load() {
  let r;
  try {
    r = await api(`${base}?lang=${getLang()}`);
  } catch {
    $('payLoading').textContent = t('pay.loadFail');
    return;
  }
  $('payLoading').hidden = true;
  $('payBox').hidden = false;
  if (r.status === 404) return showClosed(t('pay.notFound'));
  if (r.status !== 200) return showClosed(r.body.message ?? t('pay.loadFail'));
  pay = r.body;
  $('payAmount').textContent = `${groupNum(pay.amount)} ${t('unit.sum')}`;
  $('payBack').href = back();
  document.title = `${t(mode === 'click' ? 'pay.clickTitle' : 'pay.cardTitle')} · Chinor Park`;
  if (pay.status === 'succeeded') return location.assign(`${back()}?paid=1`);
  if (!['pending', 'processing'].includes(pay.status)) {
    return showClosed(pay.failureText ?? t('pay.closed'));
  }
  if (!$('stepCode').hidden) return;   // a language switch must not throw the person out of the code step
  show('card');
}

initLangSwitcher();
initTheme();
renderCards();
$('fNumber').addEventListener('input', e => { e.target.value = cardNumber(e.target.value); showBrand(); });
$('fExpiry').addEventListener('input', e => { e.target.value = expiry(e.target.value); });
$('fCode').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
$('stepCard').addEventListener('submit', e => { e.preventDefault(); sendCard(); });
$('stepCode').addEventListener('submit', e => { e.preventDefault(); sendCode(); });
$('codeResend').addEventListener('click', () => { if (card) { $('fNumber').value = cardNumber(card.number); $('fExpiry').value = card.expiry; } sendCard(); });
$('payCancel').addEventListener('click', cancelPayment);
onLangChange(() => { renderCards(); if (!$('stepCode').hidden) tickCode(); load(); });
load();
