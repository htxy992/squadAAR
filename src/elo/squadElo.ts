import type { RoundReport, PlayerPointReport } from '../points/types.js';
import { RATED_POOLS, POOL_STATS, type RatedPool } from './pools.js';

/**
 * SquadElo — documentation chapter 4.
 *
 * A round is treated as a free-for-all: within each class/vehicle pool every
 * player is compared against every other player who played that pool (regardless
 * of team), using the SquadPoints metric. A separate "global" Elo compares all
 * players using standardized (z-scored) points across pools. The Margin-of-
 * Victory multiplier (MoVM) scales each pairwise update by team-skill gap.
 */

export interface EloConfig {
  /** Elo scaling constant K (doc suggests ~40). */
  K: number;
  KGlobal: number;
  startElo: number;
  /** minimum ms in a pool to receive a pool rating that round */
  minPoolTimeMs: number;
  /** decay half-life in ms (doc: 30 days) */
  decayHalfLifeMs: number;
  decayFloor: number;
}

export const DEFAULT_ELO_CONFIG: EloConfig = {
  K: 40,
  KGlobal: 32,
  startElo: 1000,
  minPoolTimeMs: 60_000,
  decayHalfLifeMs: 30 * 24 * 60 * 60 * 1000,
  decayFloor: 1000
};

export interface PlayerElo {
  eosID: string;
  steamID?: string;
  name: string;
  global: number;
  pools: Partial<Record<RatedPool, number>>;
  games: number;
  poolGames: Partial<Record<RatedPool, number>>;
  lastPlayedMs: number;
}

export interface EloState {
  players: Record<string, PlayerElo>;
  config: EloConfig;
}

export function newEloState(config: EloConfig = DEFAULT_ELO_CONFIG): EloState {
  return { players: {}, config };
}

function ensurePlayer(state: EloState, p: { eosID: string; name: string; steamID?: string }): PlayerElo {
  let pe = state.players[p.eosID];
  if (!pe) {
    pe = {
      eosID: p.eosID,
      steamID: p.steamID,
      name: p.name,
      global: state.config.startElo,
      pools: {},
      games: 0,
      poolGames: {},
      lastPlayedMs: 0
    };
    state.players[p.eosID] = pe;
  }
  if (p.name) pe.name = p.name;
  if (p.steamID) pe.steamID = p.steamID;
  return pe;
}

/** Expected score / win-probability of A vs B from Elo difference (eq. 4). */
export function expectedScore(eA: number, eB: number): number {
  return 1 / (1 + Math.pow(10, (eB - eA) / 400));
}

/** Heaviside step (eq. 8). */
function heaviside(x: number): number {
  return x > 0 ? 1 : x === 0 ? 0.5 : 0;
}

/** Margin-of-Victory multiplier (eq. 9). */
function movm(p: number, pj: number, eloWinner: number, eloLoser: number): number {
  const denom = Math.max(0.2, 2.2 + 1e-3 * (eloWinner - eloLoser));
  return Math.log(Math.abs(p - pj) + 1) * (2.2 / denom);
}

export interface PoolEloDelta {
  before: number;
  after: number;
  delta: number;
  points: number;
}
export interface PlayerEloReport {
  eosID: string;
  name: string;
  team: number;
  globalBefore: number;
  globalAfter: number;
  globalDelta: number;
  pools: Partial<Record<RatedPool, PoolEloDelta>>;
}
export interface RoundEloReport {
  roundId: string;
  players: PlayerEloReport[];
}

interface Participant {
  rep: PlayerPointReport;
  pe: PlayerElo;
}

/** Average pool Elo (fallback global) of a team's rated participants. */
function teamElo(parts: Participant[], team: number, pool: RatedPool | 'global'): number {
  const xs = parts
    .filter((p) => p.rep.team === team)
    .map((p) => (pool === 'global' ? p.pe.global : p.pe.pools[pool] ?? p.pe.global));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : DEFAULT_ELO_CONFIG.startElo;
}

