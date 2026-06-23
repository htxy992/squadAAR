import type { EngagementReport, BurstSummary, CoachingFlag } from './types.js';

/** A single aim sample for the season "sight picture" scatter. */
export interface AimPoint { h: number; v: number; deg: number; hit: boolean; }
/** A single recoil sample (drift from the first shot of its burst). */
export interface RecoilPoint { recoilH: number; recoilV: number; hit: boolean; }

/** Coaching flags that describe the *loser's* mistake (attributed to the player). */
const LOSER_FLAGS: CoachingFlag[] = [
  'first_blood_lost', 'peek_killed', 'repeated_same_angle', 'trade_missed',
  'spray_control_poor', 'first_shot_missed', 'aim_off_target',
];

/** Per-round CQB summary for one player (sums kept so rounds can be merged). */
export interface RoundCqb {
  shots: number;
  hits: number;
  won: number;
  lost: number;
  traded: number;
  aimPoints: AimPoint[];
  recoilPoints: RecoilPoint[];
  aimSum: number;     // Σ aimErrorDeg over scored shots
  biasHSum: number;   // Σ aimErrorH
  biasVSum: number;   // Σ aimErrorV
  burstCount: number;
  spreadSum: number;  // Σ burst spraySpread
  controlSum: number; // Σ burst sprayControlScore
  climbSum: number;   // Σ burst maxRecoilV
  flags: Partial<Record<CoachingFlag, number>>;
  // per-round means (for the round-history row)
  meanAimErrorDeg: number | null;
  meanSpreadDeg: number | null;
  sprayControl: number | null;
}

/**
 * Aggregate one round's CQB telemetry for a single player. Aim data comes from
 * the player's engagement shots (only those carry the PlayerLook-derived aim
 * error); spray/recoil come from the player's bursts across the whole round.
 */
export function playerCqbForRound(
  engagements: EngagementReport[],
  bursts: BurstSummary[] | undefined,
  eosID: string
): RoundCqb {
  const aimPoints: AimPoint[] = [];
  const recoilPoints: RecoilPoint[] = [];
  const flags: Partial<Record<CoachingFlag, number>> = {};
  let shots = 0, hits = 0, won = 0, lost = 0, traded = 0;
  let aimSum = 0, biasHSum = 0, biasVSum = 0;

  for (const e of engagements) {
    const isAtk = e.attackerEOSID === eosID;
    const isDef = e.defenderEOSID === eosID;
    if (!isAtk && !isDef) continue;

    for (const s of isAtk ? e.attackerShots : e.defenderShots) {
      shots++;
      if (s.hit) hits++;
      recoilPoints.push({ recoilH: s.recoilH ?? 0, recoilV: s.recoilV ?? 0, hit: !!s.hit });
      if (s.aimErrorDeg != null) {
        aimPoints.push({ h: s.aimErrorH ?? 0, v: s.aimErrorV ?? 0, deg: s.aimErrorDeg, hit: !!s.hit });
        aimSum += s.aimErrorDeg;
        biasHSum += s.aimErrorH ?? 0;
        biasVSum += s.aimErrorV ?? 0;
      }
    }

    const winner = e.outcome === 'attacker_won' ? e.attackerEOSID : e.outcome === 'defender_won' ? e.defenderEOSID : null;
    const loser = e.outcome === 'attacker_won' ? e.defenderEOSID : e.outcome === 'defender_won' ? e.attackerEOSID : null;
    if (e.outcome === 'traded') traded++;
    else if (winner === eosID) won++;
    else if (loser === eosID) lost++;
    if (loser === eosID) for (const f of e.flags ?? []) if (LOSER_FLAGS.includes(f)) flags[f] = (flags[f] ?? 0) + 1;
  }

  const myBursts = bursts ?? [];
  const burstCount = myBursts.length;
  const spreadSum = myBursts.reduce((a, b) => a + b.spraySpread, 0);
  const controlSum = myBursts.reduce((a, b) => a + b.sprayControlScore, 0);
  const climbSum = myBursts.reduce((a, b) => a + b.maxRecoilV, 0);

  return {
    shots, hits, won, lost, traded,
    aimPoints, recoilPoints, aimSum, biasHSum, biasVSum,
    burstCount, spreadSum, controlSum, climbSum, flags,
    meanAimErrorDeg: aimPoints.length ? aimSum / aimPoints.length : null,
    meanSpreadDeg: burstCount ? spreadSum / burstCount : null,
    sprayControl: burstCount ? controlSum / burstCount : null,
  };
}

/** Evenly downsample an array to at most `n` items (keeps plots/payload bounded). */
export function capSample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}
