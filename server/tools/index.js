// The tools of «Chinor Park»: apartments from the project's apartments.json. Prices in sum (integers), area in m², rooms 0 = studio.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { annuity } from '../core/finance.js';
import { bookViewing, BookingError } from '../core/viewings.js';
import { logTexts, ruText } from './logText.js';
import { safeArgs } from './journal.js';
import { fileBookings, fileCalls } from '../db.js';

const root = f => fileURLToPath(new URL('../../' + f, import.meta.url));
export const FILES = { apartments: root('apartments.json'), bookings: root('booking.json'), calls: root('mcp-calls.jsonl') };

// What the tools work with: { apartments — path, statuses() — the manager's statuses (optional), addBooking(b), logCall(e) }.
// files — either that, or the paths { apartments, bookings, calls } (tests, the local run without the site's storage).
export function context(files = FILES) {
  if (files.addBooking) return files;
  return { ...files, ...fileBookings(files.bookings), logCall: files.calls ? fileCalls(files.calls).logCall : async () => {} };
}

// The site's storage (server/db.js createDb): bookings and the call log in booking.json / mcp-calls.jsonl or Postgres.
export const dbContext = db => ({ apartments: FILES.apartments, statuses: () => db.statuses(),
  addBooking: b => db.addBooking(b), logCall: e => db.logCall(e) });

const short = ({ no, floor, rooms, area, price, status }) => ({ no, floor, rooms, area, price, status });
const kind = a => (a.rooms ? `${a.rooms}-комн.` : 'студия');
const sum = n => n.toLocaleString('ru-RU') + ' сум';
const line = a => `№${a.no}: ${kind(a)}, ${a.area} м², этаж ${a.floor}, ${sum(a.price)}, ${a.status}`;
const ok = (data, text) => ({ structuredContent: data, content: [{ type: 'text', text }] });
// key / vars: the same text in three languages for the call log (logText.js); safe() takes it off before the answer goes out.
const fail = (key, vars) => ({ isError: true, content: [{ type: 'text', text: ruText(key, vars) }], log: { key, vars } });

// A broken or missing data file must not show its path to the client: log the code, answer in general terms.
async function run(handler, args) {
  try { return await handler(args); } catch (e) {
    if (e instanceof BookingError) return fail(e.key, e.vars);
    console.error('tool failed:', e.code || e.name);
    return fail('internal');
  }
}

// The answer in a line for the call log, as { ru, uz, en }; a booking is logged without the client's name.
function summary(tool, d, log) {
  if (log) return logTexts(log.key, log.vars);
  if (tool === 'book_viewing') return logTexts('booked', { no: d.no, when: d.datetime.slice(0, 16).replace('T', ' ') });
  if (tool === 'calc_mortgage') return logTexts('mortgage', d);
  if (tool === 'get_apartment') return logTexts('apt', { ...d, perM2: d.pricePerM2 });
  return logTexts('found', { n: d.total });
}

// Every tool runs through here: errors become plain-text answers, each call lands in the call log.
const safe = (ctx, tool, handler, seen = {}) => async args => {
  seen.logged = true;
  const t0 = Date.now();
  const { log, ...r } = await run(handler, args);
  const msgs = summary(tool, r.structuredContent, log);
  await ctx.logCall({ type: 'call', tool, ok: !r.isError, ms: Date.now() - t0, args: safeArgs(tool, args), msg: msgs.ru, msgs });
  return r;
};

export async function readApartments(file) {
  return JSON.parse(await fs.readFile(file, 'utf8')).apartments || [];
}

const STATUSES = ['free', 'booked', 'sold'];

// The manager's statuses ({ [building]: { [no]: status } }, the site's /admin.html) win over apartments.json,
// as on the showcase (server/buildings.js applyStatuses). Pure: returns new objects only where a status changed.
export function applyStatuses(list, overrides) {
  return list.map(a => {
    const own = overrides?.[a.building]?.[a.no];
    return STATUSES.includes(own) && own !== a.status ? { ...a, status: own } : a;
  });
}

// files.statuses — optional async () → the manager's statuses (server/mcp/index.js passes the site's storage, server/db.js).
const apartmentsOf = async files => applyStatuses(await readApartments(files.apartments), files.statuses ? await files.statuses() : {});

// Pure: the filters, free only by default, cheapest first.
export function searchApartments(list, { rooms, maxPrice, minArea, floor, status = 'free', limit = 20 } = {}) {
  const found = list.filter(a => (rooms == null || a.rooms === rooms) && (maxPrice == null || a.price <= maxPrice)
    && (minArea == null || a.area >= minArea) && (floor == null || a.floor === floor) && (status === 'any' || a.status === status))
    .sort((a, b) => a.price - b.price || a.no - b.no);
  return { total: found.length, apartments: found.slice(0, limit).map(short) };
}

// Pure: one apartment by number with the price per m², or null.
export function getApartment(list, no) {
  const a = list.find(x => x.no === no);
  return a ? { ...short(a), pricePerM2: Math.round(a.price / a.area) } : null;
}

const APT = z.object({ no: z.number(), floor: z.number(), rooms: z.number(), area: z.number(), price: z.number(), status: z.string() });

