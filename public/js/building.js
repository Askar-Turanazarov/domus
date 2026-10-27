// A 12-storey new building, generated from a seed (pure, deterministic). All values in cm.
// One section: a central corridor along the building, apartments on both sides, a core (lifts, stairs, shafts)
// in the middle of the south side. Floor 1 is a lobby with commercial units, floors 2–12 are apartments.
//
// Floor plan coordinates: x along the facade (west → east), y from the north facade (north → south).
//   y 0 … DEPTH                  north apartments (windows on the north facade)
//   CORR_Y … CORR_Y + CORR_W     corridor
//   SOUTH_Y … SOUTH_Y + DEPTH    south apartments (windows on the south facade), the core in the middle
//
// An apartment unit is a strip from the facade to the corridor (width w along the facade):
//   front row (facade):   living rooms and the kitchen(-living room), each with a window
//   hall strip:           a hallway along the whole width, every front room opens into it
//   back row (corridor):  entry with the front door, bathroom, WC, storage — wet zones stay by the corridor
// Rooms of a unit are in unit coordinates (facade at y = 0); `at` places the unit on the floor, `flip` mirrors
// a south unit (its facade is at the bottom).
import { normalizeRoom } from './storage.js';
import { apartmentArea } from './apartment.js';
import { furnishRooms } from './aptTemplates.js';
import { rng } from './furnish.js';

export const SECTION = 3600;                  // inner length of the section
export const DEPTH = 780;                     // unit depth, facade → corridor
export const UNIT_GAP = 20;                   // wall between two apartments
export const CORR_W = 160;
export const CORR_Y = DEPTH + UNIT_GAP;
export const SOUTH_Y = CORR_Y + CORR_W + UNIT_GAP;
export const SECTION_W = SOUTH_Y + DEPTH;
export const CORE = { x: 1550, y: SOUTH_Y, w: 500, h: DEPTH };   // 2 lifts, stairs, shafts
export const H = 280, P = 10;
const FRONT = 430, STRIP = 130, BACK = DEPTH - FRONT - STRIP - 2 * P;   // 200

// Unit types: width range along the facade and the front rooms (min widths, the last one takes the rest).
export const TYPES = {
  studio: { rooms: 0, w: [380, 460], front: [['kitchenLiving', 380]] },
  euro1: { rooms: 1, w: [600, 680], front: [['bedroom', 260], ['kitchenLiving', 330]] },
  two: { rooms: 2, w: [920, 1000], front: [['bedroom', 280], ['living', 380], ['kitchen', 240]] },
  three: { rooms: 3, w: [980, 1100], front: [['bedroom', 290], ['kids', 260], ['kitchenLiving', 400]] },
  four: { rooms: 4, w: [1260, 1360], front: [['bedroom', 290], ['kids', 260], ['bedroom', 260], ['kitchenLiving', 420]] }
};
const MIDDLE = ['studio', 'euro1', 'euro1', 'two', 'two', 'two'];
const CORNER = ['three', 'three', 'four', 'two', 'euro1'];   // end units get a window on the end wall

const NAMES = {
  hall: ['Холл', 'Dahliz', 'Hallway'], entry: ['Прихожая', 'Kirish', 'Entry'],
  living: ['Гостиная', 'Mehmonxona', 'Living room'], bedroom: ['Спальня', 'Yotoqxona', 'Bedroom'],
  kids: ['Детская', 'Bolalar xonasi', 'Kids room'], kitchen: ['Кухня', 'Oshxona', 'Kitchen'],
  kitchenLiving: ['Кухня-гостиная', 'Oshxona-mehmonxona', 'Kitchen-living room'],
  bathroom: ['Ванная', 'Hammom', 'Bathroom'], wc: ['Туалет', 'Hojatxona', 'WC'], other: ['Кладовая', 'Omborxona', 'Storage']
};
const LANGS = ['ru', 'uz', 'en'];

// A generated room name (the plan keeps the Russian one) in another language.
export function localRoomName(name, lang) {
  const [, base, n = ''] = String(name).match(/^(.*?)( \d+)?$/);   // "Спальня 2" → "Bedroom 2"
  const i = LANGS.indexOf(lang), e = Object.values(NAMES).find(x => x[0] === base);
  return e && i >= 0 ? e[i] + n : name;
}

/**
 * Fill a band of `len` with units: corner types at the ends marked in `corners` ([west, east]: a type, true — random, false),
 * middle types in between; widths are stretched so the band is filled exactly. → [{ type, w }] or null.
 */
