// One core transaction and what it leaves for after COMMIT (03 §1 step 4): Outbox rows to deliver and jobs to publish
// to QStash. ctx — { now, env, render, onCommit }: onCommit({outbox, jobs}) runs only after a successful COMMIT
// (in the API it is waitUntil(deliver + publish)); tests leave it out.
import { now as clockNow } from './clock.js';
import { enqueue } from './outbox.js';
import { schedule } from './jobs.js';

export function context(ctx = {}) {
  return { now: clockNow, env: process.env, render: null, onCommit: null, ...ctx };
}

export async function inTx(db, ctx, fn) {
  const fx = { outbox: [], jobs: [] };
  const result = await db.tx(q => fn(q, fx));
  if (ctx.onCommit && (fx.outbox.length || fx.jobs.length)) ctx.onCommit(fx);
  return result;
}

// Outbox row inside the transaction; a pending row is delivered after COMMIT.
export async function notify(q, fx, ctx, message) {
  const row = await enqueue(q, message, ctx);
  if (row?.status === 'pending') fx.outbox.push(row.id);
  return row;
}

// A job inside the transaction; a new job is published to QStash after COMMIT.
export async function later(q, fx, ctx, type, runAt, payload, dedupeKey) {
  const id = await schedule(q, type, runAt, payload, dedupeKey, ctx);
  if (id) fx.jobs.push({ id, runAt: new Date(runAt) });
  return id;
}
