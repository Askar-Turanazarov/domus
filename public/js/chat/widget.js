// The chat widget of the site (11 §5): a button in the corner, a panel with the dialog, the stream of POST /api/chat.
// Loaded lazily by the pages (dynamic import), so the first paint does not wait for it. Texts only through textContent.
import { t, getLang, onLangChange } from '../i18n.js';
import { streamChat } from './stream.js';
import { renderMarkdown } from './markdown.js';
import { renderBlock, phoneForm } from './blocks.js';

const KEY = 'domus.chat.cid';
const SLOW_MS = 20000;
const POLL_MS = 15_000;            // 11 §5.6: the manager's replies while the widget is open
const store = {
  get() { try { return sessionStorage.getItem(KEY); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch { /* private mode */ } }
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

// opts — { page: 'building' | 'planner' | 'booking', getApartmentNo(): number|null, onOpen(no, {book}) }
export function mountChat({ page = 'building', getApartmentNo = () => null, onOpen = () => {} } = {}) {
  const doc = document;
  if (!doc.querySelector('link[href="/css/chat.css"]')) {
    const css = doc.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/css/chat.css';
    doc.head.append(css);
  }
  const origin = location.origin;
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const fab = mk('button', 'chat-fab');
  fab.type = 'button';
  const panel = mk('section', 'chat-panel');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  const head = mk('header', 'chat-head');
  const title = mk('strong', 'chat-title');
  const manager = mk('button', 'chat-link');
  manager.type = 'button';
  const close = mk('button', 'chat-x', '×');
  close.type = 'button';
  head.append(title, manager, close);
  const log = mk('div', 'chat-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  const note = mk('div', 'chat-note');
  const form = mk('form', 'chat-form');
  const input = mk('textarea');
  input.rows = 1; input.maxLength = 2000;
  const send = mk('button', 'chat-send');
  send.type = 'submit';
  form.append(input, send);
  panel.append(head, log, note, form);
  doc.body.append(fab, panel);

  const state = { cid: store.get(), busy: false, ctl: null, started: false, lastId: 0, bubble: null, mode: 'ai' };
  let pollTimer = null;

  function applyTexts() {
    fab.textContent = t('chat.open');
    fab.setAttribute('aria-label', t('chat.open'));
    title.textContent = t('chat.title');
    panel.setAttribute('aria-label', t('chat.title'));
    manager.textContent = t('chat.manager');
    close.setAttribute('aria-label', t('chat.close'));
    note.textContent = t('chat.note');
    input.placeholder = t('chat.placeholder');
    send.textContent = state.busy ? t('chat.stop') : t('chat.send');
  }
  onLangChange(applyTexts);

  const blockCtx = () => ({
    t, doc, origin,
    onOpen: (no, o) => onOpen(no, o),
    onSuggest: s => press(s),
    onConfirm: (b, d, card) => confirm(b, d, card)
  });

  const scroll = () => { log.scrollTop = log.scrollHeight; };

  function bubble(role) {
    const b = mk('div', `chat-msg ${role}`);
    const body = mk('div', 'chat-text');
    b.append(body);
    log.append(b);
    return { root: b, body, raw: '', status: null, blocks: mk('div', 'chat-blocks'), sg: null };
  }
  function setText(m, text) {
    m.raw = text;
    m.body.replaceChildren(renderMarkdown(text, { doc, origin }));
    scroll();
  }
  function showStatus(m, text) {
    if (!m.status) { m.status = mk('div', 'chat-status'); m.root.prepend(m.status); }
    m.status.textContent = text;
  }
  function clearStatus(m) { m.status?.remove(); m.status = null; }
  function addBlock(m, block) {
    const node = renderBlock(block, blockCtx());
    if (!node) return;
    if (block.type === 'suggestions') { m.sg?.remove(); m.sg = node; m.root.append(node); }
    else { if (!m.blocks.isConnected) m.root.append(m.blocks); m.blocks.append(node); }
    scroll();
  }
  function feedback(m, messageId) {
    const row = mk('div', 'chat-fb');
    for (const [v, key, sign] of [[1, 'chat.up', '👍'], [-1, 'chat.down', '👎']]) {
      const b = mk('button', 'chat-fbtn', sign);
      b.type = 'button';
      b.title = t(key);
      b.setAttribute('aria-label', t(key));
      b.addEventListener('click', async () => {
        for (const x of row.querySelectorAll('button')) x.disabled = true;
        b.classList.add('on');
        try {
          await fetch('/api/chat/feedback', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId, value: v, lang: getLang() }) });
        } catch { /* feedback is not worth an error */ }
      });
      row.append(b);
    }
    m.root.append(row);
  }
  function fail(m, text) {
    clearStatus(m);
    const e = mk('div', 'chat-error', text);
    m.root.append(e);
    scroll();
  }

  function setBusy(v) {
    state.busy = v;
    panel.classList.toggle('busy', v);
    send.textContent = v ? t('chat.stop') : t('chat.send');
  }

  // One turn: body is { text } or { intent, payload }. The user's bubble is drawn by the caller.
  async function turn(body) {
    if (state.busy) return;
    for (const old of log.querySelectorAll('.chat-sg')) old.remove();     // buttons of the previous answer are stale
    const m = bubble('assistant');
    state.bubble = m;
    showStatus(m, '…');
    const ctl = new AbortController();
    state.ctl = ctl;
    setBusy(true);
    const slow = setTimeout(() => showStatus(m, t('chat.slow')), SLOW_MS);
    let got = false;
    const onEvent = ({ event, data }) => {
      got = true;
      if (event === 'meta') { state.cid = data.conversationId; store.set(state.cid); }
      else if (event === 'status') showStatus(m, data.text);
      else if (event === 'text') { clearStatus(m); setText(m, m.raw + (data.delta ?? '')); }
      else if (event === 'reset') { m.raw = ''; m.body.replaceChildren(); showStatus(m, t('chat.reset')); }
      else if (event === 'block') addBlock(m, data);
      else if (event === 'suggestions') addBlock(m, { type: 'suggestions', data });
      else if (event === 'done') { clearStatus(m); if (data.messageId) { feedback(m, data.messageId); state.lastId = Math.max(state.lastId, data.messageId); } }
      else if (event === 'error') fail(m, data.text ?? t('chat.failed'));
    };
    try {
      await streamChat('/api/chat', { ...body, ...(state.cid ? { conversationId: state.cid } : {}), lang: getLang(),
        context: { page, ...(getApartmentNo() ? { apartmentNo: getApartmentNo() } : {}) } }, onEvent, { signal: ctl.signal });
    } catch (e) {
      if (e?.name === 'AbortError') { clearStatus(m); if (!m.raw) m.root.remove(); }
      else if (e?.status === 409) fail(m, t('chat.busy'));
      else if (e?.status) fail(m, e.body?.message ?? t('chat.failed'));
      else fail(m, t(got ? 'chat.failed' : 'chat.offline'));
    } finally {
      clearTimeout(slow);
      clearStatus(m);
      if (!m.raw && !m.blocks.isConnected && !m.root.querySelector('.chat-error')) m.root.remove();   // with a manager: no answer bubble
      state.ctl = null;
      setBusy(false);
    }
    poll();   // the mode may have changed (a manager was called)
  }

  function say(text) {
    const m = bubble('user');
    setText(m, text);
    return turn({ text });
  }

  // A button: an intent goes to the server as it is (nothing is sent as a «message» of the person), a link opens itself.
  function press(s) {
    if (state.busy) return;
    if (s.callback) return confirm({ action: parseCb(s.data), data: s.data, label: s.label }, { pendingActionId: s.data.split(':')[1] }, null);
    if (s.intent === 'leave_phone') return askPhone();
    if (s.intent === 'new_dialog') return reset();
    if (s.intent) {
      const m = bubble('user');
      setText(m, s.label);
      return turn({ intent: s.intent, payload: s.payload ?? {} });
    }
    return say(s.text ?? s.label);
  }
  const parseCb = data => ({ y: 'yes', e: 'edit', n: 'no', r: 'retry' }[String(data).split(':')[2]] ?? 'no');

  function askPhone() {
    const m = bubble('assistant');
    m.root.append(phoneForm({ t, doc, onSend: p => { m.root.remove(); turn({ intent: 'leave_phone', payload: p }); } }));
    scroll();
  }

  // «Да» / «Изменить» / «Отмена» / «Повторить» on a draft (07 §8): its own endpoint, with the key against a double press.
  async function confirm(b, d, card) {
    const answer = b.action === 'cancel' ? 'no' : b.action;
    const m = bubble('assistant');
    showStatus(m, '…');
    const key = uuid();
    try {
      const res = await fetch('/api/chat/confirm', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ pendingActionId: d.pendingActionId, answer, lang: getLang() }) });
      const j = await res.json().catch(() => ({}));
      clearStatus(m);
      if (!res.ok) {
        setText(m, j.message ?? t('chat.failed'));
        for (const s of j.suggestions ?? []) addBlock(m, { type: 'suggestions', data: [s] });
        card?.classList.add('gone');
        return;
      }
      card?.classList.add('gone');
      setText(m, j.text ?? '');
      for (const bl of j.blocks ?? []) addBlock(m, bl);
      if (j.suggestions?.length) addBlock(m, { type: 'suggestions', data: j.suggestions });
    } catch {
      fail(m, t('chat.offline'));
      if (card) for (const x of card.querySelectorAll('button')) x.disabled = false;
    }
  }

  function reset() {
    state.cid = null;
    store.set(null);
    log.replaceChildren();
    state.started = false;
    greet();
  }

  function greet() {
    state.started = true;
    const m = bubble('assistant');
    setText(m, t('chat.greeting'));
    addBlock(m, { type: 'suggestions', data: [
      { label: t('chat.sg.pick'), intent: 'show_free', payload: {} },
      { label: t('chat.sg.terms'), intent: 'calc_installment', payload: {} },
      { label: t('chat.sg.viewing'), intent: 'book_viewing', payload: {} }] });
  }

  // The dialog of a returning visitor (the same tab): what was said, so the thread is not lost on a reload.
  async function restore() {
    if (!state.cid) return false;
    try {
      const res = await fetch(`/api/chat/${state.cid}/messages?after=0`, { credentials: 'same-origin' });
      if (!res.ok) { store.set(null); state.cid = null; return false; }
      const { items, mode } = await res.json();
      state.mode = mode ?? 'ai';
      if (!items.length) return false;
      for (const it of items) show(it);
      state.started = true;
      return true;
    } catch { return false; }
  }

  function show(it) {
    const m = bubble(it.role === 'user' ? 'user' : 'assistant');
    if (it.role === 'staff') m.root.prepend(mk('div', 'chat-who', t('chat.staff')));
    setText(m, it.text ?? '');
    if (it.role !== 'user') for (const b of it.blocks ?? []) if (b.type !== 'confirm') addBlock(m, b);
    state.lastId = Math.max(state.lastId, it.id);
  }

  // 11 §5.6: while the widget is open and the dialog is with a manager, his replies come every 15 s (the client's own lines
  // are already on screen). After a turn — once, to learn the mode.
  async function poll() {
    clearTimeout(pollTimer);
    if (!state.cid || panel.hidden || state.busy) return;
    try {
      const res = await fetch(`/api/chat/${state.cid}/messages?after=${state.lastId}`, { credentials: 'same-origin' });
      if (res.ok) {
        const { items, mode } = await res.json();
        for (const it of items) { if (it.role === 'user') state.lastId = Math.max(state.lastId, it.id); else show(it); }
        state.mode = mode ?? state.mode;
      }
    } catch { /* offline: the next round */ }
    if (!panel.hidden && state.mode === 'human') pollTimer = setTimeout(poll, POLL_MS);
  }

  async function open() {
    panel.hidden = false;
    fab.hidden = true;
    if (!state.started && !(await restore())) greet();
    input.focus();
    scroll();
    if (state.mode === 'human') pollTimer = setTimeout(poll, POLL_MS);
  }
  function shut() {
    clearTimeout(pollTimer);
    panel.hidden = true;
    fab.hidden = false;
    fab.focus();
  }

  fab.addEventListener('click', open);
  close.addEventListener('click', shut);
  manager.addEventListener('click', () => press({ label: t('chat.manager'), intent: 'call_manager', payload: {} }));
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') shut(); });
  form.addEventListener('submit', e => {
    e.preventDefault();
    if (state.busy) { state.ctl?.abort(); return; }
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = '';
    say(text);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; });

  applyTexts();
  return { open, close: shut, say };
}
