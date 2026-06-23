import type { TimelineEvent } from '../parser/events.js';
import type { BulletEvent, BurstSummary } from './types.js';
import type { PositionBuffer } from './positionBuffer.js';

/** Two shots from the same shooter within this interval are in the same burst. */
const BURST_GAP_MS = 200;
/** Bullet passes "on target" if the perpendicular distance to any enemy is below this (cm). */
const ON_TARGET_THRESHOLD_CM = 120;
/** Spray spread that maps to sprayControlScore = 0 (worst). */
const MAX_SPREAD_DEG = 5;
/** How long after a PROJECTILE to look for a matching HIT_DETAIL event (ms). */
const HIT_DETAIL_WINDOW_MS = 500;

let _burstSeq = 0;
function nextBurstId(): string { return `b${++_burstSeq}`; }

// ─── bullet construction ─────────────────────────────────────────────────────

/**
 * Build a flat list of BulletEvents from PROJECTILE events in one round.
 * `startTimeMs` is the absolute epoch-ms of the round's NEW_GAME event, used
 * to convert event.time → round-relative tMs.
 *
 * HIT_DETAIL events (if present) are correlated by time to fill zone + damage.
 */
export function buildBulletEvents(events: TimelineEvent[], startTimeMs: number): BulletEvent[] {
  // Index HIT_DETAIL events by "attacker|victim" for fast lookup
  const hitDetails = new Map<string, Array<{ tMs: number; dmg: number; zone: BulletEvent['zone'] }>>();
  // Index PLAYER_DAMAGED for damage amounts when HIT_DETAIL is absent
  const dmgEvents = new Map<string, Array<{ tMs: number; dmg: number }>>();

  for (const e of events) {
    if (e.type === 'HIT_DETAIL') {
      const key = `${e.attackerEOSID}|${e.victimEOSID}`;
      const arr = hitDetails.get(key) ?? [];
      arr.push({ tMs: e.time - startTimeMs, dmg: e.damage, zone: e.zone });
      hitDetails.set(key, arr);
    } else if (e.type === 'PLAYER_DAMAGED' && e.attackerEOSID) {
      const key = `${e.attackerEOSID}|${e.victimName}`;
      const arr = dmgEvents.get(key) ?? [];
      arr.push({ tMs: e.time - startTimeMs, dmg: e.damage });
      dmgEvents.set(key, arr);
    }
  }

  const bullets: BulletEvent[] = [];

  for (const e of events) {
    if (e.type !== 'PROJECTILE' || !e.shooterEOSID) continue;

    const tMs = e.time - startTimeMs;
    const dx = e.to.x - e.from.x;
    const dy = e.to.y - e.from.y;
    const dz = e.to.z - e.from.z;
    const len = Math.hypot(dx, dy, dz) || 1;

    let damageDealt: number | undefined;
    let zone: BulletEvent['zone'];

    if (e.hit && e.victimEOSID) {
      const key = `${e.shooterEOSID}|${e.victimEOSID}`;
      const hd = hitDetails.get(key);
      if (hd) {
        const match = hd.find(d => Math.abs(d.tMs - tMs) < HIT_DETAIL_WINDOW_MS);
        if (match) { damageDealt = match.dmg; zone = match.zone; }
      }
    }

    bullets.push({
      tMs,
      shooterEOSID: e.shooterEOSID,
      weapon: e.weapon,
      from: e.from,
      to: e.to,
      dirVec: { x: dx / len, y: dy / len, z: dz / len },
      hit: e.hit,
      victimEOSID: e.victimEOSID,
      damageDealt,
      zone
    });
  }

  bullets.sort((a, b) => a.tMs - b.tMs);
  return bullets;
}

// ─── burst detection ─────────────────────────────────────────────────────────

/**
 * Group bullets into bursts (inter-shot gap < BURST_GAP_MS, same shooter).
 * Fills `burstId`, `burstIndex`, `recoilH`, `recoilV` on each bullet in-place.
 * Returns a Map of shooterEOSID → BurstSummary[].
 */
