import type { Vec3 } from '../parser/events.js';
export type { HitZone } from '../parser/events.js';

// ─── coaching flags ──────────────────────────────────────────────────────────

export type CoachingFlag =
  /** Loser fired the first shot but still died — TTK or damage-taken problem. */
  | 'first_blood_lost'
  /** Loser was moving (>150 cm in 2 s) when the killing shot landed. */
  | 'peek_killed'
  /** Winner stood still, loser was moving — classic pre-aim hold. */
  | 'pre_aim_advantage'
  /** Loser died from the same horizontal sector (±30°) more than once this round. */
  | 'repeated_same_angle'
  /** Killer had an ally within 30 m, but no trade was taken. */
  | 'trade_missed'
  /** Attacker pushed into 2+ defenders within 50 m. */
  | 'outnumbered_entry'
  /** TTK > 800 ms, no headshot — hit-rate or burst-discipline issue. */
  | 'long_ttk'
  /** Loser's bursts had >3° RMS angular spread. */
  | 'spray_control_poor'
  /** Loser missed the first shot of >50% of their bursts. */
  | 'first_shot_missed';

// ─── per-bullet data ─────────────────────────────────────────────────────────

export interface BulletEvent {
  /** Round-relative ms (from round startTime). */
  tMs: number;
  shooterEOSID: string;
  weapon: string;
  /** Shooter world position (cm) at moment of fire. */
  from: Vec3;
  /** Impact world position (cm). */
  to: Vec3;
  /** Normalized direction unit vector (to − from). */
  dirVec: Vec3;
  hit: boolean;
  victimEOSID?: string;
  /** From PLAYER_DAMAGED / HIT_DETAIL (if available). */
  damageDealt?: number;
  /** From HIT_DETAIL (if plugin emits it). */
  zone?: 'head' | 'torso' | 'arms' | 'legs';

  // ── burst analysis (filled by detectBursts) ──────────────────────────────
  burstId?: string;
  /** 1-based position within the burst. */
  burstIndex?: number;
  /** Horizontal angular deviation from burst[0] in degrees. */
  recoilH?: number;
  /** Vertical angular deviation from burst[0] in degrees. */
  recoilV?: number;

  // ── miss analysis (filled by enrichWithNearMiss) ─────────────────────────
  /** EOS ID of the enemy closest to the bullet's trajectory when it missed. */
  nearestEnemyEOSID?: string;
  /** Perpendicular distance from bullet ray to that enemy (cm). */
  nearestEnemyDistCm?: number;
  /** true when nearestEnemyDistCm < 120 cm — bullet was aimed at someone. */
  onTarget?: boolean;
}

// ─── burst summary ───────────────────────────────────────────────────────────

export interface BurstSummary {
  id: string;
  /** Round-relative ms of the first shot. */
  tMs: number;
  shooterEOSID: string;
  weapon: string;
  shotCount: number;
  hits: number;
  firstShotHit: boolean;
  /** hits / shotCount */
  hitRate: number;
  /** Max horizontal deviation from first shot (degrees). */
  maxRecoilH: number;
  /** Max vertical deviation from first shot (degrees). */
  maxRecoilV: number;
  /** RMS of all angular deviations — lower = tighter spray. */
  spraySpread: number;
  /** 0..1; 1 = perfect control (spraySpread ≈ 0). */
  sprayControlScore: number;
}

// ─── engagement report ───────────────────────────────────────────────────────

export interface EngagementReport {
  id: string;
  roundId: string;
  /** Round-relative ms of the first shot. */
  tMs: number;
  /** Round-relative ms of the last event. */
  endMs: number;

  // ── players ─────────────────────────────────────────────────────────────
  /** Player who initiated the fight (moved toward opponent, or fired first). */
  attackerEOSID: string;
  defenderEOSID: string;
  attackerTeam: number;
  defenderTeam: number;

  // ── geometry ────────────────────────────────────────────────────────────
  /** World position (cm) of the engagement centroid at first shot. */
  engagementPos: Vec3;
  /** Distance between the two players at first shot (cm). */
  distanceCm: number;
  /** How much the attacker closed distance in the 3 s before the fight (cm). Positive = advancing. */
  approachDeltaCm?: number;

  // ── outcome ─────────────────────────────────────────────────────────────
  outcome: 'attacker_won' | 'defender_won' | 'traded' | 'no_kill';
  killerEOSID?: string;
  killWeapon?: string;
  /** First shot → kill (ms). */
  ttkMs?: number;
  firstShooterEOSID?: string;

  // ── combat detail ────────────────────────────────────────────────────────
  attackerShots: BulletEvent[];
  defenderShots: BulletEvent[];
  attackerHits: number;
  defenderHits: number;
  attackerDamageDealt: number;
  defenderDamageDealt: number;

  // ── context ──────────────────────────────────────────────────────────────
  /** EOS IDs of attacker's allies within 50 m at engagement start. */
  nearbyTeammatesAttacker: string[];
  /** EOS IDs of defender's allies within 50 m at engagement start. */
  nearbyTeammatesDefender: string[];
  /** Killer's ally was within 30 m — trade was possible. */
  tradeOpportunity: boolean;
  /** Attacker moved >150 cm in 2 s before the first shot. */
  attackerWasMoving: boolean;
  defenderWasMoving: boolean;

  // ── coaching ─────────────────────────────────────────────────────────────
  flags: CoachingFlag[];
  flagDetails: Partial<Record<CoachingFlag, string>>;
}

// ─── position sample (used by PositionBuffer) ────────────────────────────────

export interface PositionSample {
  /** Round-relative ms. */
  tMs: number;
  /** World position (cm). */
  pos: Vec3;
  yaw: number;
  health: number;
  team: number;
  state: 'alive' | 'wound' | 'dead';
}

// ─── per-life aggregated stats ────────────────────────────────────────────────

export interface PlayerLifeStats {
  eosID: string;
  /** Round-relative ms of spawn. */
  spawnMs: number;
  deathMs?: number;
  survivalMs?: number;

  engagementsWon: number;
  engagementsLost: number;
  engagementsTraded: number;

  /** Kills at < 75 m (CQB radius). */
  cqbKills: number;
  cqbDeaths: number;
  /** Times trade_missed flag was raised against this player. */
  tradesMissed: number;

  totalShots: number;
  totalHits: number;
  headshots: number;
  hitRate: number;
  /** headshots / hits */
  headshotRate: number;
  avgBurstLength: number;
  /** Average spray control score across bursts (0..1). */
  sprayControlScore: number;
}
