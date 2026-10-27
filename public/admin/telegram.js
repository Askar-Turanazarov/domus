// Linking the Telegram of the signed-in staff member (12 §12.3, FR-ADM-11): «Link Telegram» asks for a one-time code (15 minutes), shows
// the t.me link, waits for the bot to confirm by polling /api/admin/me, and «Unlink» clears the account. onChange(staff) tells the shell.
import { api, ApiError } from './api.js';
import { el, toast } from './ui.js';
import { t, addTexts } from './i18n.js';

addTexts({
  ru: { 'tgl.title': 'Telegram', 'tgl.lead': 'Привязка нужна, чтобы кнопка «Беру клиента» в группе узнавала вас.', 'tgl.link': 'Привязать Telegram', 'tgl.open': 'Открыть в Telegram',
    'tgl.copy': 'Скопировать ссылку', 'tgl.copied': 'Ссылка скопирована', 'tgl.waiting': 'Ждём ответа бота… Ссылка действует 15 минут и одноразовая.', 'tgl.linked': '✅ Telegram привязан',
    'tgl.unlink': 'Отвязать', 'tgl.unlinked': 'Telegram отвязан', 'tgl.close': 'Закрыть', 'tgl.off': 'Бот Telegram пока не подключён', 'tgl.limit': 'Слишком много попыток, попробуйте позже',
    'tgl.button': 'Telegram', 'tgl.buttonLinked': 'Telegram ✅' },
  en: { 'tgl.title': 'Telegram', 'tgl.lead': 'Linking lets the «I take the client» button in the group recognise you.', 'tgl.link': 'Link Telegram', 'tgl.open': 'Open in Telegram',
    'tgl.copy': 'Copy the link', 'tgl.copied': 'Link copied', 'tgl.waiting': 'Waiting for the bot… The link works once for 15 minutes.', 'tgl.linked': '✅ Telegram linked',
    'tgl.unlink': 'Unlink', 'tgl.unlinked': 'Telegram unlinked', 'tgl.close': 'Close', 'tgl.off': 'The Telegram bot is not connected yet', 'tgl.limit': 'Too many attempts, try later',
    'tgl.button': 'Telegram', 'tgl.buttonLinked': 'Telegram ✅' },
  uz: { 'tgl.title': 'Telegram', 'tgl.lead': 'Ulash guruhdagi «Mijozni olaman» tugmasi sizni tanishi uchun kerak.', 'tgl.link': 'Telegramni ulash', 'tgl.open': 'Telegramda ochish',
    'tgl.copy': 'Havolani nusxalash', 'tgl.copied': 'Havola nusxalandi', 'tgl.waiting': 'Bot javobi kutilmoqda… Havola 15 daqiqa amal qiladi va bir martalik.', 'tgl.linked': '✅ Telegram ulangan',
    'tgl.unlink': 'Uzish', 'tgl.unlinked': 'Telegram uzildi', 'tgl.close': 'Yopish', 'tgl.off': 'Telegram boti hali ulanmagan', 'tgl.limit': 'Urinishlar juda ko‘p, keyinroq urinib ko‘ring',
    'tgl.button': 'Telegram', 'tgl.buttonLinked': 'Telegram ✅' }
});

const POLL_MS = 3000;

// → closes the dialog. The shell passes the staff member as it knows him and gets the fresh one through onChange.
export function openTelegramDialog({ staff, onChange }) {
  let linked = staff.telegramLinked, link = null, timer = null, closed = false;
  const body = el('div', {});
  const err = el('p', { class: 'adm2-err', role: 'alert' });

  const close = () => {
    if (closed) return;
    closed = true; clearInterval(timer); document.removeEventListener('keydown', onKey); overlay.remove();
  };
  const onKey = e => { if (e.key === 'Escape') close(); };

  const fail = ex => {
    err.textContent = ex instanceof ApiError
      ? (ex.code === 'feature_disabled' ? t('tgl.off') : ex.code === 'rate_limited' ? t('tgl.limit') : ex.message)
      : t('app.fail');
  };

  async function check() {
    try {
      const me = (await api('/api/admin/me')).staff;
      if (closed || !me.telegramLinked) return;
      clearInterval(timer); timer = null; linked = true; link = null; onChange?.(me); draw();
    } catch { /* the next tick tries again; a 401 is handled by the shell */ }
  }

  async function ask() {
    err.textContent = '';
    try {
      link = (await api('/api/admin/me/telegram-link', { method: 'POST', body: {} })).url;
      draw();
      clearInterval(timer);
      timer = setInterval(check, POLL_MS);
    } catch (ex) { fail(ex); }
  }

  async function unlink() {
    err.textContent = '';
    try {
      await api('/api/admin/me/telegram', { method: 'DELETE' });
      linked = false; link = null;
      toast(t('tgl.unlinked'));
      const me = (await api('/api/admin/me')).staff;
      onChange?.(me); draw();
    } catch (ex) { fail(ex); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(link); toast(t('tgl.copied')); } catch { /* the link stays on the screen for hand copying */ }
  }

  function draw() {
    body.replaceChildren(
      el('p', {}, t('tgl.lead')),
      linked && el('p', { class: 'adm2-ok', dataset: { state: 'linked' } }, t('tgl.linked')),
      linked && el('button', { type: 'button', class: 'btn danger', dataset: { act: 'unlink' }, on: { click: unlink } }, t('tgl.unlink')),
      !linked && !link && el('button', { type: 'button', class: 'btn primary', dataset: { act: 'link' }, on: { click: ask } }, t('tgl.link')),
      !linked && link && el('div', { class: 'adm2-actions' },
        el('a', { class: 'btn primary', href: link, target: '_blank', rel: 'noopener noreferrer', dataset: { act: 'open' } }, t('tgl.open')),
        el('button', { type: 'button', class: 'btn ghost', dataset: { act: 'copy' }, on: { click: copy } }, t('tgl.copy'))),
      !linked && link && el('p', { class: 'adm2-muted', dataset: { state: 'waiting' } }, t('tgl.waiting')));
  }

  const box = el('div', { class: 'adm2-modal-box' }, el('h2', {}, t('tgl.title')), body, err,
    el('div', { class: 'adm2-modal-actions' }, el('button', { type: 'button', class: 'btn ghost', on: { click: close } }, t('tgl.close'))));
  const overlay = el('div', { class: 'adm2-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('tgl.title'), on: { mousedown: e => { if (e.target === overlay) close(); } } }, box);
  draw();
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return close;
}
