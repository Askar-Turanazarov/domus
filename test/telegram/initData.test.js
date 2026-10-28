// 10 §7.2, 10 §10: the signature of Telegram.WebApp.initData — the vector built by hand from a known token,
// an old auth_date, a swapped `user`, a missing or malformed hash; the 5-minute cache never outlives the 24 hours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyInitData, signInitData, checkString, initDataChecker } from '../../server/telegram/initData.js';

const TOKEN = '123456:TEST-token_for-initData';
const AUTH = 1793595600;                                    // 2026-11-02T10:00:00+05:00
const AT = new Date(AUTH * 1000);
const USER = '{"id":77,"first_name":"Аня","username":"anya","language_code":"uz"}';
const now = d => ({ now: () => d });

// The vector without the module: the check string and both HMACs written out as in 10 §7.2.
function vector() {
  const pairs = { auth_date: String(AUTH), query_id: 'AAE-test', user: USER };
  const data = Object.keys(pairs).sort().map(k => `${k}=${pairs[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return new URLSearchParams({ ...pairs, hash }).toString();
}

test('the hand-built vector passes; the user comes out of the JSON', () => {
  const v = verifyInitData(vector(), TOKEN, now(AT));
  assert.equal(v.user.id, 77);
  assert.equal(v.user.language_code, 'uz');
  assert.equal(v.authDate, AUTH);
  assert.equal(signInitData({ auth_date: String(AUTH), query_id: 'AAE-test', user: USER }, TOKEN), vector(), 'the helper signs the same way');
});

test('the check string: sorted by key, without hash, joined by a newline', () => {
  assert.equal(checkString(new URLSearchParams('hash=x&b=2&a=1&c=3')), 'a=1\nb=2\nc=3');
});

const fails = (raw, token = TOKEN, at = AT) => assert.throws(() => verifyInitData(raw, token, now(at)), e => e.code === 'tg_auth_failed');

test('a swapped user, another token, a broken or missing hash — tg_auth_failed', () => {
  const p = new URLSearchParams(vector());
  p.set('user', USER.replace('"id":77', '"id":78'));
  fails(p.toString());
  fails(vector(), '654321:OTHER');
  const h = new URLSearchParams(vector());
  h.set('hash', h.get('hash').replace(/.$/, c => (c === '0' ? '1' : '0')));
  fails(h.toString());
  h.delete('hash');
  fails(h.toString());
  h.set('hash', 'zz');
  fails(h.toString());
  fails('');
  fails(undefined);
  fails(vector(), '');
  fails('x'.repeat(5000));
});

test('auth_date older than 24 h, from the future or missing; a bot or a user without id — tg_auth_failed', () => {
  assert.ok(verifyInitData(vector(), TOKEN, now(new Date(AT.getTime() + 24 * 3600e3))));
  fails(vector(), TOKEN, new Date(AT.getTime() + 24 * 3600e3 + 1000));
  fails(vector(), TOKEN, new Date(AT.getTime() - 3600e3));
  fails(signInitData({ user: USER }, TOKEN));
  fails(signInitData({ auth_date: String(AUTH), user: { id: 5, is_bot: true, first_name: 'b' } }, TOKEN));
  fails(signInitData({ auth_date: String(AUTH), user: { first_name: 'x' } }, TOKEN));
  fails(signInitData({ auth_date: String(AUTH), user: 'not json' }, TOKEN));
});

test('the cache: a hit within 5 minutes skips the check, but the 24 hours still hold', () => {
  let at = AT;
  const check = initDataChecker({ TELEGRAM_BOT_TOKEN: TOKEN }, { now: () => at });
  const raw = vector();
  assert.equal(check(raw).user.id, 77);
  at = new Date(AT.getTime() + 60e3);
  assert.equal(check(raw).user.id, 77);
  at = new Date(AT.getTime() + 24 * 3600e3 + 60e3);
  assert.throws(() => check(raw), e => e.code === 'tg_auth_failed');
  const p = new URLSearchParams(raw);
  p.set('user', USER.replace('"id":77', '"id":78'));
  at = AT;
  assert.throws(() => check(p.toString()), e => e.code === 'tg_auth_failed', 'same hash, other content — not served from the cache');
});
