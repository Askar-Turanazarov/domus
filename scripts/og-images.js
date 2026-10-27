// Link-preview pictures (Open Graph, 1200×630): public/og/{planner,building}-{ru,uz,en}.png.
// The poster scripts/og-poster.html is served by the app itself (real building data) and photographed by an installed
// Chrome / Edge in headless mode — no extra npm packages. `npm run og`; `npm run og -- --serve` only serves the poster
// (http://localhost:<port>/__og?page=planner&lang=ru) to look at it in a browser.
// The browser: OG_BROWSER=<path>, otherwise the usual Chrome / Edge locations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
const run = (cmd, args) => new Promise((ok, fail) => execFile(cmd, args, { timeout: 60000 }, e => (e ? fail(e) : ok())));   // async: the server answers meanwhile

process.env.PGLITE_DIR ||= 'memory://';   // nothing is written to the project
const { default: app } = await import('../server.js');
app.get('/__og', (req, res) => res.sendFile(path.join(import.meta.dirname, 'og-poster.html')));

const OUT = path.join(import.meta.dirname, '..', 'public', 'og');
const CANDIDATES = [
  process.env.OG_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',   // headless Edge on Windows may exit without a picture
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'
].filter(Boolean);

const server = app.listen(Number(process.env.OG_PORT) || 0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  if (process.argv.includes('--serve')) return console.log(`poster: ${base}/__og?page=planner&lang=ru`);
  const browser = CANDIDATES.find(p => fs.existsSync(p));
  if (!browser) { console.error('No Chrome / Edge found: set OG_BROWSER'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp3d-og-browser-'));
  for (const page of ['planner', 'building']) {
    for (const lang of ['ru', 'uz', 'en']) {
      const file = path.join(OUT, `${page}-${lang}.png`);
      await run(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        `--user-data-dir=${profile}`, '--force-device-scale-factor=1', '--window-size=1200,630',
        '--virtual-time-budget=8000', `--screenshot=${file}`, `${base}/__og?page=${page}&lang=${lang}`]);
      const png = fs.readFileSync(file);
      console.log(`${path.relative(process.cwd(), file)}  ${png.readUInt32BE(16)}×${png.readUInt32BE(20)}  ${(png.length / 1024).toFixed(0)} KB`);
    }
  }
  fs.rmSync(profile, { recursive: true, force: true });
  server.close();
});
