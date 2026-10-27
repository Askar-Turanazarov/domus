// New-building data for the showcase: generated buildings (buildings/<id>.json, the plans), the apartment list
// (apartments.json: rooms, area, price, status) and the manager's apartment statuses on top
// (server/db.js: { [building id]: { [apartment no]: 'free' | 'booked' | 'sold' } }).
import fs from 'node:fs/promises';
import path from 'node:path';

const APT_STATUSES = ['free', 'booked', 'sold'];
const BUILDING_ID = /^[a-z0-9-]{1,60}$/;

// Statuses changed by the manager win over the generated ones. Pure: changes and returns `b`.
function applyStatuses(b, overrides) {
  const own = (overrides && overrides[b.id]) || {};
  for (const f of b.floorsData) {
    for (const a of f.apartments) if (APT_STATUSES.includes(own[a.no])) a.status = own[a.no];
  }
  return b;
}

// The apartment list wins over the generated values; an entry applies only on its own floor of the plan. Pure: changes and returns `b`.
const LISTED = ['rooms', 'area', 'price', 'status'];
function applyListing(b, listing) {
  const own = new Map((listing || []).filter(x => x && x.building === b.id).map(x => [x.no, x]));
  for (const f of b.floorsData) {
    for (const a of f.apartments) {
      const x = own.get(a.no);
      if (!x || x.floor !== a.floor) continue;
      for (const k of LISTED) if (k === 'status' ? APT_STATUSES.includes(x.status) : Number.isFinite(x[k]) && x[k] >= 0) a[k] = x[k];
    }
  }
  return b;
}

const findApartment = (b, no) => b.floorsData.flatMap(f => f.apartments).find(a => a.no === no) || null;

// dir — the buildings folder, statusStore — { read() → all statuses, set(building, apt, status) } (server/db.js),
// listFile — apartments.json ({ apartments: [{ building, no, floor, rooms, area, price, status }] }).
function createBuildings(dir, statusStore, listFile) {
  async function raw(id) {
    if (!BUILDING_ID.test(id)) return null;
    try { return JSON.parse(await fs.readFile(path.join(dir, id + '.json'), 'utf8')); } catch { return null; }
  }
  async function get(id) {
    const b = await raw(id);
    return b && applyStatuses(applyListing(b, await listing()), await statusStore.read());
  }
  async function listing() {
    if (!listFile) return [];
    try { return JSON.parse(await fs.readFile(listFile, 'utf8')).apartments || []; } catch { return []; }
  }
  async function list() {
    let files = [];
    try { files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')); } catch { /* no folder */ }
    const all = await Promise.all(files.map(f => raw(f.slice(0, -5))));
    return all.filter(Boolean).map(b => ({ id: b.id, name: b.name, floors: b.floors,
      apartments: b.floorsData.reduce((s, x) => s + x.apartments.length, 0) }));
  }
  // → { no, status } | null when the building or the apartment does not exist.
  async function setStatus(id, no, status) {
    const b = await raw(id);
    if (!b || !findApartment(b, no)) return null;
    await statusStore.set(id, no, status);
    return { no, status };
  }
  return { get, list, setStatus, apartment: async (id, no) => { const b = await get(id); return b && findApartment(b, no); } };
}

export { APT_STATUSES, BUILDING_ID, applyListing, applyStatuses, findApartment, createBuildings };
