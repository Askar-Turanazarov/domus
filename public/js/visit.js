// The funnel counter (11 §11.1): one call after the showcase or the planner opens; the server sets the cookie dvid. Not in the mini app
// (/mini counts by the Telegram user in /api/mini/bootstrap).
if (!location.pathname.startsWith('/mini')) {
  addEventListener('load', () => { fetch('/api/visit', { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(() => {}); }, { once: true });
}