/**
 * Process one round's point report, updating Elo state in place and returning a
 * per-player Elo report (before/after/delta for global + each pool).
 */
export function processRound(report: RoundReport, state: EloState): RoundEloReport {
  const cfg = state.config;
  const winner = report.global.winnerTeam;
  const loser = winner ? (winner === 1 ? 2 : 1) : undefined;
  const roundTime = report.global.startTime + report.global.durationMs;

  const participants: Participant[] = report.players.map((rep) => ({ rep, pe: ensurePlayer(state, rep) }));

  const reports = new Map<string, PlayerEloReport>();
  for (const { rep, pe } of participants) {
    reports.set(rep.eosID, {
      eosID: rep.eosID,
      name: rep.name,
      team: rep.team,
      globalBefore: pe.global,
      globalAfter: pe.global,
      globalDelta: 0,
      pools: {}
    });
  }

  const teamEloFor = (pool: RatedPool | 'global') => ({
    win: winner ? teamElo(participants, winner, pool) : 0,
    lose: loser ? teamElo(participants, loser, pool) : 0
  });

  // ---- per-pool ratings --------------------------------------------------
  for (const pool of RATED_POOLS) {
    const inPool = participants.filter(
      (p) => (p.rep.poolPoints[pool] ?? undefined) !== undefined && (p.rep.poolTimeMs[pool] ?? 0) >= cfg.minPoolTimeMs
    );
    if (inPool.length < 2) continue;
    const { win, lose } = teamEloFor(pool);
    const deltas = new Map<string, number>();
    for (const a of inPool) {
      const Ea = a.pe.pools[pool] ?? cfg.startElo;
      const pa = a.rep.poolPoints[pool] ?? 0;
      let sum = 0;
      for (const b of inPool) {
        if (a === b) continue;
        const Eb = b.pe.pools[pool] ?? cfg.startElo;
        const pb = b.rep.poolPoints[pool] ?? 0;
        const term = heaviside(pa - pb) - 1 / (1 + Math.pow(10, (Eb - Ea) / 400));
        sum += term * movm(pa, pb, win || Ea, lose || Ea);
      }
      deltas.set(a.rep.eosID, (cfg.K * sum) / Math.max(1, inPool.length - 1));
    }
    for (const a of inPool) {
      const before = a.pe.pools[pool] ?? cfg.startElo;
      const delta = deltas.get(a.rep.eosID) ?? 0;
      const after = before + delta;
      a.pe.pools[pool] = after;
      a.pe.poolGames[pool] = (a.pe.poolGames[pool] ?? 0) + 1;
      reports.get(a.rep.eosID)!.pools[pool] = { before: r2(before), after: r2(after), delta: r2(delta), points: a.rep.poolPoints[pool] ?? 0 };
    }
  }

  // ---- global rating (standardized points) ------------------------------
  const standardized = (rep: PlayerPointReport): number => {
    let Q = 0;
    let any = false;
    for (const pool of RATED_POOLS) {
      const p = rep.poolPoints[pool];
      if (p === undefined) continue;
      if ((rep.poolTimeMs[pool] ?? 0) < cfg.minPoolTimeMs) continue;
      const { mean, std } = POOL_STATS[pool];
      Q += (p - mean) / (std || 1);
      any = true;
    }
    return any ? Q : NaN;
  };
  const globalParts = participants
    .map((p) => ({ ...p, Q: standardized(p.rep) }))
    .filter((p) => !Number.isNaN(p.Q));
  if (globalParts.length >= 2) {
    const { win, lose } = teamEloFor('global');
    const deltas = new Map<string, number>();
    for (const a of globalParts) {
      const Ea = a.pe.global;
      let sum = 0;
      for (const b of globalParts) {
        if (a === b) continue;
        const Eb = b.pe.global;
        const term = heaviside(a.Q - b.Q) - 1 / (1 + Math.pow(10, (Eb - Ea) / 400));
        sum += term * movm(a.Q, b.Q, win || Ea, lose || Ea);
      }
      deltas.set(a.rep.eosID, (cfg.KGlobal * sum) / Math.max(1, globalParts.length - 1));
    }
    for (const a of globalParts) {
      const before = a.pe.global;
      const delta = deltas.get(a.rep.eosID) ?? 0;
      a.pe.global = before + delta;
      a.pe.games += 1;
      a.pe.lastPlayedMs = roundTime;
      const r = reports.get(a.rep.eosID)!;
      r.globalAfter = r2(a.pe.global);
      r.globalDelta = r2(delta);
    }
  }
  // mark lastPlayed for everyone who participated even if unrated globally
  for (const { pe } of participants) pe.lastPlayedMs = Math.max(pe.lastPlayedMs, roundTime);

  return { roundId: report.global.roundId, players: [...reports.values()] };
}

