import type { Vec3 } from '../parser/events.js';
import type { BulletEvent } from './types.js';
import type { PositionBuffer } from './positionBuffer.js';

/** Max age of a PlayerLook sample to be accepted as "the aim at fire time" (ms). */
const LOOK_STALE_MS = 600;

/** One crosshair sample (Squad convention: yaw 0 = north, CW; pitch + = up). */
export interface LookSample {
  tMs: number;
  pitch: number;
  yaw: number;
}

function bsearchFloor(arr: LookSample[], tMs: number): number {
  let lo = 0, hi = arr.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].tMs <= tMs) { res = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return res;
}

/**
 * Time-indexed crosshair (pitch/yaw) per player, populated from PLAYER_LOOK
 * events. Mirrors PositionBuffer; all times are round-relative ms.
 *
 * PlayerLook is the only source that captures *where the player was aiming*
 * (as opposed to where the bullet physically went), so it is what makes the
 * "aim vs. target" / crosshair-placement analysis possible.
 */
export class LookBuffer {
  private readonly tracks = new Map<string, LookSample[]>();

  add(eosID: string, sample: LookSample): void {
    let arr = this.tracks.get(eosID);
    if (!arr) { arr = []; this.tracks.set(eosID, arr); }
    arr.push(sample);
  }

  /** Replace a player's whole track (must be pre-sorted by tMs). */
  addSorted(eosID: string, samples: LookSample[]): void {
    this.tracks.set(eosID, samples);
  }

  /** Last look at or before tMs (within LOOK_STALE_MS), or null. */
  atTime(eosID: string, tMs: number): LookSample | null {
    const arr = this.tracks.get(eosID);
    if (!arr) return null;
    const i = bsearchFloor(arr, tMs);
    if (i < 0) return null;
    const s = arr[i];
    return tMs - s.tMs <= LOOK_STALE_MS ? s : null;
  }

  has(eosID: string): boolean {
    return (this.tracks.get(eosID)?.length ?? 0) > 0;
  }

  size(): number {
    let n = 0;
    for (const arr of this.tracks.values()) n += arr.length;
    return n;
  }
}

// ─── angle helpers (Squad convention) ──────────────────────────────────────────

/** Bearing of vector (dx,dy) in Squad convention: 0 = north (+Y), CW, 0..360. */
export function bearingDegSquad(dx: number, dy: number): number {
  return (Math.atan2(dx, dy) * (180 / Math.PI) + 360) % 360;
}

/** Elevation angle of a 3-D vector (deg, + = up). */
export function elevationDeg(dx: number, dy: number, dz: number): number {
  return Math.atan2(dz, Math.hypot(dx, dy)) * (180 / Math.PI);
}

/** Shortest signed difference a−b in degrees, wrapped to (−180,180]. */
export function normAngle(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Unit direction vector from a (yaw,pitch) pair in Squad convention. */
function dirFrom(yaw: number, pitch: number): Vec3 {
  const a = yaw * (Math.PI / 180), p = pitch * (Math.PI / 180);
  const cp = Math.cos(p);
  return { x: cp * Math.sin(a), y: cp * Math.cos(a), z: Math.sin(p) };
}

/** True angular separation between two (yaw,pitch) directions (deg). */
export function angleBetween(yawA: number, pitchA: number, yawB: number, pitchB: number): number {
  const a = dirFrom(yawA, pitchA), b = dirFrom(yawB, pitchB);
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(dot) * (180 / Math.PI);
}

// ─── enrichment ────────────────────────────────────────────────────────────────

/**
 * For each bullet, score *where the shooter was aiming* against the enemy it was
 * fired at, filling aimYaw/aimPitch/aimError* in-place.
 *
 * Source of the aim direction:
 *   - real PLAYER_LOOK at fire time (preferred — works for hits and misses); or
 *   - the projectile direction as a fallback, but only for **misses** (for a hit
 *     the projectile `to` *is* the victim, so a derived error of ~0 would be an
 *     artifact, not a measurement — we leave it undefined instead).
 *
 * Target centre is the victim (if the shot hit) or the nearest enemy to the
 * trajectory (from enrichWithNearMiss), sampled at fire time from posBuffer.
 */
export function enrichWithAim(
  bullets: BulletEvent[],
  lookBuffer: LookBuffer,
  posBuffer: PositionBuffer
): void {
  for (const b of bullets) {
    const targetEOS = b.hit ? b.victimEOSID : b.nearestEnemyEOSID;
    if (!targetEOS) continue;
    const target = posBuffer.atTime(targetEOS, b.tMs);
    if (!target) continue;

    const dx = target.pos.x - b.from.x;
    const dy = target.pos.y - b.from.y;
    const dz = target.pos.z - b.from.z;
    if (dx === 0 && dy === 0 && dz === 0) continue;

    const bearing = bearingDegSquad(dx, dy);
    const elev = elevationDeg(dx, dy, dz);

    const look = lookBuffer.atTime(b.shooterEOSID, b.tMs);
    let aimYaw: number, aimPitch: number, fromLook: boolean;

    if (look) {
      aimYaw = look.yaw;
      aimPitch = look.pitch;
      fromLook = true;
    } else if (!b.hit) {
      // Fallback: the realised shot direction. Meaningful only for a miss.
      aimYaw = bearingDegSquad(b.dirVec.x, b.dirVec.y);
      aimPitch = elevationDeg(b.dirVec.x, b.dirVec.y, b.dirVec.z);
      fromLook = false;
    } else {
      continue; // hit, no look → can't honestly score aim
    }

    b.aimYaw = aimYaw;
    b.aimPitch = aimPitch;
    b.aimFromLook = fromLook;
    b.aimTargetEOSID = targetEOS;
    b.aimErrorH = normAngle(aimYaw - bearing);
    b.aimErrorV = aimPitch - elev;
    b.aimErrorDeg = angleBetween(aimYaw, aimPitch, bearing, elev);
  }
}
