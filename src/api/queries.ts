import type { Store } from '../store/store.js';
import { decayedElo, type EloConfig } from '../elo/squadElo.js';
import { RATED_POOLS } from '../elo/pools.js';

/** Pool list exposed at /api/pools. */
export function poolsList(): string[] {
  return ['global', ...RATED_POOLS];
}

/** Ranked players for a pool (Elo decay applied), shared by the server + static build. */
export async function leaderboard(store: Store, pool: string, now = Date.now()) {
  const state = await store.loadEloState();
  const cfg = state.config as EloConfig;
  return Object.values(state.players)
    .map((pe) => {
      const elo = pool === 'global' ? Math.round(decayedElo(pe, now, cfg)) : Math.round((pe.pools as any)[pool] ?? NaN);
      return { eosID: pe.eosID, name: pe.name, steamID: pe.steamID, elo, games: pool === 'global' ? pe.games : (pe.poolGames as any)[pool] ?? 0 };
    })
    .filter((r) => !Number.isNaN(r.elo) && r.games > 0)
    .sort((a, b) => b.elo - a.elo);
}

/** Cross-round profile for one player. */
export async function playerProfile(store: Store, eosID: string) {
  const state = await store.loadEloState();
  const pe = state.players[eosID];
  const index = await store.loadIndex();
  const history: any[] = [];
  const agg = { kills: 0, wounds: 0, deaths: 0, revives: 0, damageInf: 0, damageVeh: 0, points: 0, rounds: 0, longestKillM: 0 };
  for (const s of index) {
    const bundle = await store.loadRound(s.id);
    if (!bundle) continue;
    const rep = bundle.report.players.find((p) => p.eosID === eosID);
    if (!rep) continue;
    const elo = bundle.eloReport.players.find((p) => p.eosID === eosID);
    agg.kills += rep.stats.kills;
    agg.wounds += rep.stats.wounds;
    agg.deaths += rep.stats.deaths;
    agg.revives += rep.stats.revivesGiven;
    agg.damageInf += rep.stats.damageInfantry;
    agg.damageVeh += rep.stats.damageVehicle;
    agg.points += rep.totalPoints;
    agg.longestKillM = Math.max(agg.longestKillM, rep.stats.longestKillM);
    agg.rounds += 1;
    history.push({
      roundId: s.id,
      mapName: s.mapName,
      layer: s.layer,
      startTime: s.startTime,
      team: rep.team,
      pool: rep.pool,
      points: rep.totalPoints,
      stats: rep.stats,
      globalDelta: elo?.globalDelta ?? 0,
      globalAfter: elo?.globalAfter ?? null
    });
  }
  history.sort((a, b) => b.startTime - a.startTime);
  return { elo: pe ?? null, aggregate: agg, history };
}
