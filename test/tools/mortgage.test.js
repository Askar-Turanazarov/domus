// calc_mortgage: the annuity at the monthly rate against hand-made references, zero rate, bounds.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { annuity } from '../../server/core/finance.js';
import { list, start } from './helpers.js';

const s = await start();
after(() => s.server.close());

test('annuity: loan 80 000 000 sum, 24 % a year, 10 years → 1 763 848 a month, overpay 131 661 730', () => {
  // by hand (decimal, 40 digits): i = 0.24 / 12 = 0.02, n = 120, (1 + i)^n = 10.765163034
  // monthly = 80 000 000 · 0.02 / (1 − 1 / 10.765163034) = 1 763 847.75; total = 1 763 847.75 · 120 = 211 661 730.10
  assert.deepEqual(annuity({ loan: 80_000_000, years: 10, rate: 24 }), {
    price: 80_000_000, down: 0, loan: 80_000_000, months: 120,
    monthly: 1_763_848, total: 211_661_730, overpay: 131_661_730
  });
});

test('annuity: 1 000 000 000 sum, 20 % down, 20 years, 18 % → the reference payment', () => {
  // 800 000 000 · 0.015 / (1 − 1.015^−240) = 12 346 492.19; total = 12 346 492.19 · 240 = 2 963 158 124.86
  assert.deepEqual(annuity({ price: 1_000_000_000, downPct: 20, years: 20, rate: 18 }), {
    price: 1_000_000_000, down: 200_000_000, loan: 800_000_000, months: 240,
    monthly: 12_346_492, total: 2_963_158_125, overpay: 2_163_158_125
  });
});

test('annuity: zero rate is the loan split evenly; everything in whole sum', () => {
  const r = annuity({ price: 1_000_000_000, downPct: 20, years: 20, rate: 0 });
  assert.deepEqual([r.monthly, r.total, r.overpay], [3_333_333, 800_000_000, 0]);
  assert.equal(annuity({ loan: 600_000_000, years: 10, rate: 0 }).monthly, 5_000_000);
  for (const v of Object.values(annuity({ loan: 123_456_789, years: 7, rate: 21.5 }))) assert.ok(Number.isInteger(v));
});

test('calc_mortgage over MCP: by loan, by price and by apartment number', async () => {
  const r = await s.call('calc_mortgage', { loan: 80_000_000, years: 10, rate: 24 });
  assert.deepEqual([r.structuredContent.monthly, r.structuredContent.total, r.structuredContent.overpay], [1_763_848, 211_661_730, 131_661_730]);
  assert.match(r.content[0].text, /1\s763\s848 сум в месяц/);
  assert.match(r.content[0].text, /переплата 131\s661\s730 сум/);
  assert.equal((await s.call('calc_mortgage', { price: 1_000_000_000, downPct: 20, years: 20, rate: 18 })).structuredContent.monthly, 12_346_492);
  const a1 = list.find(a => a.no === 1);
  const byNo = await s.call('calc_mortgage', { no: 1, downPct: 30, years: 15, rate: 20 });
  assert.deepEqual(byNo.structuredContent, { ...annuity({ price: a1.price, downPct: 30, years: 15, rate: 20 }), no: 1 });
});

test('calc_mortgage: none or several of loan / price / no, down payment with a loan, unknown number, out of bounds → tool errors', async () => {
  const base = { years: 20, rate: 18 };
  for (const args of [base, { ...base, price: 1e9, no: 1 }, { ...base, loan: 8e7, price: 1e9 }, { ...base, loan: 8e7, downPct: 20 },
    { ...base, no: 9999 }, { ...base, price: 1e9, downPct: 95 }, { ...base, loan: 8e7, years: 31 }, { ...base, loan: 8e7, years: 0 },
    { ...base, loan: 8e7, rate: -1 }, { ...base, loan: 8e7, rate: 61 }, { ...base, loan: 8e7 + 0.5 }]) {
    const r = await s.call('calc_mortgage', args);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.match((await s.call('calc_mortgage', base)).content[0].text, /Укажите что-то одно/);
});
