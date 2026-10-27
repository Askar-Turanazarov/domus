// What the tools share: argument helpers, the apartment card, the price of «no or price», PII masks for the journal.
import { z } from 'zod';
import { DomainError } from '../core/errors.js';
import { getApartment } from '../core/apartments.js';
import { settingsOf } from '../core/bookings.js';
import { maskPhone } from '../core/phone.js';

export const aptNo = z.number().int().positive();
export const sum = z.number().int().positive();
export const pct = z.number().min(0).max(90);

// The showcase page of an apartment (opens it in 3D, 11 §3.4).
export const aptUrl = (no, lang, env = process.env) => `${env.PUBLIC_URL ?? ''}/${lang || 'ru'}#apt=${no}`;
export const absolute = (path, env = process.env) => `${env.PUBLIC_URL ?? ''}${path}`;

export const card = (a, lang, env) => ({
  no: a.no, building: a.building, floor: a.floor, rooms: a.rooms, area: a.area, price: a.price,
  pricePerM2: Math.round(a.price / a.area), status: a.status, url: aptUrl(a.no, lang, env)
});

export const settings = ctx => settingsOf(ctx.db, ctx.core);

// Exactly one of the keys given, else invalid_input with those fields (Domus calc_mortgage).
export function oneOf(args, keys) {
  if (keys.filter(k => args[k] != null).length !== 1) throw new DomainError('invalid_input', { fields: keys });
}

// «no or price» → { price, no? }: the apartment's price from the base.
export async function priceOf(args, ctx) {
  if (args.no == null) return { price: args.price };
  const a = await getApartment(ctx.db, args.no, ctx.core);
  if (!a) throw new DomainError('apartment_not_found', { no: args.no });
  return { price: a.price, no: a.no };
}

// 08 §9: phone → mask, name → first letter, confirmToken left out.
export function redactPii({ confirmToken, ...args }) {
  const out = { ...args };
  if (out.phone != null) out.phone = maskPhone(String(out.phone)) ?? '***';
  if (out.name != null) out.name = String(out.name).trim().slice(0, 1) + '.';
  return out;
}
