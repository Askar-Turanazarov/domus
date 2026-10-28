// Runs in <head> before the styles paint (14 §7: no inline scripts under the CSP): the saved theme, dark by default.
try { document.documentElement.dataset.theme = localStorage.getItem('fsp3d.theme') || 'dark'; } catch (e) { document.documentElement.dataset.theme = 'dark'; }
