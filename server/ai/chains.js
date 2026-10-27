// The chain of a role (06 §4, D-01) and the walk along it. Pure: availability is the caller's (health, keys, switches).
import { CHAINS, MODELS } from './models.js';

// → [{ model, provider, index }] from `from` (rule 2: a step resumes on the model it stopped at) onwards.
export function chainOf(role, { from = null } = {}) {
  const list = CHAINS[role];
  if (!list) throw new Error(`unknown AI role: ${role}`);
  const start = from && list.includes(from) ? list.indexOf(from) : 0;
  return list.slice(start).map((model, i) => ({ model, provider: MODELS[model].provider, index: start + i }));
}

// The models a step may still try: available(model, provider) → reason to skip or null.
export function candidates(role, { from = null, skip = () => null } = {}) {
  return chainOf(role, { from }).map(c => ({ ...c, skipped: skip(c.model, c.provider) }));
}
