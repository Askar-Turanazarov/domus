// Generates buildings/chinor-park.json: the demo 12-storey building for the showcase (see public/js/building.js).
// Run: node scripts/gen-building.mjs
import fs from 'node:fs';
import { generateBuilding } from '../public/js/building.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../catalog.json', import.meta.url), 'utf8')).items;
const b = generateBuilding({ catalog });
const dir = new URL('../buildings/', import.meta.url);
fs.mkdirSync(dir, { recursive: true });
const json = JSON.stringify(b);
fs.writeFileSync(new URL(b.id + '.json', dir), json + '\n');
const apts = b.floorsData.flatMap(f => f.apartments);
const by = k => Object.entries(apts.reduce((m, a) => ({ ...m, [a[k]]: (m[a[k]] || 0) + 1 }), {})).map(e => e.join(': ')).join(', ');
console.log(`${b.id}: ${apts.length} apartments (${by('type')}), ${by('status')}, ${(json.length / 1e6).toFixed(2)} MB`);
