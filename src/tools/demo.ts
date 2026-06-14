/**
 * One-shot demo: reset store, generate a sample server log, ingest it, and
 * print a summary (round result, top SquadPoints, top Elo movers, suspicious
 * shots, team balance). Then start the web server with `npm run serve`.
 */
import { Store } from '../store/store.js';
import { ingestFiles } from '../ingest/ingest.js';
import { writeSampleLog } from './generateSampleLog.js';

const store = new Store();
await store.reset();

console.log('Generating sample server log…');
const log = await writeSampleLog();
console.log('  ->', log);

console.log('Ingesting (parse -> timeline -> SquadPoints -> SquadElo)…');
await ingestFiles([log], store);

const index = await store.loadIndex();
if (!index.length) {
  console.error('No rounds ingested.');
  process.exit(1);
}
const bundle = await store.loadRound(index[0].id);
if (!bundle) process.exit(1);

const m = bundle.meta;
console.log(`\n=== ${m.mapName} (${m.layer}) ===`);
console.log(`Duration ${(m.durationMs / 60000).toFixed(1)} min | players ${m.playerCount} | winner Team ${m.winnerTeam} (${m.factions[m.winnerTeam ?? 0] ?? '?'})`);
console.log(`Final tickets:`, m.finalTickets);

console.log('\nTop 8 by SquadPoints:');
for (const p of bundle.report.players.slice(0, 8)) {
  const elo = bundle.eloReport.players.find((e) => e.eosID === p.eosID);
  console.log(
    `  ${p.name.padEnd(14)} T${p.team} ${String(p.pool).padEnd(10)} ${p.totalPoints.toFixed(1).padStart(6)} pts | ` +
      `K/W/D ${p.stats.kills}/${p.stats.wounds}/${p.stats.deaths} rev ${p.stats.revivesGiven} | ` +
      `globalElo ${elo ? `${elo.globalAfter} (${elo.globalDelta >= 0 ? '+' : ''}${elo.globalDelta})` : '-'}`
  );
}

console.log('\nTeam balance (pre-round prediction):');
console.log('  team1', bundle.balance.team1);
console.log('  team2', bundle.balance.team2);

console.log(`\nProjectile analysis: ${bundle.analysis.projectiles.length} shots, ${bundle.analysis.suspicious.length} flagged (terrain coverage ${(bundle.analysis.terrainCoverage * 100).toFixed(0)}%).`);
for (const s of bundle.analysis.suspicious.slice(0, 6)) {
  console.log(`  [${(s.tMs / 60000).toFixed(1)}m] ${s.shooterName ?? '?'} ${s.weaponFamily} ${s.rangeM.toFixed(0)}m score=${s.plausibility.score.toFixed(2)} :: ${s.plausibility.flags.join('; ')}`);
}
if (bundle.analysis.playerSuspicion.length) {
  console.log('\nPlayers flagged by Auto-Mod heuristics:');
  for (const ps of bundle.analysis.playerSuspicion.slice(0, 5)) {
    console.log(`  ${ps.name}: ${ps.suspiciousShots}/${ps.shots} suspicious (min score ${ps.minScore.toFixed(2)}) — ${ps.flags.join('; ')}`);
  }
}

console.log('\nNow run:  npm run serve   then open http://localhost:8787');
