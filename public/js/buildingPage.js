// New-building showcase (/building.html?b=<id>): floors with free/booked/sold counts, filters, a floor plan coloured
// by status or rooms with a tooltip, the apartment card (plan with sizes, rooms, price), "Open in the planner"
// (a copy in this browser's projects) and a request for the apartment (POST /api/order with apartmentRef).
// The main view is the building in 3D (bld3d/exterior.js); the floor grid stays as a scheme and without WebGL.
import { t, getLang, langPath, initLangSwitcher, onLangChange } from './i18n.js';
import { initIcons } from './icons.js';
import { roomRect, roomArea } from './apartment.js';
import { rectOf } from './geometry.js';
import { DEPTH, TYPES, localRoomName } from './building.js';
import { FILE_FORMAT, VERSION } from './storage.js';
import { photoAuto } from './3d/perf.js';
import { initTheme, getTheme, onThemeChange } from './theme.js';
import { groupNum, phone as fmtPhone, linkParts, hhmm } from './bkFormat.js';
import { createLiveStatus, recolorCells } from './liveStatus.js';

const $ = id => document.getElementById(id);
const BUILDING = new URLSearchParams(location.search).get('b') || 'chinor-park';
export const HANDOFF = 'fsp3d.handoff';
const STATUSES = ['free', 'held', 'booked', 'sold'];
// Floor-plan colours per theme: muted statuses (sage / champagne / graphite) and room-count tints.
const PALETTE = {
  dark: {
    st: { free: '#4f6f5a', held: '#a8702a', booked: '#8a7448', sold: '#34332f' },
    rooms: ['#4b4458', '#3e4c5a', '#3d5650', '#5a5240', '#584450'],
    floor: '#16161a', lobby: '#1d2428', shop: '#26221b', shopLine: '#4a463f', corridor: '#1f1f22', core: '#2c2b29',
    wall: '#d9cfbd', outer: '#ece6db', hover: '#e3c995', text: '#ece6db', textOff: '#7a756c', sub: '#b8b0a3',
    room: '#1d1c1a', item: 'rgba(236,230,219,.1)', decor: 'rgba(236,230,219,.05)', itemLine: 'rgba(236,230,219,.4)',
    gap: '#141416', label: 'rgba(20,20,22,.82)'
  },
  light: {
    st: { free: '#bcd3c1', held: '#f0c17f', booked: '#e6d2ac', sold: '#dcd6cc' },
    rooms: ['#ddd6e6', '#d3dfe8', '#d1e4dc', '#ece2c6', '#ead6dd'],
    floor: '#f6f2ec', lobby: '#e6eef0', shop: '#f3e9d9', shopLine: '#b9ad9a', corridor: '#ebe5dc', core: '#d6cec2',
    wall: '#3a332a', outer: '#17140f', hover: '#8c6a43', text: '#17140f', textOff: '#9a9184', sub: '#5f574c',
    room: '#fffdf9', item: 'rgba(60,50,35,.12)', decor: 'rgba(60,50,35,.06)', itemLine: 'rgba(60,50,35,.5)',
    gap: '#fbf9f5', label: 'rgba(255,253,249,.85)'
  }
};
const C = () => PALETTE[getTheme()];
const ST_FILL = new Proxy({}, { get: (_, k) => C().st[k] });
const ROOMS_FILL = new Proxy([], { get: (_, k) => C().rooms[k] });
const LOCALE = { ru: 'ru-RU', uz: 'uz-UZ', en: 'en-GB' };
const ROOM_COUNTS = [...new Set(Object.values(TYPES).map(x => x.rooms))].sort();

let b = null, floorN = 2, colorBy = 'status', hover = null, cardApt = null, view = null;
let live = null, mine = {};       // the status poll and the holds of this visitor ({ aptNo: { link, expiresAt } })
let ext = null, hover3d = null;   // the 3D facade and the apartment under the mouse there
let tint3d = false;               // windows framed in the colour of status / rooms, or plain glass (remembered)
const filter = { rooms: new Set(), areaMin: null, areaMax: null, priceMax: null, free: false };
try { colorBy = localStorage.getItem('fsp3d.bldColor') === 'rooms' ? 'rooms' : 'status'; } catch { /* ignore */ }
try { tint3d = localStorage.getItem('fsp3d.bldTint') === '1'; } catch { /* ignore */ }

const num = (v, d = 1) => new Intl.NumberFormat(LOCALE[getLang()] || 'en-GB', { maximumFractionDigits: d }).format(v);
const sum = v => `${String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ${t('unit.sum')}`;
const local = o => o?.[getLang()] || o?.ru || '';
const typeName = a => t('bld.type.' + a.type);
const allApts = () => b.floorsData.flatMap(f => f.apartments);
const byNo = no => allApts().find(a => a.no === no);
const floorOf = n => b.floorsData.find(f => f.n === n);
const matches = a => (!filter.rooms.size || filter.rooms.has(a.rooms))
  && (filter.areaMin == null || a.area >= filter.areaMin) && (filter.areaMax == null || a.area <= filter.areaMax)
  && (filter.priceMax == null || a.price <= filter.priceMax * 1e6) && (!filter.free || a.status === 'free');
const fillOf = a => (colorBy === 'status' ? ST_FILL[a.status] : ROOMS_FILL[a.rooms]);
const tintOf = a => (colorBy === 'status' ? PALETTE.light.st[a.status] : PALETTE.light.rooms[a.rooms]);   // the 3D facade keeps light tints

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter(k => k != null && k !== false));
  return e;
}

let toastTimer;
function toast(text, isError = false) {
  const box = $('toast');
  box.textContent = text;
  box.className = 'toast' + (isError ? ' error' : '');
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, isError ? 5000 : 3500);
}

// ---------- filters ----------
function renderFilters() {
  $('fRooms').replaceChildren(el('button', { type: 'button', className: filter.rooms.size ? '' : 'active', textContent: t('bld.all'),
    onclick: () => { filter.rooms.clear(); renderAll(); } }),
  ...ROOM_COUNTS.map(n => el('button', { type: 'button', className: filter.rooms.has(n) ? 'active' : '',
    textContent: n ? String(n) : t('bld.type.studio'),
    onclick: () => { filter.rooms.has(n) ? filter.rooms.delete(n) : filter.rooms.add(n); renderAll(); } })));
  const list = allApts().filter(matches);
  $('fFound').textContent = t('bld.found', { n: list.length });
}

