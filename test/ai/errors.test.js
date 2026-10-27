// 06 §8.2, §8.3: provider errors → our classes. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGemini, classifyAnthropic } from '../../server/ai/errors.js';

const gErr = (status, body) => Object.assign(new Error(`got status: ${status}. ${JSON.stringify({ error: body })}`), { status });

test('gemini: 429 per minute / per day, retryDelay', () => {
  const minute = classifyGemini(gErr(429, { status: 'RESOURCE_EXHAUSTED', details: [
    { violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { retryDelay: '37s' }] }));
  assert.equal(minute.cls, 'rate_minute');
  assert.equal(minute.retryMs, 37000);
  const day = classifyGemini(gErr(429, { status: 'RESOURCE_EXHAUSTED', details: [
    { violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] }));
  assert.equal(day.cls, 'rate_day');
  assert.equal(classifyGemini(gErr(429, {})).cls, 'rate_minute');
});

test('gemini: 5xx, auth, not found, bad request, network', () => {
  assert.equal(classifyGemini(gErr(503, {})).cls, 'overloaded');
  assert.equal(classifyGemini(gErr(504, {})).cls, 'timeout');
  assert.equal(classifyGemini(gErr(500, {})).cls, 'server');
  assert.equal(classifyGemini(gErr(403, {})).cls, 'auth');
  assert.equal(classifyGemini(gErr(404, {})).cls, 'not_found');
  assert.equal(classifyGemini(gErr(400, { message: 'API key not valid. Please pass a valid API key.' })).cls, 'auth');
  assert.equal(classifyGemini(gErr(400, { status: 'FAILED_PRECONDITION' })).reason, 'region');
  assert.equal(classifyGemini(gErr(400, { status: 'INVALID_ARGUMENT' })).cls, 'bad_request');
  assert.equal(classifyGemini(new TypeError('fetch failed')).cls, 'network');
});

test('anthropic: 429 with retry-after, 529, billing, timeout and connection', () => {
  const r = classifyAnthropic(Object.assign(new Error('rate'), { status: 429, headers: { 'retry-after': '12' } }));
  assert.equal(r.cls, 'rate_minute');
  assert.equal(r.retryMs, 12000);
  assert.equal(classifyAnthropic(Object.assign(new Error('x'), { status: 529 })).cls, 'overloaded');
  assert.equal(classifyAnthropic(Object.assign(new Error('Your credit balance is too low'), { status: 400 })).cls, 'billing');
  assert.equal(classifyAnthropic(Object.assign(new Error('bad'), { status: 400 })).cls, 'bad_request');
  class APIConnectionTimeoutError extends Error {}
  class APIConnectionError extends Error {}
  assert.equal(classifyAnthropic(new APIConnectionTimeoutError('t')).cls, 'timeout');
  assert.equal(classifyAnthropic(new APIConnectionError('c')).cls, 'network');
});
