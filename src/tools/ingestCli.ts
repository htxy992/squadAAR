/**
 * Ingest one or more Squad server logs into the AAR store.
 *
 *   npm run ingest -- path/to/SquadGame.log [more.log ...]
 *   npm run ingest -- --reset path/to/SquadGame.log
 */
import { Store } from '../store/store.js';
import { ingestFiles } from '../ingest/ingest.js';

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const files = args.filter((a) => !a.startsWith('--'));

if (!files.length) {
  console.error('Usage: npm run ingest -- [--reset] <log file> [more logs...]');
  process.exit(1);
}

const store = new Store();
await store.init();
if (reset) {
  await store.reset();
  console.log('Store reset.');
}

const results = await ingestFiles(files, store);
for (const r of results) {
  console.log(`\n${r.file}`);
  if (!r.rounds.length) console.log('  (no complete rounds found)');
  for (const round of r.rounds) {
    console.log(`  - ${round.id}  layer=${round.layer} players=${round.players} events=${round.events} suspicious=${round.suspicious}`);
  }
}
console.log('\nDone.');