function readFilters() {
  const v = id => { const x = parseFloat($(id).value); return Number.isFinite(x) ? x : null; };
  filter.areaMin = v('fAreaMin');
  filter.areaMax = v('fAreaMax');
  filter.priceMax = v('fPrice');
  filter.free = $('fFree').checked;
  renderAll();
}

// ---------- facade: one row per floor, a cell per apartment (north band, then south) ----------
function renderFacade() {
  $('bldFacade').replaceChildren(...[...b.floorsData].reverse().map(f => {
    const row = el('div', { className: 'bld-floor' + (f.n === floorN ? ' active' : ''), role: 'button', tabIndex: 0 });
    row.dataset.floor = f.n;
    const cells = el('span', { className: 'bld-cells' });
    if (!f.apartments.length) cells.append(el('span', { className: 'bld-lobby', textContent: t('bld.lobbyFloor') }));
    for (const side of ['north', 'south']) {
      const band = el('span', { className: 'bld-band' });
      for (const a of f.apartments.filter(x => x.side === side)) {
        const c = el('span', { className: `bld-cell st-${a.status}` + (matches(a) ? '' : ' dim'),
          title: `№${a.no} · ${typeName(a)} · ${num(a.area)} ${t('unit.m2')} · ${t('bld.st.' + a.status)}` });
        c.style.flexGrow = a.w;
        c.dataset.apt = a.no;
        band.append(c);
      }
      if (band.childElementCount) cells.append(band);
    }
    row.append(el('span', { className: 'bld-fl-n', textContent: f.n }), cells,
      el('span', { className: 'bld-cnt', textContent: countsText(f) }));
    return row;
  }));
}

function countsText(f) {
  const fit = f.apartments.filter(matches);
  return f.apartments.length ? t('bld.counts', Object.fromEntries(STATUSES.map(s => [s, fit.filter(a => a.status === s).length]))) : '';
}

function legend() {
  const item = (fill, text) => el('span', {}, el('i', { style: `background:${fill}` }), text);
  $('bldLegendSt').replaceChildren(...STATUSES.map(s => item(ST_FILL[s], t('bld.st.' + s))));
  $('bldLegend').replaceChildren(...(colorBy === 'status'
    ? STATUSES.map(s => item(ST_FILL[s], t('bld.st.' + s)))
    : ROOM_COUNTS.map(n => item(ROOMS_FILL[n], n ? t('bld.nRooms', { n }) : t('bld.type.studio')))));
}

// ---------- drawing ----------
// Rooms of an apartment at `at` (cm on the floor) with walls, windows and doors; s — px per cm, (ox, oy) — px offset.
function drawRooms(g, plan, at, s, ox, oy, { fill = C().room, wall = C().wall, lw = 1, furniture = false } = {}) {
  const box = r => { const q = roomRect(r); return [ox + (at.x + q.x) * s, oy + (at.y + q.y) * s, q.w * s, q.h * s]; };
  for (const r of plan) {
    g.fillStyle = typeof fill === 'function' ? fill(r) : fill;
    g.fillRect(...box(r));
  }
  if (furniture) {
    for (const r of plan) {
      const [x0, y0] = box(r);
      for (const it of r.items || []) {
        const q = rectOf(it);
        g.fillStyle = it.layer === 'decor' ? C().decor : C().item;
        g.strokeStyle = C().itemLine;
        g.lineWidth = 0.75;
        g.fillRect(x0 + q.x * s, y0 + q.y * s, q.w * s, q.h * s);
        g.strokeRect(x0 + q.x * s, y0 + q.y * s, q.w * s, q.h * s);
      }
    }
  }
  g.strokeStyle = wall;
  g.lineWidth = lw;
  for (const r of plan) g.strokeRect(...box(r));
  for (const r of plan) {
    const [x, y, w, h] = box(r);
    for (const o of r.openings) {
      const p = o.offset * s, q = (o.offset + o.width) * s;
      const seg = { north: [p, 0, q, 0], south: [p, h, q, h], west: [0, p, 0, q], east: [w, p, w, q] }[o.wall];
      g.beginPath();
      g.moveTo(x + seg[0], y + seg[1]);
      g.lineTo(x + seg[2], y + seg[3]);
      g.strokeStyle = o.kind === 'window' ? '#7fb8d8' : C().gap;
      g.lineWidth = o.kind === 'window' ? lw + 2 : lw + 1.5;
      g.stroke();
    }
  }
}

function sizeCanvas(cv, cw, ch) {
  const dpr = window.devicePixelRatio || 1;
  cv.style.height = ch + 'px';
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

function label(g, text, x, y, { size = 12, color = C().text, bold = false } = {}) {
  g.font = `${bold ? 600 : 400} ${size}px Manrope, system-ui, sans-serif`;
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x, y);
}

// Bounding box of an apartment on the floor (cm): its strip from the facade to the corridor.
const unitBox = a => ({ x: a.at.x, y: a.at.y, w: a.w, h: DEPTH });