// seen.logged — set once a tool ran and wrote its line (server/mcp/index.js logs the calls the SDK refused before any tool ran).
// files — the context (see context() above).
export function registerTools(server, files = context(), seen = {}) {
  const wrap = (tool, handler) => safe(files, tool, handler, seen);
  server.registerTool('search_apartments', {
    title: 'Поиск квартир',
    description: 'Квартиры новостройки по фильтрам. Цены в сумах (целые), площадь в м², rooms 0 — студия. По умолчанию только свободные (status free), сначала дешёвые.',
    inputSchema: z.strictObject({
      rooms: z.number().int().min(0).max(6).optional().describe('Число комнат, 0 — студия'),
      maxPrice: z.number().int().positive().optional().describe('Максимальная цена, сум'),
      minArea: z.number().positive().optional().describe('Минимальная площадь, м²'),
      floor: z.number().int().min(1).max(100).optional().describe('Этаж'),
      status: z.enum(['free', 'booked', 'sold', 'any']).optional().describe('free — в продаже, booked — бронь, sold — продана, any — все'),
      limit: z.number().int().min(1).max(100).optional().describe('Сколько квартир вернуть, по умолчанию 20')
    }),
    outputSchema: { total: z.number().int(), apartments: z.array(APT) }
  }, wrap('search_apartments', async args => {
    const r = searchApartments(await apartmentsOf(files), args);
    return ok(r, [`Найдено: ${r.total}`, ...r.apartments.map(line)].join('\n'));
  }));

  server.registerTool('get_apartment', {
    title: 'Квартира по номеру',
    description: 'Карточка квартиры по номеру: этаж, комнаты, площадь, цена и цена за м² в сумах, статус.',
    inputSchema: z.strictObject({ no: z.number().int().positive().describe('Номер квартиры') }),
    outputSchema: APT.extend({ pricePerM2: z.number().int() }).shape
  }, wrap('get_apartment', async ({ no }) => {
    const a = getApartment(await apartmentsOf(files), no);
    if (!a) return fail('notFound', { no, hint: true });
    return ok(a, `${line(a)}, ${sum(a.pricePerM2)}/м²`);
  }));

  server.registerTool('calc_mortgage', {
    title: 'Ипотека (аннуитет)',
    description: 'Аннуитет с месячной ставкой (годовая / 12): ежемесячный платёж, общая сумма выплат и переплата. Укажите одно из трёх: сумму кредита (loan), цену (price) с взносом downPct или номер квартиры (no) — тогда берётся её цена. Все суммы — целые сумы.',
    inputSchema: z.strictObject({
      loan: z.number().int().positive().optional().describe('Сумма кредита, сум'),
      price: z.number().int().positive().optional().describe('Цена квартиры, сум (кредит = цена − взнос)'),
      no: z.number().int().positive().optional().describe('Номер квартиры вместо цены'),
      downPct: z.number().min(0).max(90).optional().describe('Первоначальный взнос, % от цены (по умолчанию 0)'),
      years: z.number().int().min(1).max(30).describe('Срок, лет'),
      rate: z.number().min(0).max(60).describe('Ставка, % годовых')
    }),
    outputSchema: {
      price: z.number().int(), down: z.number().int(), loan: z.number().int(), months: z.number().int(),
      monthly: z.number().int(), total: z.number().int(), overpay: z.number().int(), no: z.number().int().optional()
    }
  }, wrap('calc_mortgage', async ({ loan, price, no, downPct = 0, years, rate }) => {
    if ([loan, price, no].filter(v => v != null).length !== 1) return fail('oneOf');
    if (loan != null && downPct) return fail('downWithLoan');
    if (no != null) {
      const a = (await apartmentsOf(files)).find(x => x.no === no);
      if (!a) return fail('notFound', { no });
      price = a.price;
    }
    const r = { ...annuity({ price, downPct, loan, years, rate }), ...(no != null ? { no } : {}) };
    return ok(r, [
      loan != null ? `Кредит ${sum(r.loan)}` : `${no != null ? `Квартира №${no}, ц` : 'Ц'}ена ${sum(r.price)}, взнос ${downPct}% = ${sum(r.down)}, кредит ${sum(r.loan)}`,
      `${years} лет (${r.months} мес.) под ${rate}% годовых: платёж ${sum(r.monthly)} в месяц`,
      `Всего выплат ${sum(r.total)}, переплата ${sum(r.overpay)}`
    ].join('\n'));
  }));

  server.registerTool('book_viewing', {
    title: 'Запись на показ',
    description: 'Записывает на показ квартиры (с id и временем создания). Проверяет, что квартира существует и не продана и что на это же время на эту квартиру нет другой записи. Время — Ташкент. Статус квартиры не меняется.',
    inputSchema: z.strictObject({
      name: z.string().trim().min(2).max(80).describe('Имя'),
      phone: z.string().trim().min(7).max(30).describe('Телефон, например +998 90 123 45 67'),
      datetime: z.string().max(40).describe('Дата и время показа, например 2026-10-25T15:00 (время Ташкента)'),
      no: z.number().int().positive().describe('Номер квартиры')
    }),
    outputSchema: { id: z.string(), no: z.number().int(), name: z.string(), phone: z.string(), datetime: z.string(), createdAt: z.string() }
  }, wrap('book_viewing', async args => {
    const b = await bookViewing(files.addBooking, await apartmentsOf(files), args);
    return ok(b, `Записано: ${b.name}, квартира №${b.no}, ${b.datetime.slice(0, 16).replace('T', ' ')} (Ташкент). Номер записи ${b.id}`);
  }));
}
