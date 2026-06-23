import type { DeathReport } from '../timeline/types.js';
import type { RoundPlayer } from '../timeline/types.js';
import type { BulletEvent, EngagementReport } from './types.js';
import type { PositionBuffer } from './positionBuffer.js';

/** Maximum distance between players to be considered a CQB engagement (cm = 75 m). */
const CQB_RADIUS_CM = 7_500;
/** Close an open engagement after this many ms with no shots between the pair. */
const ENGAGEMENT_TIMEOUT_MS = 15_000;
/** Trade-opportunity check radius around the killer (cm = 30 m). */
const TRADE_RADIUS_CM = 3_000;
/** "Outnumbered" check radius around each player (cm = 50 m). */
const NEARBY_RADIUS_CM = 5_000;
/** Window before the engagement to check for movement (ms). */
const APPROACH_WINDOW_MS = 3_000;
/** Minimum movement to count as "the player was moving" (cm). */
const MOVING_MIN_DIST_CM = 150;
/** Grace period after the last shot to match a death to an engagement (ms). */
const DEATH_GRACE_MS = 5_000;
/** Gap between kill and retaliatory kill to count as a trade (ms). */
const TRADE_GAP_MS = 5_000;

let _engSeq = 0;
function nextId(): string { return `eng-${++_engSeq}`; }

interface OpenEng {
  id: string;
  attackerEOSID: string;
  defenderEOSID: string;
  attackerTeam: number;
  defenderTeam: number;
  startMs: number;
  lastEventMs: number;
  firstShooterEOSID: string;
  attackerShots: BulletEvent[];
  defenderShots: BulletEvent[];
}

/** Canonical pair key (order-independent). */
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Detect 1v1 CQB engagements from bullet events and finalize each one with
 * outcome, context, and raw coaching fields (flags filled later by coaching.ts).
 */
export function buildEngagements(
  bullets: BulletEvent[],
  deaths: DeathReport[],
  posBuffer: PositionBuffer,
  players: Record<string, RoundPlayer>,
  roundId: string
): EngagementReport[] {
  // Build team lookup once
  const teamOf = new Map<string, number>();
  for (const [eos, p] of Object.entries(players)) teamOf.set(eos, p.team);

  const open = new Map<string, OpenEng>();
  const closed: EngagementReport[] = [];

  const close = (eng: OpenEng): void => {
    closed.push(finalizeEngagement(eng, deaths, posBuffer, teamOf, roundId));
    open.delete(pairKey(eng.attackerEOSID, eng.defenderEOSID));
  };

  for (const bullet of bullets) {
    // Expire stale open engagements
    for (const eng of [...open.values()]) {
      if (bullet.tMs - eng.lastEventMs > ENGAGEMENT_TIMEOUT_MS) close(eng);
    }

    if (!bullet.shooterEOSID) continue;
    const shooterTeam = teamOf.get(bullet.shooterEOSID);
    if (shooterTeam == null) continue;

    // Identify opponent: explicit hit target, or nearest enemy from near-miss enrichment
    const opponentEOS = bullet.hit ? bullet.victimEOSID : bullet.nearestEnemyEOSID;
    if (!opponentEOS) continue;
    const opponentTeam = teamOf.get(opponentEOS);
    if (opponentTeam == null || opponentTeam === shooterTeam) continue;

    // Proximity guard (skip if farther than CQB radius)
    const selfSample = posBuffer.atTime(bullet.shooterEOSID, bullet.tMs);
    const oppSample = posBuffer.atTime(opponentEOS, bullet.tMs);
    if (selfSample && oppSample) {
      const d = Math.hypot(selfSample.pos.x - oppSample.pos.x, selfSample.pos.y - oppSample.pos.y);
      if (d > CQB_RADIUS_CM) continue;
    }

    const key = pairKey(bullet.shooterEOSID, opponentEOS);
    let eng = open.get(key);

    if (!eng) {
      const [atk, def] = pickAttackerDefender(bullet.shooterEOSID, opponentEOS, bullet.tMs, posBuffer);
      eng = {
        id: nextId(),
        attackerEOSID: atk,
        defenderEOSID: def,
        attackerTeam: teamOf.get(atk) ?? shooterTeam,
        defenderTeam: teamOf.get(def) ?? opponentTeam,
        startMs: bullet.tMs,
        lastEventMs: bullet.tMs,
        firstShooterEOSID: bullet.shooterEOSID,
        attackerShots: [],
        defenderShots: []
      };
      open.set(key, eng);
    }

    eng.lastEventMs = bullet.tMs;
    if (bullet.shooterEOSID === eng.attackerEOSID) {
      eng.attackerShots.push(bullet);
    } else {
      eng.defenderShots.push(bullet);
    }
  }

  for (const eng of open.values()) close(eng);

  return closed;
}

// ─── attacker/defender heuristic ────────────────────────────────────────────

function pickAttackerDefender(
  shooterEOS: string,
  opponentEOS: string,
  tMs: number,
  posBuffer: PositionBuffer
): [string, string] {
  // Attacker = whoever closed distance more in the approach window
  const sEarly = posBuffer.atTime(shooterEOS, tMs - APPROACH_WINDOW_MS);
  const sNow = posBuffer.atTime(shooterEOS, tMs);
  const oEarly = posBuffer.atTime(opponentEOS, tMs - APPROACH_WINDOW_MS);
  const oNow = posBuffer.atTime(opponentEOS, tMs);

  if (!sEarly || !sNow || !oEarly || !oNow) return [shooterEOS, opponentEOS];

  const distBefore = Math.hypot(sEarly.pos.x - oEarly.pos.x, sEarly.pos.y - oEarly.pos.y);
  const distNow = Math.hypot(sNow.pos.x - oNow.pos.x, sNow.pos.y - oNow.pos.y);
  const closing = distBefore - distNow; // positive = gap shrinking

  // Shooter moved toward opponent more than opponent moved
  const shooterMove = Math.hypot(sNow.pos.x - sEarly.pos.x, sNow.pos.y - sEarly.pos.y);
  const oppMove = Math.hypot(oNow.pos.x - oEarly.pos.x, oNow.pos.y - oEarly.pos.y);

  if (closing > 0 && shooterMove >= oppMove) return [shooterEOS, opponentEOS];
  if (closing < 0 || oppMove > shooterMove) return [opponentEOS, shooterEOS];
  return [shooterEOS, opponentEOS]; // default: shooter is attacker
}