function drawFloor() {
  const cv = $('bldPlan'), f = floorOf(floorN);
  // not narrower than 640 px: on a phone the plan scrolls sideways instead of shrinking to unreadable labels
  const cw = Math.max(cv.parentElement.clientWidth || 600, 640), pad = 14;
  const s = (cw - 2 * pad) / b.section.L;
  const g = sizeCanvas(cv, cw, Math.round(b.section.W * s + 2 * pad));
  view = { s, ox: pad, oy: pad };
  const R = q => [pad + q.x * s, pad + q.y * s, q.w * s, q.h * s];
  g.clearRect(0, 0, cw, cv.height);
  g.fillStyle = C().floor;
  g.fillRect(...R({ x: 0, y: 0, w: b.section.L, h: b.section.W }));
  const small = Math.max(10, Math.min(13, s * 40));
  if (f.lobby) {
    g.fillStyle = C().lobby;
    g.fillRect(...R(f.lobby));
    const [x, y, w, h] = R(f.lobby);
    label(g, t('bld.lobby'), x + w / 2, y + h / 2, { size: small + 2, bold: true });
    for (const c of f.commercial) {
      g.fillStyle = C().shop;
      g.fillRect(...R(c));
      g.strokeStyle = C().shopLine;
      g.strokeRect(...R(c));
      const [cx, cy, cw2, ch2] = R(c);
      label(g, t('bld.commercial'), cx + cw2 / 2, cy + ch2 / 2, { size: small + 1 });
    }
  } else {
    g.fillStyle = C().corridor;
    g.fillRect(...R(b.corridor));
    const [x, y, w, h] = R(b.corridor);
    label(g, t('bld.corridor'), x + w * 0.25, y + h / 2, { size: small, color: C().textOff });
    label(g, t('bld.corridor'), x + w * 0.75, y + h / 2, { size: small, color: C().textOff });
  }
  g.fillStyle = C().core;
  g.fillRect(...R(b.core));
  const [kx, ky, kw, kh] = R(b.core);
  label(g, t('bld.core'), kx + kw / 2, ky + kh / 2, { size: small, color: C().sub });
  for (const a of f.apartments) {
    const on = matches(a);
    const [x, y, w, h] = R(unitBox(a));
    // the apartment outline first: windows and the front door are drawn over it
    g.strokeStyle = C().wall;
    g.lineWidth = 2;
    g.strokeRect(x, y, w, h);
    g.save();
    g.globalAlpha = on ? 1 : 0.3;
    drawRooms(g, a.plan, a.at, s, pad, pad, { fill: fillOf(a), lw: 1 });
    g.restore();
    if (a.no === hover) {
      g.strokeStyle = C().hover;
      g.lineWidth = 3;
      g.strokeRect(x - 1, y - 1, w + 2, h + 2);
    }
    const cy = y + h * (a.side === 'north' ? 0.3 : 0.7);
    label(g, `№${a.no}`, x + w / 2, cy - small * 0.7, { size: small + 1, bold: true, color: on ? C().text : C().textOff });
    label(g, `${a.rooms ? a.rooms + t('bld.roomsShort') : t('bld.type.studio')} · ${num(a.area)} ${t('unit.m2')}`,
      x + w / 2, cy + small * 0.6, { size: small - 1, color: on ? C().sub : C().textOff });
  }
  // outer walls (outside the facade line, so the windows stay visible)
  g.strokeStyle = C().outer;
  g.lineWidth = 3;
  g.strokeRect(...R({ x: -6 - 1.5 / s, y: -6 - 1.5 / s, w: b.section.L + 12 + 3 / s, h: b.section.W + 12 + 3 / s }));
  $('floorTitle').textContent = t('bld.floor', { n: floorN });
  $('floorDown').disabled = floorN <= 1;
  $('floorUp').disabled = floorN >= b.floors;
}

function aptAt(e) {
  if (!view) return null;
  const r = $('bldPlan').getBoundingClientRect();
  const x = (e.clientX - r.left - view.ox) / view.s, y = (e.clientY - r.top - view.oy) / view.s;
  return floorOf(floorN).apartments.find(a => { const q = unitBox(a); return x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h; }) || null;
}

function showTip(a, e, wrapEl = $('planWrap'), tip = $('bldTip')) {
  if (!a) { tip.hidden = true; return; }
  tip.replaceChildren(
    el('b', { textContent: `№${a.no} · ${typeName(a)}` }),
    el('span', { textContent: `${num(a.area)} ${t('unit.m2')} · ${t('bld.floorShort', { n: a.floor })}` }),
    el('span', { textContent: sum(a.price) }),
    el('span', { className: 'bld-st st-' + a.status, textContent: t('bld.st.' + a.status) }));
  tip.hidden = false;
  const wrap = wrapEl.getBoundingClientRect();
  const sx = wrapEl.scrollLeft, x = e.clientX - wrap.left + sx + 14, y = e.clientY - wrap.top + 14;
  tip.style.left = Math.min(x, sx + wrap.width - tip.offsetWidth - 4) + 'px';
  tip.style.top = Math.min(y, wrap.height - tip.offsetHeight - 4) + 'px';
}

// ---------- apartment card ----------
function roomName(r) { return localRoomName(r.name, getLang()); }

function drawCard(a) {
  const cv = $('aptPlan');
  const rs = a.plan.map(roomRect);
  const x0 = Math.min(...rs.map(q => q.x)), y0 = Math.min(...rs.map(q => q.y));
  const L = Math.max(...rs.map(q => q.x + q.w)) - x0, W = Math.max(...rs.map(q => q.y + q.h)) - y0;
  const cw = cv.clientWidth || 420, pad = 18;
  const s = (cw - 2 * pad) / L;
  const g = sizeCanvas(cv, cw, Math.round(W * s + 2 * pad));
  g.clearRect(0, 0, cw, cv.height);
  const ox = pad - x0 * s, oy = pad - y0 * s;
  drawRooms(g, a.plan, { x: 0, y: 0 }, s, ox, oy, { fill: C().room, lw: 2, furniture: true });
  for (const r of a.plan) {
    const q = roomRect(r), cx = ox + (q.x + q.w / 2) * s, cy = oy + (q.y + q.h / 2) * s;
    const fs = q.w * s < 70 || q.h * s < 50 ? 9 : 11;
    g.fillStyle = C().label;
    const name = roomName(r), dims = `${num(r.room.L / 100, 2)}×${num(r.room.W / 100, 2)}`;
    g.font = `600 ${fs}px Manrope, system-ui, sans-serif`;
    const tw = Math.max(g.measureText(name).width, g.measureText(dims).width) + 6;
    g.fillRect(cx - tw / 2, cy - fs * 1.6, tw, fs * 3.4);
    label(g, name, cx, cy - fs * 0.8, { size: fs, bold: true });
    label(g, dims, cx, cy + fs * 0.25, { size: fs - 1, color: C().sub });
    label(g, `${num(roomArea(r))} ${t('unit.m2')}`, cx, cy + fs * 1.2, { size: fs - 1, color: C().sub });
  }
  // overall size of the apartment
  label(g, `${num(L / 100, 2)} ${t('bld.m')}`, pad + L * s / 2, pad / 2, { size: 11, color: C().sub });
}

