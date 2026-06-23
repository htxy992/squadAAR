import type { Store } from '../store/store.js';
import { decayedElo, type EloConfig } from '../elo/squadElo.js';
import { RATED_POOLS } from '../elo/pools.js';
import { playerCqbForRound, capSample, type AimPoint, type RecoilPoint } from '../engagement/playerCqb.js';
import type { CoachingFlag } from '../engagement/types.js';

/** Max scatter points kept per player profile (bounds payload + plot density). */
const CLOUD_CAP = 280;

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

  // Cross-round CQB / aim-recoil accumulators (folds the engagement coaching layer
  // into the player profile).
  const c = {
    rounds: 0, won: 0, lost: 0, traded: 0, shots: 0, hits: 0,
    aimSum: 0, aimN: 0, biasHSum: 0, biasVSum: 0,
    spreadSum: 0, controlSum: 0, climbSum: 0, burstN: 0,
    flags: {} as Partial<Record<CoachingFlag, number>>,
  };
  const aimCloud: AimPoint[] = [];
  const recoilCloud: RecoilPoint[] = [];

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

    const rc = playerCqbForRound(bundle.engagements ?? [], bundle.bursts?.[eosID], eosID);
    const hasCqb = rc.shots > 0 || rc.burstCount > 0;
    if (hasCqb) c.rounds += 1;
    c.won += rc.won; c.lost += rc.lost; c.traded += rc.traded;
    c.shots += rc.shots; c.hits += rc.hits;
    c.aimSum += rc.aimSum; c.aimN += rc.aimPoints.length;
    c.biasHSum += rc.biasHSum; c.biasVSum += rc.biasVSum;
    c.spreadSum += rc.spreadSum; c.controlSum += rc.controlSum; c.climbSum += rc.climbSum; c.burstN += rc.burstCount;
    for (const [f, n] of Object.entries(rc.flags)) c.flags[f as CoachingFlag] = (c.flags[f as CoachingFlag] ?? 0) + (n ?? 0);
    aimCloud.push(...rc.aimPoints);
    recoilCloud.push(...rc.recoilPoints);

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
      globalAfter: elo?.globalAfter ?? null,
      cqb: hasCqb ? {
        shots: rc.shots, hits: rc.hits, won: rc.won, lost: rc.lost, traded: rc.traded,
        aimErr: rc.meanAimErrorDeg, spread: rc.meanSpreadDeg, control: rc.sprayControl,
      } : null,
    });
  }
  history.sort((a, b) => b.startTime - a.startTime);

  const cqb = {
    rounds: c.rounds,
    duels: c.won + c.lost + c.traded,
    won: c.won, lost: c.lost, traded: c.traded,
    shots: c.shots, hits: c.hits,
    hitRate: c.shots ? c.hits / c.shots : 0,
    meanAimErrorDeg: c.aimN ? c.aimSum / c.aimN : null,
    biasH: c.aimN ? c.biasHSum / c.aimN : 0,
    biasV: c.aimN ? c.biasVSum / c.aimN : 0,
    meanSpreadDeg: c.burstN ? c.spreadSum / c.burstN : null,
    sprayControl: c.burstN ? c.controlSum / c.burstN : null,
    meanClimbDeg: c.burstN ? c.climbSum / c.burstN : null,
    flags: c.flags,
    aimCloud: capSample(aimCloud, CLOUD_CAP),
    recoilCloud: capSample(recoilCloud, CLOUD_CAP),
  };

  return { elo: pe ?? null, aggregate: agg, cqb, history };
}
