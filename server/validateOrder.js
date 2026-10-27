// Server-side check of POST /api/order. Pure: body → { ok: true, order, files } | { ok: false, error, field }.
// Only whitelisted fields survive; strings are trimmed and cut, numbers range-checked.
const LIMITS = { size: [50, 3000], items: 200, openings: 50, obstacles: 50, rooms: 20, picture: 1.5 * 1024 * 1024 };   // two pictures + the order stay under Vercel's 4.5 MB
const PHONE = /^\+?[0-9 ()-]{7,20}$/;
const LANGS = ['ru', 'uz', 'en'];
const ROTS = [0, 90, 180, 270];
const WALLS = ['north', 'east', 'south', 'west'];

class Invalid extends Error {
  constructor(field) { super('invalid_order'); this.field = field; }
}

const str = (v, max, field, required = false) => {
  if (v == null || v === '') { if (required) throw new Invalid(field); return ''; }
  if (typeof v !== 'string' && typeof v !== 'number') throw new Invalid(field);
  const s = String(v).trim();
  if (required && !s) throw new Invalid(field);
  if (s.length > max) throw new Invalid(field);
  return s;
};

const num = (v, [min, max], field, def) => {
  if (v == null && def !== undefined) return def;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Invalid(field);
  return v;
};

const list = (v, max, field) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max) throw new Invalid(field);
  return v;
};

const obj = (v, field) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Invalid(field);
  return v;
};

function room(r, f) {
  obj(r, f);
  return {
    L: num(r.L, LIMITS.size, f + '.L'), W: num(r.W, LIMITS.size, f + '.W'), H: num(r.H, LIMITS.size, f + '.H'),
    plinth: num(r.plinth, [0, 20], f + '.plinth', 2)
  };
}

const COORD = [-3000, 6000];
function item(it, f) {
  obj(it, f);
  const out = {
    type: str(it.type, 40, f + '.type', true), name: str(it.name, 100, f + '.name'),
    w: num(it.w, [1, 3000], f + '.w'), d: num(it.d, [1, 3000], f + '.d'), h: num(it.h, [1, 3000], f + '.h'),
    x: num(it.x, COORD, f + '.x'), y: num(it.y, COORD, f + '.y'),
    rot: num(it.rot, [0, 270], f + '.rot', 0), elev: num(it.elev, [0, 3000], f + '.elev', 0)
  };
  if (!ROTS.includes(out.rot)) throw new Invalid(f + '.rot');
  if (/^#[0-9a-f]{6}$/i.test(it.color)) out.color = it.color;   // anything else is just dropped
  if (it.materials != null) {
    obj(it.materials, f + '.materials');
    out.materials = {};
    for (const k of ['body', 'facade']) if (it.materials[k] != null) out.materials[k] = str(it.materials[k], 40, f + '.materials');
  }
  if (it.open != null) {
    obj(it.open, f + '.open');
    out.open = {};
    if (it.open.kind != null) out.open.kind = str(it.open.kind, 20, f + '.open');
    if (it.open.doors != null) out.open.doors = num(it.open.doors, [0, 8], f + '.open');
    if (it.open.depth != null) out.open.depth = num(it.open.depth, [0, 300], f + '.open');
  }
  for (const k of ['sections', 'drawers']) if (it[k] != null) out[k] = Math.round(num(it[k], [0, 20], f + '.' + k));
  out.price = it.price == null ? null : num(it.price, [0, 1e12], f + '.price');
  return out;
}

function opening(o, f) {
  obj(o, f);
  const kind = str(o.kind, 10, f + '.kind', true);
  if (!['door', 'window'].includes(kind) || !WALLS.includes(o.wall)) throw new Invalid(f);
  const out = {
    kind, wall: o.wall, offset: num(o.offset, [0, 3000], f + '.offset'),
    width: num(o.width, [1, 3000], f + '.width'), height: num(o.height, [1, 3000], f + '.height')
  };
  if (kind === 'window') out.sill = num(o.sill, [0, 3000], f + '.sill', 0);
  else out.hinge = o.hinge === 'end' ? 'end' : 'start';
  return out;
}

function obstacle(o, f) {
  obj(o, f);
  return {
    kind: str(o.kind, 20, f + '.kind', true),
    x: num(o.x, COORD, f + '.x'), y: num(o.y, COORD, f + '.y'),
    w: num(o.w, [1, 3000], f + '.w'), d: num(o.d, [1, 3000], f + '.d'),
    h: num(o.h, [1, 3000], f + '.h'), elev: num(o.elev, [0, 3000], f + '.elev', 0)
  };
}

// Place of a room on the apartment plan (cm); optional for old single-room orders.
const PLAN = [-10000, 100000];
function pos(p, f) {
  if (p == null) return undefined;
  obj(p, f);
  return { x: num(p.x, PLAN, f + '.x'), y: num(p.y, PLAN, f + '.y') };
}

function roomDoc(r, f) {
  obj(r, f);
  const at = pos(r.pos, f + '.pos');
  return {
    name: str(r.name, 60, f + '.name'), purpose: str(r.purpose, 30, f + '.purpose'),
    ...(at ? { pos: at } : {}),
    room: room(r.room, f + '.room'),
    openings: list(r.openings, LIMITS.openings, f + '.openings').map((o, i) => opening(o, `${f}.openings[${i}]`)),
    obstacles: list(r.obstacles, LIMITS.obstacles, f + '.obstacles').map((o, i) => obstacle(o, `${f}.obstacles[${i}]`)),
    items: list(r.items, LIMITS.items, f + '.items').map((it, i) => item(it, `${f}.items[${i}]`)),
    estimate: r.estimate == null ? null : num(r.estimate, [0, 1e13], f + '.estimate')
  };
}

// dataURL of the given type ('png' | 'jpeg') → Buffer, checked by size and signature.
function picture(v, type, field) {
  if (v == null || v === '') return null;
  const m = typeof v === 'string' && v.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || m[1] !== type || m[2].length * 0.75 > LIMITS.picture + 3) throw new Invalid(field);
  const buf = Buffer.from(m[2], 'base64');
  const sig = type === 'png' ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : [0xff, 0xd8, 0xff];
  if (buf.length > LIMITS.picture || !sig.every((b, i) => buf[i] === b)) throw new Invalid(field);
  return buf;
}