export function detectBursts(bullets: BulletEvent[]): Map<string, BurstSummary[]> {
  // Group by shooter, preserving time order
  const byShooter = new Map<string, BulletEvent[]>();
  for (const b of bullets) {
    const arr = byShooter.get(b.shooterEOSID) ?? [];
    arr.push(b);
    byShooter.set(b.shooterEOSID, arr);
  }

  const result = new Map<string, BurstSummary[]>();

  for (const [shooterEOSID, shots] of byShooter) {
    const bursts: BurstSummary[] = [];
    let i = 0;

    while (i < shots.length) {
      const id = nextBurstId();
      const first = shots[i];
      first.burstId = id;
      first.burstIndex = 1;
      first.recoilH = 0;
      first.recoilV = 0;

      const baseYaw = vec2yaw(first.dirVec);
      const basePitch = vec2pitch(first.dirVec);

      let j = i + 1;
      while (j < shots.length && shots[j].tMs - shots[j - 1].tMs <= BURST_GAP_MS) {
        const b = shots[j];
        b.burstId = id;
        b.burstIndex = j - i + 1;
        b.recoilH = normAngle(vec2yaw(b.dirVec) - baseYaw);
        b.recoilV = vec2pitch(b.dirVec) - basePitch;
        j++;
      }

      const burstSlice = shots.slice(i, j);
      const hits = burstSlice.filter(b => b.hit).length;
      const deviations = burstSlice.slice(1).flatMap(b => [b.recoilH ?? 0, b.recoilV ?? 0]);
      const spread = rms(deviations);
      const maxH = burstSlice.slice(1).reduce((m, b) => Math.max(m, Math.abs(b.recoilH ?? 0)), 0);
      const maxV = burstSlice.slice(1).reduce((m, b) => Math.max(m, Math.abs(b.recoilV ?? 0)), 0);

      bursts.push({
        id,
        tMs: first.tMs,
        shooterEOSID,
        weapon: first.weapon,
        shotCount: burstSlice.length,
        hits,
        firstShotHit: first.hit,
        hitRate: hits / burstSlice.length,
        maxRecoilH: maxH,
        maxRecoilV: maxV,
        spraySpread: spread,
        sprayControlScore: Math.max(0, 1 - spread / MAX_SPREAD_DEG)
      });

      i = j;
    }

    result.set(shooterEOSID, bursts);
  }

  return result;
}

// ─── near-miss enrichment ────────────────────────────────────────────────────

/**
 * For each missed bullet, find the closest enemy along its trajectory and fill
 * `nearestEnemyEOSID`, `nearestEnemyDistCm`, and `onTarget` in-place.
 *
 * Only considers enemies within a 200m search radius around the bullet origin
 * (fast pre-filter) to keep the inner loop cheap at 30 Hz position density.
 */
export function enrichWithNearMiss(
  bullets: BulletEvent[],
  posBuffer: PositionBuffer,
  teamOf: Map<string, number>
): void {
  const SEARCH_RADIUS_CM = 20_000; // 200 m pre-filter

  for (const b of bullets) {
    if (b.hit) continue;
    const shooterTeam = teamOf.get(b.shooterEOSID);
    if (shooterTeam == null) continue;

    // Pre-filter: enemies within 200 m of shooter at time of shot
    const candidates = posBuffer.nearbyAlive(b.tMs, b.from, SEARCH_RADIUS_CM, shooterTeam);
    let minDist = Infinity;
    let nearestEOS: string | undefined;

    for (const { eosID, sample } of candidates) {
      const d = perpDistCm(b.from, b.dirVec, sample.pos);
      if (d < minDist) { minDist = d; nearestEOS = eosID; }
    }

    if (nearestEOS !== undefined) {
      b.nearestEnemyEOSID = nearestEOS;
      b.nearestEnemyDistCm = minDist;
      b.onTarget = minDist < ON_TARGET_THRESHOLD_CM;
    }
  }
}

// ─── math helpers ────────────────────────────────────────────────────────────

function vec2yaw(d: { x: number; y: number }): number {
  return Math.atan2(d.y, d.x) * (180 / Math.PI);
}

function vec2pitch(d: { x: number; y: number; z: number }): number {
  return Math.atan2(d.z, Math.hypot(d.x, d.y)) * (180 / Math.PI);
}

function normAngle(deg: number): number {
  while (deg > 180) deg -= 360;
  while (deg < -180) deg += 360;
  return deg;
}

function rms(vals: number[]): number {
  if (!vals.length) return 0;
  return Math.sqrt(vals.reduce((s, v) => s + v * v, 0) / vals.length);
}

/**
 * Perpendicular distance (cm) from point `P` to the ray starting at `origin`
 * with unit direction `dir` — i.e. ‖(P − origin) × dir‖.
 */
export function perpDistCm(
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  P: { x: number; y: number; z: number }
): number {
  const ax = P.x - origin.x, ay = P.y - origin.y, az = P.z - origin.z;
  // Cross product ax × dir
  const cx = ay * dir.z - az * dir.y;
  const cy = az * dir.x - ax * dir.z;
  const cz = ax * dir.y - ay * dir.x;
  return Math.hypot(cx, cy, cz);
}