function openCard(a) {
  cardApt = a;
  $('aptTitle').textContent = `${t('bld.apt', { no: a.no })} · ${typeName(a)}`;
  const dd = (k, v) => [el('dt', { textContent: t(k) }), el('dd', {}, v)];
  $('aptMeta').replaceChildren(
    ...dd('bld.status', el('span', { className: 'bld-st st-' + a.status, textContent: t('bld.st.' + a.status) })),
    ...dd('bld.floorLabel', `${a.floor} / ${b.floors}`),
    ...dd('bld.total', `${num(a.area)} ${t('unit.m2')}`),
    ...dd('bld.price', sum(a.price)),
    ...dd('bld.perM2', sum(a.price / a.area)),
    ...dd('bld.windows', [t('bld.side.' + a.side), a.corner && t('bld.corner')].filter(Boolean).join(', ')));
  $('aptRooms').replaceChildren(el('tbody', {}, ...a.plan.map(r => el('tr', {},
    el('td', { textContent: roomName(r) }),
    el('td', { className: 'num', textContent: `${num(r.room.L / 100, 2)} × ${num(r.room.W / 100, 2)}` }),
    el('td', { className: 'num', textContent: `${num(roomArea(r))} ${t('unit.m2')}` })))));
  syncCard(a);
  if (!$('aptDlg').open) $('aptDlg').showModal();
  requestAnimationFrame(() => drawCard(a));
}

// What depends on the status in the open card: the badge and the buttons. The visitor's own hold turns "Book" into
// "Continue to payment" (the link of the booking page).
function syncCard(a) {
  const badge = $('aptMeta').querySelector('.bld-st');
  if (badge) { badge.className = 'bld-st st-' + a.status; badge.textContent = t('bld.st.' + a.status); }
  const m = a.status === 'held' && mine[a.no];
  const link = m && /^\/b\/[\w-]+$/.test(m.link ?? '') ? m.link : null;
  $('aptBook').hidden = a.status !== 'free';
  $('aptContinue').hidden = !link;
  if (link) $('aptContinue').href = link;
  $('aptMine').hidden = !link;
  if (link) $('aptMine').textContent = t('bk.hold.mineUntil', { time: hhmm(m.expiresAt) });
  $('aptRequest').classList.toggle('primary', a.status !== 'free' && !link);
  $('aptRequest').disabled = a.status === 'sold';
  $('aptView').hidden = a.status === 'sold';
  $('aptAsk').hidden = document.documentElement.dataset.mode === 'mini' ? !document.documentElement.dataset.bot : !chat;
  $('aptRequest').title = a.status === 'sold' ? t('bld.soldNote') : '';
}

// A copy of the apartment for the planner: handed over through localStorage, the planner imports it on start.
function openInPlanner(a) {
  const lang = getLang();
  const project = {
    name: `${local(b.name)}, ${t('bld.apt', { no: a.no })}`,
    activeRoomId: (a.plan.find(r => r.purpose === 'kitchenLiving' || r.purpose === 'living') || a.plan[0]).id,
    rooms: a.plan.map(r => ({ ...structuredClone(r), name: localRoomName(r.name, lang) }))
  };
  try {
    localStorage.setItem(HANDOFF, JSON.stringify({ format: FILE_FORMAT, version: VERSION, project }));
  } catch {
    toast(t('storage.full'), true);
    return;
  }
  // At once: the button says the planner is opening, the facade stops drawing and loading, the page goes.
  const btn = $('aptPlanner'), was = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = t('bld.opening');
  ext?.pause(true);
  // Back from the planner (the page comes from the back-forward cache): the card works again.
  addEventListener('pageshow', e => {
    if (!e.persisted) return;
    btn.disabled = false;
    btn.innerHTML = was;
    ext?.pause(['aptDlg', 'floor3dDlg', 'reqDlg'].some(id => $(id).open));
  }, { once: true });
  location.assign(langPath('/planner'));
}

// From the street through the doors: a short fade, then the lobby in the floor dialog (the walker at the doors).
// The street walk ends first: the cursor and the keys belong to the dialog now.
let entering = false;
async function enterLobby() {
  if (entering || $('floor3dDlg').open) return;
  entering = true;
  const fade = Object.assign(document.createElement('div'), { className: 'fade3d' });
  $('bld3dView').append(fade);
  requestAnimationFrame(() => fade.classList.add('on'));
  await new Promise(r => setTimeout(r, 320));
  ext?.endWalk();
  sync3dHud();
  showFloor3d(`${t('bld.lobbyFloor')} · 3D`, `/index.html?embed=building&b=${encodeURIComponent(b.id)}&floor=1&from=street&lang=${getLang()}`, t('bld.entering'));
  fade.remove();
  entering = false;
}

// The floor in 3D: the planner's 3D view embedded (temporary project, nothing saved), walking from the entrance.
function open3d(a) {
  showFloor3d(`${t('bld.apt', { no: a.no })} · ${t('bld.floor', { n: a.floor })} · 3D`,
    `/index.html?embed=floor&b=${encodeURIComponent(b.id)}&apt=${a.no}&lang=${getLang()}`, t('bld.loading3d'));
}

// The dialog shows "loading" over the frame until the scene inside reports it is ready to walk.
function showFloor3d(title, src, note) {
  $('floor3dTitle').textContent = title;
  $('floor3dLoadText').textContent = note;
  $('floor3dLoad').hidden = false;
  $('floor3dFrame').src = src;
  $('floor3dDlg').showModal();
}

function openRequest(a) {
  $('reqTitle').textContent = t('bld.reqTitle', { no: a.no });
  $('reqDlg').showModal();
}

