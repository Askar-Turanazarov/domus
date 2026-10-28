// render(template, lang, vars) → { text, parse_mode: 'HTML', link_preview_options, reply_markup? } | null (04 §3.1 step 3).
// Pure: the same input gives the same message; it is stored in outbox.rendered, shown in the Outbox window and sent as is.
// It runs inside the core transaction, so it never throws: an unknown template gives null, a missing variable an empty place.
import { t, failureText } from '../i18n/index.js';
import { TEMPLATES } from './templates.js';
import { money, areaText, tashkent, esc } from './format.js';

const DASH = '—';
const text = (lang, key) => t(lang, key);

// How a variable is shown: every value goes through here, so nothing reaches Telegram's HTML unescaped.
const FORMAT = {
  deposit: money, amount: money, price: money,
  until: tashkent, holdUntil: tashkent, at: tashkent,
  area: (v, lang) => areaText(v, lang),
  reason: (v, lang) => esc(v) || text(lang, 'tpl.no_reason'),
  staffName: (v, lang) => esc(v) || text(lang, 'tpl.unassigned'),
  name: v => esc(v) || DASH,
  context: v => esc(v) || DASH,
  comment: v => esc(v) || DASH,
  channel: (v, lang) => text(lang, `tpl.channel.${v}`) ?? esc(v),
  provider: (v, lang) => text(lang, `tpl.provider.${v}`) ?? esc(v),
  stage: (v, lang) => text(lang, `tpl.stage.${v}`) ?? esc(v)
};

// Texts built from a code in the variables.
const DERIVED = {
  payment_failed: (v, lang) => ({ reasonText: failureText(v.reason, lang) ?? text(lang, 'pay.reason.provider_error') }),
  staff_booking_cancelled: (v, lang) => ({
    initiatorText: text(lang, `tpl.initiator.${v.initiator}`) ?? esc(v.initiator),
    fateText: text(lang, `tpl.fate.${v.fate}`) ?? esc(v.fate) }),
  staff_refund_done: (v, lang) => ({ reasonText: text(lang, `tpl.refund_reason.${v.reason}`) ?? esc(v.reason) })
};
const DERIVED_NAMES = ['reasonText', 'initiatorText', 'fateText'];

function display(id, def, vars, lang) {
  const out = {};
  for (const name of [...def.vars, ...DERIVED_NAMES]) out[name] = '';            // a missing variable is an empty place, not «{name}»
  for (const [k, v] of Object.entries(vars)) out[k] = (FORMAT[k] ?? (x => esc(x ?? '')))(v, lang);
  return { ...out, ...DERIVED[id]?.(vars, lang) };
}

function button(b, def, vars, lang, base) {
  const caption = text(lang, `tpl.btn.${b.key}`);
  if (b.kind === 'cb') {
    const data = b.data(vars);
    return data && Buffer.byteLength(data) <= 64 ? { text: caption, callback_data: data } : null;
  }
  const path = b.path(vars, lang);
  if (!path) return null;
  const url = b.absolute ? String(path) : base + path;
  if (!/^https:\/\//.test(url)) return null;                                      // web_app and the group's links need https
  return { text: caption, ...(b.kind === 'web' && def.audience === 'client' ? { web_app: { url } } : { url }) };
}

// opts — { publicUrl } for the buttons' addresses.
export function render(template, lang, vars, { publicUrl = '' } = {}) {
  vars ??= {};
  const def = TEMPLATES[template];
  if (!def) return null;
  const base = String(publicUrl).replace(/\/+$/, '');
  if (def.composed) return renderTaken(lang, vars, { publicUrl });

  const variant = def.variant?.(vars);
  const body = text(lang, variant ? `tpl.${template}.text.${variant}` : `tpl.${template}.text`) ?? '';
  const shown = display(template, def, vars, lang);
  const message = body.replace(/\{(\w+)\}/g, (m, k) => (k in shown ? shown[k] : m));
  const rows = def.buttons.map(b => button(b, def, vars, lang, base)).filter(Boolean).map(b => [b]);
  return { text: message, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    ...(rows.length && { reply_markup: { inline_keyboard: rows } }) };
}

// staff_lead_taken (04 §4.2): the original text plus «✅ Взял {staffName}»; «Беру клиента» is gone, «Открыть в админке» stays.
function renderTaken(lang, vars, opts) {
  const { of, staffName, ...own } = vars;
  const inner = of !== 'staff_lead_taken' && render(of, lang, own, opts);
  if (!inner) return null;
  const rows = (inner.reply_markup?.inline_keyboard ?? []).filter(([b]) => !b.callback_data?.startsWith('take:'));
  return { ...inner, text: `${inner.text}\n\n${t(lang, 'tpl.taken', { staffName: FORMAT.staffName(staffName, lang) })}`,
    reply_markup: rows.length ? { inline_keyboard: rows } : undefined };
}

// The render the core gets in its options: bound to PUBLIC_URL, never throws.
export function createRender(env = process.env) {
  const opts = { publicUrl: env.PUBLIC_URL ?? '' };
  return (template, lang, vars) => {
    try { return render(template, lang, vars, opts); } catch (e) {
      console.error(`render ${template} failed:`, e.message);
      return null;
    }
  };
}
