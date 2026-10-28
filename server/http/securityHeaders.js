// Security headers (14 §7) for every answer of the server; vercel.json repeats them for the static files
// (test/securityHeaders.test.js keeps the two equal). /mini sets its own CSP (Telegram script and frame, mini.js).

// The only inline script left in the pages is the import map of three (index.html, building.html): it cannot be a file,
// so the CSP allows it by its hash. A changed import map → a new hash (the test says which).
export const IMPORTMAP_HASH = "'sha256-0NpJibtJni/vs9bJacK4pk7ARr1j/VocnRgknH7kXyc='";
const TELEGRAM_FRAME = ['https://web.telegram.org', 'https://*.telegram.org'];

// 14 §7 plus what Domus really loads: Google Fonts (the stylesheet and the font files).
function csp({ script = [], frameAncestors }) {
  return [
    "default-src 'self'",
    `script-src 'self' ${IMPORTMAP_HASH}${script.map(s => ' ' + s).join('')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    `frame-ancestors ${frameAncestors.join(' ')}`,
    "form-action 'self' https://checkout.stripe.com",
    "base-uri 'none'",
    "object-src 'none'"
  ].join('; ');
}

// Frames (S2 of the security review): the staff pages and the API — never; the public pages — this site (the floor 3D
// iframe of building.html) and Telegram Web, where the mini app goes on to /b/, /pay/ and the floor 3D inside its frame.
// Browsers with frame-ancestors ignore X-Frame-Options; SAMEORIGIN stays for the old ones.
export const CSP = csp({ frameAncestors: ["'self'", ...TELEGRAM_FRAME] });
export const STAFF_CSP = csp({ frameAncestors: ["'none'"] });
export const MINI_CSP = csp({ script: ['https://telegram.org'], frameAncestors: TELEGRAM_FRAME });

// The staff addresses as a vercel.json source (path-to-regexp with a raw group) and its complement for the public block.
export const STAFF_SOURCE = '/(admin|admin\\.html|admin/.*|dashboard|dashboard/.*|bookings\\.html|calls\\.html|api/.*)';
export const PUBLIC_SOURCE = '/((?!mini$|admin$|admin\\.html$|admin/|dashboard$|dashboard/|bookings\\.html$|calls\\.html$|api/).*)';
const staffRe = new RegExp(`^${STAFF_SOURCE}$`);
export const isStaff = p => staffRe.test(p);

const COMMON = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()'
};
export const HEADERS = { ...COMMON, 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': CSP };
export const STAFF_HEADERS = { ...COMMON, 'X-Frame-Options': 'DENY', 'Content-Security-Policy': STAFF_CSP };
// COOP: not on the booking and payment pages, which go on to Stripe (14 §7).
export const COOP = 'same-origin';
export const COOP_SOURCE = '/((?!mini$|b/|pay/).*)';
export const noCoop = p => p.startsWith('/b/') || p.startsWith('/pay/');

export function securityHeaders(req, res, next) {
  res.set(isStaff(req.path) ? STAFF_HEADERS : HEADERS);
  if (!noCoop(req.path)) res.set('Cross-Origin-Opener-Policy', COOP);
  next();
}