async function sendRequest(e) {
  e.preventDefault();
  const f = e.target.elements, a = cardApt;
  const body = {
    name: f.name.value, phone: f.phone.value, comment: f.comment.value, website: f.website.value, lang: getLang(),
    project: { name: `${local(b.name)}, ${t('bld.apt', { no: a.no })}` },
    apartmentRef: { building: b.id, floor: a.floor, apt: a.no }
  };
  try {
    const res = await fetch('/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) return toast(t('order.tooMany'), true);
    if (res.status === 400) return toast(t('order.invalid', { field: data.field || '?' }), true);
    if (!res.ok) throw new Error(res.status);
    $('reqDlg').close();
    e.target.reset();
    toast(t('bld.reqOk', { id: data.id }));
    live?.refresh();
  } catch {
    toast(t('order.fail'), true);
  }
}

// ---------- the hold (11 §7.1, 03 §4): the form over the card → POST /api/bookings/hold → the personal page ----------

let hold = null;   // { apt, key, openedAt, terms, busy } of the open form

// The Idempotency-Key is made when the form opens and stays through retries of a lost answer; a refusal gets a new one.
async function openHold(a) {
  hold = { apt: a, key: crypto.randomUUID(), openedAt: Date.now(), terms: null, busy: false };
  $('holdForm').reset();
  $('holdErr').textContent = '';
  renderHold();
  $('holdDlg').showModal();
  try {
    const res = await fetch('/api/apartments/status');
    if (!res.ok) throw new Error(res.status);
    hold.terms = (await res.json()).terms;
  } catch {
    $('holdErr').textContent = t('bk.hold.termsFail');
  }
  renderHold();
}

function renderHold() {
  if (!hold) return;
  const { apt, terms } = hold;
  $('holdTitle').textContent = t('bk.hold.title', { no: apt.no });
  $('holdSum').textContent = terms ? t('bk.hold.summary', { price: groupNum(apt.price), deposit: groupNum(terms.depositAmount) }) : '';
  $('holdNote').textContent = terms ? t('bk.hold.note', { min: terms.holdMinutes, deposit: groupNum(terms.depositAmount) }) : '';
  const words = (key, href) => linkParts(t(key)).map(p => (p.link
    ? el('a', { href: `${href}?lang=${getLang()}`, target: '_blank', rel: 'noopener noreferrer', textContent: p.text })
    : document.createTextNode(p.text)));
  $('holdOffer').replaceChildren(...words('bk.hold.offer', '/legal/offer'));
  $('holdPrivacy').replaceChildren(...words('bk.hold.privacy', '/legal/privacy'));
  $('holdGo').textContent = hold.busy ? t('bk.hold.sending') : t('bk.hold.submit');
  syncHold();
}

// The button waits for the terms, both ticks, a name and a phone (the server checks them all again).
function syncHold() {
  const f = $('holdForm').elements;
  $('holdGo').disabled = hold.busy || !hold.terms || !f.offer.checked || !f.privacy.checked
    || f.name.value.trim().length < 2 || f.phone.value.replace(/\D/g, '').length < 9;
}

async function sendHold(e) {
  e.preventDefault();
  if (!hold || hold.busy || $('holdGo').disabled) return;
  const f = e.target.elements, a = hold.apt;
  hold.busy = true;
  $('holdErr').textContent = '';
  renderHold();
  let res, data;
  try {
    res = await fetch('/api/bookings/hold', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': hold.key },
      body: JSON.stringify({ apartmentNo: a.no, name: f.name.value, phone: f.phone.value, lang: getLang(), website: f.website.value,
        consent: { version: hold.terms.offerVersion, privacy: true }, openedAt: new Date(hold.openedAt).toISOString() }) });
    data = await res.json().catch(() => ({}));
  } catch {
    hold.busy = false;
    $('holdErr').textContent = t('bk.hold.fail');   // no answer: the same key goes again, the server repeats its answer
    return renderHold();
  }
  if (res.status === 201 && /^\/b\/[\w-]+$/.test(data.link ?? '')) {
    location.assign(data.link);
    return;
  }
  hold.busy = false;
  hold.key = crypto.randomUUID();
  if (res.status === 409) live?.refresh();   // somebody was first: the showcase shows it
  $('holdErr').textContent = res.status === 429 ? t('bk.hold.tooMany')
    : ['apartment_held', 'apartment_not_free'].includes(data.error) ? t('bk.hold.taken') : (data.message || t('bk.hold.fail'));
  renderHold();
}

// ---------- the viewing (11 §7.2, J7): name, phone, a day of the nearest 14, a free 30-minute slot → POST /api/viewings ----------
// In the mini app the same requests go to /api/mini/viewings* (mini.js renames them and adds initData).

let vw = null;   // { apt, key, openedAt, at, busy, done } of the open form

const tashkentDay = (offset = 0) => new Date(Date.now() + 5 * 3600e3 + offset * 864e5).toISOString().slice(0, 10);