// ─── finalization ────────────────────────────────────────────────────────────

function finalizeEngagement(
  eng: OpenEng,
  deaths: DeathReport[],
  posBuffer: PositionBuffer,
  teamOf: Map<string, number>,
  roundId: string
): EngagementReport {
  const endMs = eng.lastEventMs;

  // Match deaths to this engagement window
  const relevant = deaths.filter(
    d =>
      d.tMs >= eng.startMs &&
      d.tMs <= endMs + DEATH_GRACE_MS &&
      (d.victimEOSID === eng.attackerEOSID || d.victimEOSID === eng.defenderEOSID)
  );
  const primaryDeath = relevant[0];

  let outcome: EngagementReport['outcome'] = 'no_kill';
  let killerEOSID: string | undefined;
  let killWeapon: string | undefined;
  let ttkMs: number | undefined;

  if (primaryDeath) {
    killerEOSID = primaryDeath.killerEOSID;
    killWeapon = primaryDeath.weapon;
    ttkMs = Math.max(0, primaryDeath.tMs - eng.startMs);

    // Trade: did the killer also die within TRADE_GAP_MS?
    const traded = killerEOSID
      ? relevant.some(
          d => d.victimEOSID === killerEOSID && d.tMs > primaryDeath.tMs && d.tMs <= primaryDeath.tMs + TRADE_GAP_MS
        )
      : false;

    if (traded) {
      outcome = 'traded';
    } else if (primaryDeath.victimEOSID === eng.defenderEOSID) {
      outcome = 'attacker_won';
    } else {
      outcome = 'defender_won';
    }
  }

  // Geometry at engagement start
  const atkPos = posBuffer.atTime(eng.attackerEOSID, eng.startMs);
  const defPos = posBuffer.atTime(eng.defenderEOSID, eng.startMs);

  const engagementPos = atkPos?.pos ?? { x: 0, y: 0, z: 0 };
  const distanceCm =
    atkPos && defPos
      ? Math.hypot(atkPos.pos.x - defPos.pos.x, atkPos.pos.y - defPos.pos.y)
      : 0;

  // Approach delta (how much attacker closed in approach window)
  const atkEarly = posBuffer.atTime(eng.attackerEOSID, eng.startMs - APPROACH_WINDOW_MS);
  const defEarly = posBuffer.atTime(eng.defenderEOSID, eng.startMs - APPROACH_WINDOW_MS);
  let approachDeltaCm: number | undefined;
  if (atkEarly && defEarly && atkPos && defPos) {
    const dBefore = Math.hypot(atkEarly.pos.x - defEarly.pos.x, atkEarly.pos.y - defEarly.pos.y);
    approachDeltaCm = dBefore - distanceCm;
  }

  // Context
  const atkAllies = posBuffer.nearbyAllies(eng.attackerEOSID, eng.startMs, NEARBY_RADIUS_CM);
  const defAllies = posBuffer.nearbyAllies(eng.defenderEOSID, eng.startMs, NEARBY_RADIUS_CM);

  let tradeOpportunity = false;
  if (primaryDeath && killerEOSID) {
    const killerAllies = posBuffer.nearbyAllies(killerEOSID, primaryDeath.tMs, TRADE_RADIUS_CM);
    tradeOpportunity = killerAllies.length > 0;
  }

  const attackerWasMoving = posBuffer.wasMoving(eng.attackerEOSID, eng.startMs, APPROACH_WINDOW_MS, MOVING_MIN_DIST_CM);
  const defenderWasMoving = posBuffer.wasMoving(eng.defenderEOSID, eng.startMs, APPROACH_WINDOW_MS, MOVING_MIN_DIST_CM);

  // Shot totals
  const attackerHits = eng.attackerShots.filter(b => b.hit).length;
  const defenderHits = eng.defenderShots.filter(b => b.hit).length;
  const attackerDamageDealt = eng.attackerShots.reduce((s, b) => s + (b.damageDealt ?? 0), 0);
  const defenderDamageDealt = eng.defenderShots.reduce((s, b) => s + (b.damageDealt ?? 0), 0);

  return {
    id: eng.id,
    roundId,
    tMs: eng.startMs,
    endMs,
    attackerEOSID: eng.attackerEOSID,
    defenderEOSID: eng.defenderEOSID,
    attackerTeam: eng.attackerTeam,
    defenderTeam: eng.defenderTeam,
    engagementPos,
    distanceCm,
    approachDeltaCm,
    outcome,
    killerEOSID,
    killWeapon,
    ttkMs,
    firstShooterEOSID: eng.firstShooterEOSID,
    attackerShots: eng.attackerShots,
    defenderShots: eng.defenderShots,
    attackerHits,
    defenderHits,
    attackerDamageDealt,
    defenderDamageDealt,
    nearbyTeammatesAttacker: atkAllies.map(a => a.eosID),
    nearbyTeammatesDefender: defAllies.map(a => a.eosID),
    tradeOpportunity,
    attackerWasMoving,
    defenderWasMoving,
    flags: [],
    flagDetails: {}
  };
}
