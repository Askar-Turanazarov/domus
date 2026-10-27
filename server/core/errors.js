// Core errors (01 §8, 03 §16): a code from 13 §2 and its vars; the API turns them into { error, message } in the
// client's language and the HTTP status.
export class DomainError extends Error {
  constructor(code, vars = {}) {
    super(`err:${code}`);
    this.code = code;
    this.vars = vars;
  }
}

// Rights (14 §3): actor.role must be one of roles, else err:forbidden.
export function need(actor, ...roles) {
  if (!actor || !roles.includes(actor.role)) throw new DomainError('forbidden');
}

// A staff id for events and the «who» columns: only when a staff member acts.
export const staffIdOf = actor => (actor?.type === 'staff' ? actor.id : null);

// Reasons are 3…300 characters (03 §6, §7) → the trimmed text.
export function reasonOf(reason) {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (r.length < 3 || r.length > 300) throw new DomainError('reason_required');
  return r;
}