export function fillBand(len, corners, rand) {
  for (let tries = 0; tries < 200; tries++) {
    const ends = corners.map(c => (typeof c === 'string' ? c : c ? CORNER[Math.floor(rand() * CORNER.length)] : null));
    const list = [];
    if (ends[0]) list.push(ends[0]);
    const tail = ends[1] ? [ends[1]] : [];
    const min = types => types.reduce((s, t) => s + TYPES[t].w[0], 0) + (types.length - 1) * UNIT_GAP;
    while (min([...list, ...tail]) < len) {
      const t = MIDDLE[Math.floor(rand() * MIDDLE.length)];
      if (min([...list, t, ...tail]) > len) break;
      list.push(t);
    }
    list.push(...tail);
    const lo = min(list), hi = list.reduce((s, t) => s + TYPES[t].w[1], 0) + (list.length - 1) * UNIT_GAP;
    if (!list.length || lo > len || hi < len) continue;
    // stretch: the same share of every unit's slack, rounded to 10 cm, the rest to the first unit that can take it
    const k = (len - lo) / (hi - lo);
    const ws = list.map(t => TYPES[t].w[0] + Math.floor(k * (TYPES[t].w[1] - TYPES[t].w[0]) / 10) * 10);
    let rest = len - ws.reduce((s, w) => s + w, 0) - (list.length - 1) * UNIT_GAP;
    for (let i = 0; i < ws.length && rest > 0; i++) {
      const add = Math.min(rest, TYPES[list[i]].w[1] - ws[i]);
      ws[i] += add;
      rest -= add;
    }
    if (rest === 0) return list.map((type, i) => ({ type, w: ws[i] }));
  }
  return null;
}

/**
 * Rooms of one unit in unit coordinates (facade at y = 0, corridor at y = DEPTH).
 * endWall: 'west' | 'east' | null — a corner unit gets a second window on that end wall.
 * → [{ key, purpose, name, pos, room, openings }]
 */
export function unitRooms(type, w, endWall = null) {
  const T = TYPES[type];
  const rooms = [];
  const add = (key, purpose, x, y, L, W, n) => {
    const nm = NAMES[purpose === 'bathroom' && key === 'wc' ? 'wc' : key === 'entry' ? 'entry' : purpose];
    const name = Object.fromEntries(LANGS.map((l, i) => [l, n ? `${nm[i]} ${n}` : nm[i]]));
    const r = { key, purpose, name, pos: { x, y }, room: { L, W, H }, openings: [] };
    rooms.push(r);
    return r;
  };
  const open = (r, o) => r.openings.push({ id: r.openings.length + 1, ...o });

  // front row: the kitchen-living room goes to the end wall of a corner unit
  let front = T.front.map(([purpose, min]) => ({ purpose, min }));
  if (endWall === 'west') front = front.reverse();
  const fixed = front.reduce((s, f) => s + f.min, 0) + (front.length - 1) * P;
  const big = front.findIndex(f => f.purpose === 'kitchenLiving' || f.purpose === 'living');
  front[big].min += w - fixed;
  let x = 0, beds = 0;
  for (const f of front) {
    const n = f.purpose === 'bedroom' ? ++beds : 0;
    const r = add('f' + rooms.length, f.purpose, x, 0, f.min, FRONT, n > 1 ? n : 0);
    const ww = Math.min(170, Math.round(f.min * 0.5 / 10) * 10);
    open(r, { kind: 'window', wall: 'north', offset: Math.round((f.min - ww) / 2), width: ww, sill: 70, height: 170 });
    if ((endWall === 'west' && x === 0) || (endWall === 'east' && x + f.min === w)) {
      open(r, { kind: 'window', wall: endWall, offset: Math.round((FRONT - 150) / 2), width: 150, sill: 70, height: 170 });
    }
    open(r, { kind: 'door', wall: 'south', offset: f.min > 300 ? 30 : 15, width: 80, height: 210, hinge: 'start' });
    x += f.min + P;
  }

  // hall strip along the whole width
  const hall = add('hall', 'hall', 0, FRONT + P, w, STRIP);
  // back row: bathroom, WC (2+ rooms), the entry 170–240 wide; what is left widens the bathroom,
  // then becomes a second bathroom (3+ rooms) and a storage room, the rest goes to the entry
  const back = [['bath', 'bathroom', 200]];
  if (T.rooms >= 2) back.push(['wc', 'bathroom', 110]);
  const rest = w - back.reduce((s, b) => s + b[2] + P, 0);
  let entryW = Math.min(240, rest);
  let extra = rest - entryW;
  const grow = Math.min(extra, 80);
  back[0][2] += grow;
  extra -= grow;
  if (T.rooms >= 3 && extra >= 210) { back.push(['bath2', 'bathroom', 200]); extra -= 210; }
  if (extra >= 110) { const s = Math.min(250, extra - P); back.push(['store', 'other', s]); extra -= s + P; }
  entryW += extra;
  const y = FRONT + STRIP + 2 * P;
  const order = endWall === 'east' ? [...back, ['entry', 'hall', entryW]] : [['entry', 'hall', entryW], ...back];
  x = 0;
  for (const [key, purpose, bw] of order) {
    const r = add(key, purpose, x, y, bw, BACK, key === 'bath2' ? 2 : 0);
    if (key === 'entry') {
      open(r, { kind: 'door', wall: 'south', offset: Math.round((bw - 90) / 2), width: 90, height: 210, hinge: 'start' });
      open(hall, { kind: 'door', wall: 'south', offset: x + Math.round((bw - 80) / 2), width: 80, height: 210, hinge: 'start' });
    } else {
      const dw = 70;
      open(hall, { kind: 'door', wall: 'south', offset: x + Math.round((bw - dw) / 2), width: dw, height: 210, hinge: 'end' });
    }
    x += bw + P;
  }
  return rooms;
}

