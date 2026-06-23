/**
 * Live-tail a running Squad dedicated-server log and ingest each round as it
 * ends. Point it at the server's SquadGame.log (local path, or a file synced
 * from a remote server via rsync/SFTP) and leave it running:
 *
 *   npm run watch -- /path/to/SquadGame.log
 *   npm run watch -- --from-start /path/to/SquadGame.log   # replay existing content first
 *   npm run watch -- --poll=500 /path/to/SquadGame.log     # check for new lines every 500ms
 *
 * New rounds appear in the AAR (`npm run serve`) automatically.
 */
import { Store } from '../store/store.js';
import { LogWatcher } from '../ingest/watcher.js';

const args = process.argv.slice(2);
const fromStart = args.includes('--from-start');
const pollArg = args.find((a) => a.startsWith('--poll='));
const pollMs = pollArg ? Number(pollArg.split('=')[1]) : undefined;
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('Usage: npm run watch -- [--from-start] [--poll=<ms>] <SquadGame.log>');
  process.exit(1);
}

const store = new Store();
const watcher = new LogWatcher(file, store, {
  fromStart,
  pollMs,
  onInfo: (msg) => console.log(msg),
  onRound: (r) =>
    console.log(`  ingested ${r.id}  layer=${r.layer} players=${r.players} events=${r.events} suspicious=${r.suspicious}`)
});

process.on('SIGINT', () => {
  watcher.stop();
  console.log('\nStopped.');
  process.exit(0);
});

await watcher.start();