/** Apply Elo decay (eq. 13) for inactive players above the floor. Returns a copy. */
export function decayedElo(pe: PlayerElo, nowMs: number, cfg: EloConfig): number {
  if (pe.global < cfg.decayFloor || !pe.lastPlayedMs) return pe.global;
  const dt = nowMs - pe.lastPlayedMs;
  if (dt <= 0) return pe.global;
  const tau = cfg.decayHalfLifeMs / Math.log(2); // so that ~halves over halfLife... use exp decay toward floor
  const decayed = cfg.decayFloor + (pe.global - cfg.decayFloor) * Math.exp(-dt / tau);
  return decayed;
}

/* ----------------------------- team balance ------------------------------ */

export interface TeamBalanceSide {
  avg_elo: number;
  elo_std: number;
  win_chance: number;
  win_chance_error: number;
  valid_players: number;
}
export interface TeamBalance {
  team1: TeamBalanceSide;
  team2: TeamBalanceSide;
  serverwide_avg_elo: number;
}

/**
 * Server-balance info for a round (Abbildung 11): per-team average Elo, spread,
 * and win probability from the classic Elo formula on team averages (eq. 15).
 * Uses each player's current pool Elo (fallback global).
 */
export function computeBalance(report: RoundReport, state: EloState): TeamBalance {
  const sides: Record<number, number[]> = { 1: [], 2: [] };
  for (const rep of report.players) {
    const pe = state.players[rep.eosID];
    if (!pe) continue;
    const pool = rep.pool as RatedPool;
    const elo = (pool && pe.pools[pool] != null) ? pe.pools[pool]! : pe.global;
    if (rep.team === 1 || rep.team === 2) sides[rep.team].push(elo);
  }
  const summarize = (xs: number[]): { avg: number; std: number } => {
    if (!xs.length) return { avg: state.config.startElo, std: 0 };
    const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
    const std = Math.sqrt(xs.reduce((a, b) => a + (b - avg) ** 2, 0) / xs.length);
    return { avg, std };
  };
  const s1 = summarize(sides[1]);
  const s2 = summarize(sides[2]);
  const win1 = expectedScore(s1.avg, s2.avg);
  const err = (std: number, n: number) => (n ? std / Math.sqrt(n) / 400 : 0.25);
  return {
    team1: { avg_elo: r2(s1.avg), elo_std: r2(s1.std), win_chance: r2(win1), win_chance_error: r2(err(s1.std, sides[1].length)), valid_players: sides[1].length },
    team2: { avg_elo: r2(s2.avg), elo_std: r2(s2.std), win_chance: r2(1 - win1), win_chance_error: r2(err(s2.std, sides[2].length)), valid_players: sides[2].length },
    serverwide_avg_elo: r2(((s1.avg * sides[1].length + s2.avg * sides[2].length) || state.config.startElo) / Math.max(1, sides[1].length + sides[2].length))
  };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
