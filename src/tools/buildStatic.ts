/**
 * Build a fully static demo site into ./dist (no server needed).
 *
 * Runs the pipeline on the generated sample log + DEM, then writes the API
 * responses as static files mirroring the live routes:
 *   api/rounds            api/rounds/<id>      api/pools
 *   api/leaderboard/<pool>  api/players/<eos>
 * The web app (relative paths) is copied over it, so it works on GitHub Pages
 * under /<repo>/. Used by .github/workflows/pages.yml.
 *
 *   npm run build:static
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Store } from '../store/store.js';
import { ingestFiles } from '../ingest/ingest.js';
import { writeSampleLog } from './generateSampleLog.js';
import { writeSampleHeightmap } from './genSampleHeightmap.js';
import { leaderboard, playerProfile, poolsList } from '../api/queries.js';

const DIST = path.resolve(process.cwd(), 'dist');
const WEB = path.resolve(process.cwd(), 'web');

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_');
}
async function writeJSON(rel: string, data: unknown) {
  const file = path.join(DIST, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
}

const store = new Store();
await store.reset();

console.log('• generating sample server log + DEM…');
const log = await writeSampleLog();
await writeSampleHeightmap();

console.log('• ingesting (parse → points → elo)…');
await ingestFiles([log], store);

console.log('• copying web app → dist…');
await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true });
await fs.cp(WEB, DIST, { recursive: true });
await fs.writeFile(path.join(DIST, '.nojekyll'), ''); // serve files verbatim on Pages

console.log('• exporting static API…');
const index = await store.loadIndex();
await writeJSON('api/rounds', index);
await writeJSON('api/pools', poolsList());

const eosSet = new Set<string>();
for (const summary of index) {
  const bundle = await store.loadRound(summary.id);
  if (!bundle) continue;
  await writeJSON(`api/round/${safeId(summary.id)}`, bundle);
  for (const p of bundle.report.players) eosSet.add(p.eosID);
}

for (const pool of poolsList()) {
  await writeJSON(`api/leaderboard/${pool}`, { pool, rows: await leaderboard(store, pool) });
}

for (const eos of eosSet) {
  await writeJSON(`api/players/${eos}`, await playerProfile(store, eos));
}

console.log(`✓ static site built in ${DIST}`);
console.log(`  rounds=${index.length} players=${eosSet.size} pools=${poolsList().length}`);