// An apartment of the new-building showcase: { building, floor, apt (number) }.
function apartmentRef(v) {
  if (v == null) return null;
  obj(v, 'apartmentRef');
  const int = (x, max) => { if (!Number.isInteger(x) || x < 1 || x > max) throw new Invalid('apartmentRef'); return x; };
  if (typeof v.building !== 'string' || !/^[a-z0-9-]{1,60}$/.test(v.building)) throw new Invalid('apartmentRef');
  return { building: v.building, floor: int(v.floor, 200), apt: int(v.apt, 999999) };
}

function validateOrder(body) {
  try {
    obj(body, 'body');
    const phone = str(body.phone, 30, 'phone', true);
    if (!PHONE.test(phone)) throw new Invalid('phone');
    const order = {
      name: str(body.name, 100, 'name', true),
      phone,
      comment: str(body.comment, 1000, 'comment'),
      lang: LANGS.includes(body.lang) ? body.lang : 'ru',
      project: { name: str(body.project?.name, 100, 'project.name') },
      estimate: body.estimate == null ? null : num(body.estimate, [0, 1e13], 'estimate')
    };
    // A new-building apartment needs no furniture: the request is for the apartment itself.
    const ref = apartmentRef(body.apartmentRef);
    if (ref) order.apartmentRef = ref;
    // An apartment: rooms[] with pos. Old clients send one room in the top-level fields (and optionally rooms[]).
    const rooms = list(body.rooms, LIMITS.rooms, 'rooms').map((r, i) => roomDoc(r, `rooms[${i}]`));
    let all = rooms;
    if (body.room != null || (!rooms.length && !ref)) {
      const main = roomDoc({ ...body, name: body.roomName }, 'room');
      Object.assign(order, { roomName: main.name, purpose: main.purpose, room: main.room,
        openings: main.openings, obstacles: main.obstacles, items: main.items });
      all = [main, ...rooms];
    }
    if (rooms.length) order.rooms = rooms;
    if (!ref && !all.some(r => r.items.length)) throw new Invalid('items');
    const files = [['plan.png', picture(body.drawing, 'png', 'drawing')], ['3d.jpg', picture(body.snapshot3d, 'jpeg', 'snapshot3d')]]
      .filter(([, buf]) => buf);
    return { ok: true, order, files };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: 'invalid_order', field: e.field };
    throw e;
  }
}

export { validateOrder, LIMITS, PHONE };