function openView(a) {
  vw = { apt: a, key: crypto.randomUUID(), openedAt: Date.now(), at: null, busy: false, done: false };
  $('viewForm').reset();
  const fmt = new Intl.DateTimeFormat(getLang() === 'uz' ? 'uz-Latn' : getLang(), { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' });
  $('viewDate').replaceChildren(...Array.from({ length: 14 }, (_, i) => {
    const d = tashkentDay(i);
    return el('option', { value: d, textContent: fmt.format(new Date(d + 'T00:00Z')) });
  }));
  $('viewFields').hidden = false;
  $('viewDone').hidden = true;
  $('viewErr').textContent = '';
  renderView();
  $('viewDlg').showModal();
  loadSlots();
}

function renderView() {
  if (!vw) return;
  $('viewTitle').textContent = t('vw.title', { no: vw.apt.no });
  $('viewGo').hidden = vw.done;
  $('viewGo').textContent = vw.busy ? t('vw.sending') : t('vw.submit');
  $('viewCancel').textContent = vw.done ? t('vw.close') : t('order.cancel');
  syncView();
}

function syncView() {
  const f = $('viewForm').elements;
  $('viewGo').disabled = vw.busy || !vw.at || f.name.value.trim().length < 2 || f.phone.value.replace(/\D/g, '').length < 9;
}

async function loadSlots() {
  const date = $('viewDate').value, no = vw.apt.no;
  vw.at = null;
  $('viewSlots').replaceChildren();
  syncView();
  let data;
  try {
    const res = await fetch(`/api/viewings/slots?no=${no}&date=${date}`);
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch {
    $('viewSlots').replaceChildren(el('p', { textContent: t('vw.slotsFail') }));
    return;
  }
  if (!vw || vw.apt.no !== no || $('viewDate').value !== date) return;
  const pick = (b, s) => {
    vw.at = `${date}T${s.at}`;
    for (const x of $('viewSlots').children) x.classList.toggle('on', x === b);
    syncView();
  };
  $('viewSlots').replaceChildren(...(data.slots.some(s => s.free) ? data.slots.map(s => {
    const b = el('button', { type: 'button', textContent: s.at, disabled: !s.free });
    b.addEventListener('click', () => pick(b, s));
    return b;
  }) : [el('p', { textContent: t('vw.noSlots') })]));
}

async function sendView(e) {
  e.preventDefault();
  if (!vw || vw.busy || vw.done || $('viewGo').disabled) return;
  const f = e.target.elements, a = vw.apt;
  vw.busy = true;
  $('viewErr').textContent = '';
  renderView();
  let res, data;
  try {
    res = await fetch('/api/viewings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': vw.key },
      body: JSON.stringify({ apartmentNo: a.no, at: vw.at, name: f.name.value, phone: f.phone.value, lang: getLang(), website: f.website.value,
        openedAt: new Date(vw.openedAt).toISOString() }) });
    data = await res.json().catch(() => ({}));
  } catch {
    vw.busy = false;
    $('viewErr').textContent = t('vw.fail');   // no answer: the same key goes again, the server repeats its answer
    return renderView();
  }
  vw.busy = false;
  if (res.status === 201 && data.viewing) {
    const [date, time] = String(data.viewing.local).split(' ');
    vw.done = true;
    $('viewFields').hidden = true;
    $('viewDone').hidden = false;
    $('viewDone').textContent = t('vw.done', { date: date.split('-').reverse().join('.'), time });
    return renderView();
  }
  vw.key = crypto.randomUUID();
  $('viewErr').textContent = res.status === 429 ? t('vw.tooMany') : data.error === 'slot_taken' ? t('vw.taken') : (data.message || t('vw.fail'));
  if (data.error === 'slot_taken') loadSlots();
  renderView();
}

// «Спросить консультанта» (11 §3.3): on the site — the chat widget with the apartment as the context of the first question
// (the card closes: the modal card would cover the chat); in the mini app — the bot with /start apt_<no> (11 §8), the app closes.
let chat = null, chatApt = null;
function askAbout(a) {
  const tg = window.Telegram?.WebApp, bot = document.documentElement.dataset.bot;
  if (document.documentElement.dataset.mode === 'mini') {
    if (tg && bot) { tg.openTelegramLink(`https://t.me/${bot}?start=apt_${a.no}`); tg.close(); }
    return;
  }
  if (!chat) return;
  chatApt = a.no;
  $('aptDlg').close();
  chat.open();
}

// ---------- live statuses (11 §3.2) ----------
// Only the apartments whose status changed are touched: their cells, the counts, the plan, the 3D windows, the card.
function onLive({ mine: m, changes }) {
  mine = m;
  const done = [];
  for (const [no, st] of changes) {
    const a = byNo(no);
    if (a && a.status !== st) { a.status = st; done.push([no, st]); }
  }
  if (done.length) {
    recolorCells($('bldFacade'), done, st => t('bld.st.' + st));
    for (const [no] of done) $('bldFacade').querySelector(`[data-apt="${no}"]`)?.classList.toggle('dim', !matches(byNo(no)));
    for (const row of $('bldFacade').querySelectorAll('[data-floor]')) row.querySelector('.bld-cnt').textContent = countsText(floorOf(Number(row.dataset.floor)));
    renderFilters();
    drawFloor();
    paint3d();
  }
  if ($('aptDlg').open && cardApt) syncCard(cardApt);
}

function onStale(min) {
  $('liveStale').hidden = min == null;
  if (min != null) $('liveStale').textContent = t('bld.live.stale', { n: min });
}

// ---------- page ----------
function renderAll() {
  renderFilters();
  renderFacade();
  legend();
  drawFloor();
  paint3d();
  document.querySelectorAll('#colorBy [data-by]').forEach(x => x.classList.toggle('active', x.dataset.by === colorBy));
}

function setFloor(n) {
  floorN = Math.max(1, Math.min(b.floors, n));
  hover = null;
  $('bldTip').hidden = true;
  renderFacade();
  drawFloor();
  ext?.setFloor(floorN);
}

// ---------- 3D facade ----------
function paint3d() {
  ext?.paint({ colorOf: no => (tint3d ? tintOf(byNo(no)) : null), dim: no => !matches(byNo(no)), hover: hover3d });
}

function sync3dHud() {
  if (!ext) return;
  document.querySelectorAll('#bld3dTime [data-time]').forEach(x => {
    x.classList.toggle('active', x.dataset.time === ext.getTime());
    x.title = t('bld3d.' + x.dataset.time);
  });
  $('bld3dOrbit').classList.toggle('active', ext.getAuto() && !ext.isWalking());
  $('bld3dWalk').classList.toggle('active', ext.isWalking());
  $('bldHero').hidden = ext.isWalking();
  $('bld3dPad').hidden = !(ext.isWalking() && matchMedia('(pointer: coarse)').matches);
  $('bld3dTint').classList.toggle('active', tint3d);
  const touch = matchMedia('(pointer: coarse)').matches;
  $('bld3dHint').textContent = t(ext.isWalking() ? (touch ? 'bld3d.walkHintTouch' : 'bld3d.walkHint') : touch ? 'bld3d.hintTouch' : 'bld3d.hint');
}

// On the street walk: an arrow to the entrance doors with the distance, "step in" when at the doors.
let cue3d = null;
function showCue(c) {
  cue3d = c;
  const el = $('bld3dCue');
  el.hidden = !c;
  if (!c) return;
  const near = c.dist < 3;
  el.classList.toggle('near', near);
  $('bld3dCueArrow').style.transform = `rotate(${near ? 0 : c.angle}rad)`;
  $('bld3dCueText').textContent = near ? t('bld3d.atDoor') : `${t('bld3d.toEntrance')} · ${Math.round(c.dist)} ${t('bld.m')}`;
}

// Photo facade: the library sets (ambientCG, CC0) are downloaded on the server by the first visitor (at once, the
// button shows the progress; on obviously weak devices only when the button is pressed); after that every visitor
// of this server gets them at once and the button is gone.
let photoStep = null, photoTotal = 0;   // { done, total } while downloading; sets missing
async function syncPhotoBtn() {
  const btn = $('bld3dPhoto');
  if (photoStep) {
    btn.disabled = true;
    $('bld3dPhotoText').textContent = t('bld3d.photoLoading', photoStep);
    return;
  }
  const { facadeStatus } = await import('./bld3d/facadeTex.js');
  const st = await facadeStatus();
  photoTotal = st.missing.length;
  btn.hidden = !st.missing.length || !st.canFetch;
  btn.disabled = false;
  $('bld3dPhotoText').textContent = t('bld3d.photo', { mb: st.mb });
  btn.title = t('bld3d.photoTitle', { mb: st.mb });
}

let photoRun = null;    // the download in progress: further presses do nothing
function loadPhotoFacade() {
  if (photoRun) return photoRun;
  photoStep = { done: 0, total: photoTotal };
  syncPhotoBtn();
  photoRun = (async () => {
    const { fetchFacadeSets } = await import('./bld3d/facadeTex.js');
    try {
      await fetchFacadeSets((done, total) => { photoStep = { done, total }; syncPhotoBtn(); });
      photoStep = null;
      await ext.refreshPhoto();
      toast(t('bld3d.photoDone'));
    } catch {
      photoStep = null;
      toast(t('bld3d.photoFail'), true);
    }
    syncPhotoBtn();
  })().finally(() => { photoRun = null; });
  return photoRun;
}

async function init3d() {
  try {
    const [{ createExterior }, { facadeOf }] = await Promise.all([import('./bld3d/exterior.js'), import('./facade.js')]);
    ext = createExterior($('bld3dView'), {
      bld: b, fac: facadeOf(b), title: local(b.name), entrance: t('bld3d.entranceSign'),
      onHover: (no, e) => {
        if (no !== hover3d) { hover3d = no; paint3d(); }
        showTip(no ? byNo(no) : null, e, $('bld3dView'), $('bld3dTip'));
      },
      onPick: no => { const a = byNo(no); setFloor(a.floor); openCard(a); },
      onFloor: n => { if (n !== floorN) setFloor(n); },
      onDoor: enterLobby,
      onWalk: () => sync3dHud(),
      onCue: showCue
    });
  } catch {
    $('bld3dCard').hidden = true;   // no WebGL: the floor grid and plan remain
    return;
  }
  $('bld3dTime').addEventListener('click', e => {
    const x = e.target.closest('[data-time]');
    if (x) { ext.setTime(x.dataset.time); sync3dHud(); }
  });
  $('bld3dOrbit').addEventListener('click', () => { ext.endWalk(); ext.setAuto(!ext.getAuto()); sync3dHud(); });
  $('bld3dWalk').addEventListener('click', () => {
    if (ext.isWalking()) ext.endWalk(); else ext.startWalk('street');
    $('bld3dWalk').blur();
    sync3dHud();
  });
  // Touch: hold ▲ / ▼ to walk.
  for (const btn of $('bld3dPad').querySelectorAll('[data-f]')) {
    const set = v => e => { e.preventDefault(); ext.walkPad.f = v; ext.requestRender(); };
    btn.addEventListener('pointerdown', set(Number(btn.dataset.f)));
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, set(0));
  }
  $('bld3dTint').addEventListener('click', () => {
    tint3d = !tint3d;
    try { localStorage.setItem('fsp3d.bldTint', tint3d ? '1' : '0'); } catch { /* ignore */ }
    paint3d(); sync3dHud();
  });
  $('bld3dPhoto').addEventListener('click', loadPhotoFacade);
  syncPhotoBtn().then(() => { if (photoTotal && !$('bld3dPhoto').hidden && photoAuto()) loadPhotoFacade(); });
  // The facade stands still while a dialog covers it (the floor 3D has its own scene).
  const pause = () => ext.pause(['aptDlg', 'floor3dDlg', 'reqDlg'].some(id => $(id).open));
  for (const id of ['aptDlg', 'floor3dDlg', 'reqDlg']) new MutationObserver(pause).observe($(id), { attributes: true, attributeFilter: ['open'] });
  pause();
  ext.setFloor(floorN);
  paint3d();
  sync3dHud();
}

