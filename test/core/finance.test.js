// 03 §11: installment on whole sums (the PRD table), errors, the comparison with a mortgage; the Domus annuity unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installment, installments, compare, mortgage, annuity } from '../../server/core/finance.js';
import { DEFAULT_SETTINGS } from '../../server/core/defaults.js';

const S = DEFAULT_SETTINGS.installment;
const P = 950_000_000;

test('03 §11.1: the PRD example — 950 000 000 at 30 %, deposit 10 000 000', () => {
  const rows = installments({ price: P, downPct: 30, deposit: 10_000_000 }, S);
  assert.deepEqual(rows.map(r => [r.months, r.restWithMarkup, r.monthly, r.last, r.markup, r.total]), [
    [12, 665_000_000, 55_416_666, 55_416_674, 0, 950_000_000],
    [24, 698_250_000, 29_093_750, 29_093_750, 33_250_000, 983_250_000],
    [36, 731_500_000, 20_319_444, 20_319_460, 66_500_000, 1_016_500_000]
  ]);
  for (const r of rows) {
    assert.equal(r.down, 285_000_000);
    assert.equal(r.rest, 665_000_000);
    assert.equal(r.toPayNow, 275_000_000);
    assert.equal(r.monthly * (r.months - 1) + r.last, r.restWithMarkup, 'the schedule adds up to T');
  }
});

test('03 §11.1: default down payment is the minimum; fractional percents stay exact; no deposit → toPayNow = D', () => {
  const r = installment({ price: P, months: 12 }, S);
  assert.equal(r.downPct, 30);
  assert.equal(r.toPayNow, r.down);
  const f = installment({ price: 1_000_000_001, downPct: 32.5, months: 24 }, S);
  assert.equal(f.down, 325_000_000);                  // round(1 000 000 001 × 0.325) = 325 000 000.325
  assert.ok(Number.isInteger(f.monthly) && Number.isInteger(f.last));
});

test('03 §11.1: errors — below the minimum, a term not in the settings, a bad price', () => {
  assert.throws(() => installment({ price: P, downPct: 20, months: 12 }, S), { code: 'down_payment_too_low', vars: { min: 30 } });
  assert.throws(() => installment({ price: P, months: 18 }, S), { code: 'term_not_available', vars: { terms: [12, 24, 36] } });
  assert.throws(() => installment({ price: 0, months: 12 }, S), { code: 'invalid_input' });
});

test('03 §11.2: mortgage is the Domus annuity', () => {
  assert.equal(mortgage, annuity);
  const m = mortgage({ price: P, downPct: 30, years: 15, rate: 18 });
  assert.equal(m.loan, 665_000_000);
  assert.equal(m.months, 180);
  assert.equal(m.total - m.loan, m.overpay);
  assert.equal(mortgage({ loan: 120_000_000, years: 10, rate: 0 }).monthly, 1_000_000);
});

test('03 §11.3: the comparison — installment rows, a mortgage row only with a rate', () => {
  const without = compare({ price: P, downPct: 30 }, S);
  assert.equal(without.needRate, true);
  assert.deepEqual(without.rows.map(r => [r.kind, r.months, r.overpay]), [['installment', 12, 0], ['installment', 24, 33_250_000], ['installment', 36, 66_500_000]]);
  const withRate = compare({ price: P, downPct: 30, mortgage: { years: 15, rate: 18 } }, S);
  assert.equal(withRate.needRate, false);
  const m = withRate.rows.at(-1);
  assert.equal(m.kind, 'mortgage');
  assert.equal(m.total, 285_000_000 + mortgage({ price: P, downPct: 30, years: 15, rate: 18 }).total);
});
