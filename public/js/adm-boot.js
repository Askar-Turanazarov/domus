// Staff pages, in <head>: signed in earlier → hide the login form before adminAuth.js runs (no flash).
try { if (localStorage.getItem('fsp3d.adm')) document.documentElement.dataset.adm = 'in'; } catch (e) { /* no storage */ }
