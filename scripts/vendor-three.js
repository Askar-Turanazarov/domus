// Copy three.js (build + examples/jsm) into public/vendor/three/ for hosts that serve only public/ as static files
// (Vercel: the build command). Locally Express serves it straight from node_modules, this copy is not needed.
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const from = path.join(root, 'node_modules', 'three');
const to = path.join(root, 'public', 'vendor', 'three');
fs.rmSync(to, { recursive: true, force: true });
for (const dir of ['build', 'examples/jsm']) fs.cpSync(path.join(from, dir), path.join(to, dir), { recursive: true });
fs.copyFileSync(path.join(from, 'LICENSE'), path.join(to, 'LICENSE'));
// ES modules, as in the three package itself: Vercel's function bundler would otherwise try to compile them to CommonJS.
fs.writeFileSync(path.join(to, 'package.json'), JSON.stringify({ type: 'module', private: true }) + '\n');
console.log('three.js', JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8')).version, '→ public/vendor/three');
