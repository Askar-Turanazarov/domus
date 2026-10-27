// The client helpers of the booking page (11 §6.1, §10): the timer follows the server's clock, times are Tashkent's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupNum, tashkent, skewOf, remainingMs, clock, cardNumber, expiry, phone, brandOf, linkParts, versionDate } from '../public/js/bkFormat.js';

test('timer: the browser clock is 2 hours slow — the time left is still the server\'s', () => {
  const serverNow = '2026-10-28T10:00:00+05:00';
  const localAtAnswer = Date.parse(serverNow) - 2 * 3600e3;          // our clock says 08:00
  const skew = skewOf(serverNow, localAtAnswer);
  assert.equal(skew, 2 * 3600e3);
  const expires = '2026-10-28T10:15:00+05:00';
  assert.equal(remainingMs(expires, skew, localAtAnswer), 15 * 60e3);
  assert.equal(clock(remainingMs(expires, skew, localAtAnswer + 12 * 60e3 + 12e3)), '02:48');   // 12:12 later
  assert.equal(remainingMs(expires, skew, localAtAnswer + 20 * 60e3), 0, 'never below zero');
});

test('timer: a clock that is fast gives the same answer', () => {
  const serverNow = '2026-10-28T10:00:00+05:00';
  const local = Date.parse(serverNow) + 7 * 3600e3;
  assert.equal(remainingMs('2026-10-28T10:15:00+05:00', skewOf(serverNow, local), local), 15 * 60e3);
});

test('clock(): mm:ss, hours when there are some, rounds up', () => {
  assert.equal(clock(768_000), '12:48');
  assert.equal(clock(1), '00:01');
  assert.equal(clock(0), '00:00');
  assert.equal(clock(3723e3), '1:02:03');
});

test('tashkent(): UTC+5 whatever the zone of the browser', () => {
  assert.equal(tashkent('2026-10-28T15:00:00+05:00', 'ru'), '28.10, 15:00');
  assert.equal(tashkent('2026-10-28T10:00:00Z', 'uz'), '28.10, 15:00');
  assert.equal(tashkent('2026-10-28T15:00:00+05:00', 'en'), 'Oct 28, 3:00 PM');
  assert.equal(tashkent('2026-10-31T00:05:00+05:00', 'en'), 'Oct 31, 12:05 AM');
  assert.equal(tashkent('not a date'), '');
});

test('groupNum(): non-breaking spaces', () => {
  assert.equal(groupNum(812_000_000), '812 000 000');
  assert.equal(groupNum(10_000_000), '10 000 000');
  assert.equal(groupNum(999), '999');
});

test('masks: card, expiry, phone', () => {
  assert.equal(cardNumber('98600000000900019999'), '9860 0000 0009 0001');
  assert.equal(cardNumber('9860-0000'), '9860 0000');
  assert.equal(expiry('1228'), '12/28');
  assert.equal(expiry('12'), '12');
  assert.equal(phone('901234567'), '+998 90 123 45 67');
  assert.equal(phone('+998901234567'), '+998 90 123 45 67');
  assert.equal(phone('abc'), '');
  assert.equal(brandOf('98600000'), 'HUMO');
  assert.equal(brandOf('56140000'), 'UZCARD');
  assert.equal(brandOf('42424242'), null);
});

test('linkParts(): the translation decides where the link is', () => {
  assert.deepEqual(linkParts('I accept the [public offer] today'),
    [{ text: 'I accept the ' }, { text: 'public offer', link: true }, { text: ' today' }]);
  assert.deepEqual(linkParts('[Oferta] shartlari'), [{ text: 'Oferta', link: true }, { text: ' shartlari' }]);
  assert.deepEqual(linkParts('no link'), [{ text: 'no link' }]);
});

test('versionDate(): the offer edition as a date', () => {
  assert.equal(versionDate('2026-10-27', 'ru'), '27.10.2026');
  assert.equal(versionDate('2026-10-27', 'en'), 'Oct 27, 2026');
  assert.equal(versionDate('v2'), 'v2');
});
