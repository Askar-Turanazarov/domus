import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, maskPhone } from '../server/core/phone.js';

test('normalizePhone: Uzbek short and long forms, foreign numbers, junk', () => {
  assert.equal(normalizePhone('90 123-45-67'), '+998901234567');
  assert.equal(normalizePhone('(90) 123 45 67'), '+998901234567');
  assert.equal(normalizePhone('998901234567'), '+998901234567');
  assert.equal(normalizePhone('+998 90 123 45 67'), '+998901234567');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  for (const bad of ['', null, '12345', '+1234567', 'abc', '8901234567']) assert.equal(normalizePhone(bad), null, String(bad));
});

test('maskPhone: code and operator plus two last digits', () => {
  assert.equal(maskPhone('+998 90 123 45 67'), '+998 90 *** ** 67');
  assert.equal(maskPhone('+442079460958'), '+44 *** 58');
  assert.equal(maskPhone('x'), '***');
});
