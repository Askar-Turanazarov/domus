// The one interface of both adapters (01 §8.1). Inside a transaction the handle is the same shape, and its tx()
// just runs in that transaction — so core functions take either db or an open transaction q.
export function handle(kind, query, extra = {}) {
  const h = {
    kind,
    query,
    one: async (text, params) => (await query(text, params))[0] ?? null,
    tx: fn => fn(h),
    ...extra
  };
  return h;
}