function bind() {
  for (const id of ['fAreaMin', 'fAreaMax', 'fPrice']) $(id).addEventListener('input', readFilters);
  $('fFree').addEventListener('change', readFilters);
  $('floorDown').addEventListener('click', () => setFloor(floorN - 1));
  $('floorUp').addEventListener('click', () => setFloor(floorN + 1));
  $('colorBy').addEventListener('click', e => {
    const x = e.target.closest('[data-by]');
    if (!x) return;
    colorBy = x.dataset.by;
    try { localStorage.setItem('fsp3d.bldColor', colorBy); } catch { /* ignore */ }
    renderAll();
  });
  $('bldFacade').addEventListener('click', e => {
    const row = e.target.closest('[data-floor]');
    if (!row) return;
    setFloor(Number(row.dataset.floor));
    const cell = e.target.closest('[data-apt]');
    if (cell) openCard(allApts().find(a => a.no === Number(cell.dataset.apt)));
  });
  $('bldFacade').addEventListener('keydown', e => {
    const row = e.target.closest('[data-floor]');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setFloor(Number(row.dataset.floor)); }
  });
  const plan = $('bldPlan');
  plan.addEventListener('pointermove', e => {
    const a = aptAt(e);
    if ((a?.no ?? null) !== hover) { hover = a?.no ?? null; drawFloor(); }
    plan.style.cursor = a ? 'pointer' : 'default';
    showTip(a, e);
  });
  plan.addEventListener('pointerleave', () => { hover = null; $('bldTip').hidden = true; drawFloor(); });
  plan.addEventListener('click', e => { const a = aptAt(e); if (a) openCard(a); });
  $('aptClose').addEventListener('click', () => $('aptDlg').close());
  $('aptPlanner').addEventListener('click', () => openInPlanner(cardApt));
  $('apt3d').addEventListener('click', () => open3d(cardApt));
  $('floor3dClose').addEventListener('click', () => $('floor3dDlg').close());
  // The WebGL scene goes away with the dialog.
  $('floor3dDlg').addEventListener('close', () => { $('floor3dFrame').src = 'about:blank'; });
  // The walker went into another apartment of the floor: the dialog title follows.
  window.addEventListener('message', e => {
    if (e.origin !== location.origin || e.source !== $('floor3dFrame').contentWindow) return;
    // Out through the street doors of the lobby: back on the porch.
    if (e.data?.type === 'fsp3d:ready') {
      $('floor3dLoad').hidden = true;
      $('floor3dFrame').focus();           // the keys walk inside the frame right away
      $('floor3dFrame').contentWindow.focus();
      return;
    }
    if (e.data?.type === 'fsp3d:street') {
      $('floor3dDlg').close();
      if (ext) { ext.startWalk('porch'); sync3dHud(); }
      return;
    }
    if (e.data?.type !== 'fsp3d:place') return;
    const a = byNo(e.data.no), n = Number(e.data.floor);
    if (a) $('floor3dTitle').textContent = `${t('bld.apt', { no: a.no })} · ${t('bld.floor', { n: a.floor })} · 3D`;
    else if (n === 1) $('floor3dTitle').textContent = `${t('bld.lobbyFloor')} · 3D`;
    else if (n > 1) $('floor3dTitle').textContent = `${t('bld.floor', { n })} · 3D`;
  });
  $('aptRequest').addEventListener('click', () => openRequest(cardApt));
  $('reqCancel').addEventListener('click', () => $('reqDlg').close());
  $('reqForm').addEventListener('submit', sendRequest);
  $('aptBook').addEventListener('click', () => openHold(cardApt));
  $('aptView').addEventListener('click', () => openView(cardApt));
  $('aptAsk').addEventListener('click', () => askAbout(cardApt));
  $('viewCancel').addEventListener('click', () => $('viewDlg').close());
  $('viewForm').addEventListener('submit', sendView);
  $('viewForm').addEventListener('input', () => vw && syncView());
  $('viewDate').addEventListener('change', () => vw && loadSlots());
  $('viewForm').elements.phone.addEventListener('change', e => { e.target.value = fmtPhone(e.target.value) || e.target.value; syncView(); });
  $('holdCancel').addEventListener('click', () => $('holdDlg').close());
  $('holdForm').addEventListener('submit', sendHold);
  $('holdForm').addEventListener('input', () => hold && syncHold());
  $('holdForm').elements.phone.addEventListener('change', e => { e.target.value = fmtPhone(e.target.value) || e.target.value; syncHold(); });
  new ResizeObserver(() => drawFloor()).observe($('planWrap'));
  $('bldHeroPick').addEventListener('click', () => $('bldPlan').closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $('bldHeroWalk').addEventListener('click', () => $('bld3dWalk').click());
  onThemeChange(() => { renderAll(); if ($('aptDlg').open) drawCard(cardApt); });
  onLangChange(() => {
    document.title = `${local(b.name)} — ${t('bld.title')}`;
    $('bldName').textContent = local(b.name);
    $('bldHeroName').textContent = local(b.name);
    ext?.setTitle(local(b.name), t('bld3d.entranceSign'));
    if (cue3d) showCue(cue3d);
    sync3dHud();
    if (ext) syncPhotoBtn();
    renderAll();
    if ($('aptDlg').open) openCard(cardApt);
    if ($('reqDlg').open) $('reqTitle').textContent = t('bld.reqTitle', { no: cardApt.no });
    if ($('holdDlg').open) renderHold();
    if ($('viewDlg').open) renderView();
  });
}

