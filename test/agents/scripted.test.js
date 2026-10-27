// 06 §16, 07 §11.4: without models the client gets a menu whose buttons are deterministic intents; every template
// exists in ru, uz, en.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menu, template, statusText } from '../../server/agents/scripted.js';

const INTENTS = ['show_free', 'open_3d', 'calc_installment', 'book', 'book_viewing', 'my_bookings', 'call_manager', 'leave_phone'];

test('menu: three buttons of 07 §11.4 (+ phone form on the site), in the client language', () => {
  const m = menu('ru');
  assert.match(m.text, /свободные квартиры/);
  assert.deepEqual(m.suggestions.map(s => s.intent), ['show_free', 'calc_installment', 'call_manager', 'leave_phone']);
  assert.deepEqual(menu('uz', { channel: 'telegram' }).suggestions.map(s => s.intent), ['show_free', 'calc_installment', 'call_manager']);
  assert.equal(menu('en').suggestions[2].label, 'Contact a manager');
  for (const s of m.suggestions) assert.ok(INTENTS.includes(s.intent));
});

test('templates: all three languages; refusals carry «find» and «manager»', () => {
  for (const lang of ['ru', 'uz', 'en']) {
    for (const n of ['refusal', 'injection', 'max_steps', 'turn_timeout', 'rate_limited', 'long_message', 'handoff',
      'extension_requested', 'no_kb_answer', 'hello', 'thanks', 'bot']) assert.ok(template(n, lang).text, `${lang} ${n}`);
    for (const a of ['apt_finder', 'finance', 'booking', 'kb_consultant']) assert.ok(statusText(a, lang).endsWith('…'));
  }
  assert.match(template('injection', 'ru').text, /Изменить цены или условия я не могу/);
  assert.deepEqual(template('refusal', 'en').suggestions.map(s => s.intent), ['show_free', 'call_manager']);
  assert.throws(() => template('nope', 'ru'));
});
