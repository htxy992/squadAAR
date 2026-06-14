/**
 * Fetch real Squad minimap (and optional heightmap) images so the AAR renders
 * maps like SquadCalc. These are Offworld Industries game assets, so they are
 * NOT committed — you fetch them locally on demand.
 *
 *   npm run fetch:maps                 # all known maps, basemap only
 *   npm run fetch:maps -- harju narva  # specific maps
 *   SQUAD_MAP_ASSET_BASE=<url> npm run fetch:maps
 *
 * Default source is SquadCalc's published asset path
 * (`/img/maps/<key>/basemap.webp`). Override with SQUAD_MAP_ASSET_BASE to point
 * at your own mirror. Files land in web/assets/maps/<key>/.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAPS } from '../maps/mapRegistry.js';

const BASE = process.env.SQUAD_MAP_ASSET_BASE ?? 'https://squadcalc.app/img/maps';
const OUT = path.resolve(process.cwd(), 'web/assets/maps');
const FILES = ['basemap.webp', ...(process.env.FETCH_HEIGHTMAPS ? ['terrainmap.webp'] : [])];

const wanted = process.argv.slice(2).map((s) => s.toLowerCase());
const maps = MAPS.filter((m) => m.assetKey && (!wanted.length || wanted.includes(m.assetKey) || wanted.includes(m.name.toLowerCase())));

async function download(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`  ✗ ${url} -> HTTP ${res.status}`);
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
    console.log(`  ✓ ${path.relative(process.cwd(), dest)} (${(buf.length / 1024).toFixed(0)} KB)`);
    return true;
  } catch (e) {
    console.log(`  ✗ ${url} -> ${(e as Error).message}`);
    return false;
  }
}

console.log(`Fetching ${maps.length} map(s) from ${BASE}`);
let ok = 0;
for (const m of maps) {
  for (const f of FILES) {
    if (await download(`${BASE}/${m.assetKey}/${f}`, path.join(OUT, m.assetKey, f))) ok++;
  }
}
console.log(`Done. ${ok} file(s) fetched into web/assets/maps/.`);
if (!ok) console.log('No files fetched — set SQUAD_MAP_ASSET_BASE to a reachable mirror. The AAR still renders reconstructed terrain without these.');