// #apt=41 opens the card of the apartment (a link from the chat, the booking page); #apt=41&book=1 goes on to the hold form.
function openFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const a = byNo(Number(p.get('apt')));
  if (!a) return;
  setFloor(a.floor);
  openCard(a);
  if (p.get('book') && a.status === 'free') openHold(a);
}

async function start() {
  initLangSwitcher();
  initTheme();
  initIcons();
  try {
    const res = await fetch('/api/buildings/' + encodeURIComponent(BUILDING));
    if (!res.ok) throw new Error(res.status);
    b = await res.json();
  } catch {
    toast(t('bld.loadFail'), true);
    return;
  }
  document.title = `${local(b.name)} — ${t('bld.title')}`;
  $('bldName').textContent = local(b.name);
  $('bldHeroName').textContent = local(b.name);
  const n = Number(new URLSearchParams(location.search).get('floor'));
  floorN = n >= 1 && n <= b.floors ? n : 2;
  bind();
  renderAll();
  init3d();
  openFromHash();
  live = createLiveStatus({ onUpdate: onLive, onStale });
  live.start();
  // back from the booking or the payment page (the browser may show the page from its cache): ask at once
  addEventListener('pageshow', e => { if (e.persisted) live.refresh(); });
  // The consultant (11 §5): loaded in the background. An apartment from the chat is shown here: its floor, the card, the hold form.
  // The mini app has no widget (11 §8): the chat is the bot itself.
  if (document.documentElement.dataset.mode !== 'mini') (window.requestIdleCallback || (f => setTimeout(f, 1500)))(() => import('./chat/widget.js').then(m => { chat = m.mountChat({
    page: 'building',
    getApartmentNo: () => ($('aptDlg').open ? cardApt?.no ?? null : chatApt),
    onOpen: (no, { book }) => {
      const a = byNo(no);
      if (!a) return;
      setFloor(a.floor);
      openCard(a);
      if (book && a.status === 'free') openHold(a);
    }
  }); if ($('aptDlg').open && cardApt) syncCard(cardApt); }), { timeout: 4000 });
}

start();