// Mirror a unit for the south side: its facade goes to the bottom.
const FLIP = { north: 'south', south: 'north', west: 'west', east: 'east' };
export function flipRooms(rooms) {
  return rooms.map(r => ({
    ...r, pos: { x: r.pos.x, y: DEPTH - r.pos.y - r.room.W },
    openings: r.openings.map(o => ({ ...o, wall: FLIP[o.wall] }))
  }));
}

const roomDoc = (no, r, i, lang = 'ru') => normalizeRoom({
  id: `${no}-${i + 1}`, name: r.name[lang], purpose: r.purpose, pos: r.pos, room: { ...r.room, plinth: 2 },
  openings: r.openings
});

/**
 * The building: { id, name, floors, section, core, corridor, pricePerM2, floorsData: [{ n, lobby?, commercial?, apartments }] }.
 * apartment = { no, floor, type, rooms (count), area, price, status, corner, side, at: {x, y}, w, flip, plan: [roomDoc] }.
 */
export function generateBuilding({ id = 'chinor-park', seed = 12, floors = 12, pricePerM2 = 12_000_000, catalog = [], furnished = true } = {}) {
  const rand = rng(seed);
  const settings = { snap: 5, gap: 3, grid: 10, showZones: 'selected', minPassage: 60, showPassages: true };
  // three floor patterns; every floor takes one of them, so wet zones repeat over several floors
  const patterns = [];
  for (let k = 0; k < 3; k++) {
    patterns.push({
      north: fillBand(SECTION, k % 2 ? [true, 'four'] : ['four', true], rand),
      southW: fillBand(CORE.x - UNIT_GAP, [true, false], rand),
      southE: fillBand(SECTION - CORE.x - CORE.w - UNIT_GAP, [false, true], rand)
    });
  }
  const floorsData = [{
    n: 1, lobby: { x: CORE.x - 300, y: 0, w: CORE.w + 600, h: SECTION_W },
    commercial: [
      { x: 0, y: 0, w: CORE.x - 300 - UNIT_GAP, h: SECTION_W },
      { x: CORE.x + CORE.w + 300 + UNIT_GAP, y: 0, w: SECTION - CORE.x - CORE.w - 300 - UNIT_GAP, h: SECTION_W }
    ],
    apartments: []
  }];
  let no = 0;
  for (let n = 2; n <= floors; n++) {
    const pat = patterns[Math.floor(rand() * patterns.length)];
    const apartments = [];
    const place = (band, x0, side) => {
      let x = x0;
      band.forEach((u, i) => {
        const end = side === 'north'
          ? (i === 0 ? 'west' : i === band.length - 1 ? 'east' : null)
          : (x0 === 0 && i === 0 ? 'west' : x0 > 0 && i === band.length - 1 ? 'east' : null);
        let plan = unitRooms(u.type, u.w, end);
        if (side === 'south') plan = flipRooms(plan);
        no++;
        const rooms = plan.map((r, k) => roomDoc(no, r, k));
        if (furnished) furnishRooms({ rooms, settings, catalog }, { seed: seed * 1000 + no, catalog });
        const area = apartmentArea(rooms);
        const corner = !!end;
        const price = Math.round(area * pricePerM2 * (1 + 0.01 * (n - 2)) * (corner ? 1.03 : 1) / 1e5) * 1e5;
        const r = rand();
        apartments.push({
          no, floor: n, type: u.type, rooms: TYPES[u.type].rooms, area, price,
          status: r < 0.6 ? 'free' : r < 0.75 ? 'booked' : 'sold', corner, side,
          at: { x, y: side === 'north' ? 0 : SOUTH_Y }, w: u.w, plan: rooms
        });
        x += u.w + UNIT_GAP;
      });
    };
    place(pat.north, 0, 'north');
    place(pat.southW, 0, 'south');
    place(pat.southE, CORE.x + CORE.w + UNIT_GAP, 'south');
    floorsData.push({ n, apartments });
  }
  return {
    id, name: { ru: 'ЖК «Chinor Park»', uz: '«Chinor Park» TJM', en: '“Chinor Park” residential' },
    floors, seed, pricePerM2,
    section: { L: SECTION, W: SECTION_W, H },
    core: CORE, corridor: { x: 0, y: CORR_Y, w: SECTION, h: CORR_W },
    // the plot around the house, cm: street on the south (the entrance side), parking on the east
    site: { L: 9000, W: 7600, road: 'south', parking: 'east', trees: 40 },
    floorsData
  };
}
