import type { Vec3 } from '../parser/events.js';
import type { PositionSample } from './types.js';

const STALE_MS = 2_000; // 2 s max age for a sample to be considered "current"

function bsearchFloor<T extends { tMs: number }>(arr: T[], tMs: number): number {
  let lo = 0, hi = arr.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].tMs <= tMs) { res = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return res;
}

/**
 * Efficient in-memory ring-buffer of PositionSamples per player, sorted by tMs.
 * Populated from PLAYER_POS events at whatever frequency the server emits them
 * (30 Hz target, see docs/CQB_CAPTURE_SPEC.md).
 *
 * All time values are round-relative milliseconds (absolute event.time − roundStartTime).
 */
export class PositionBuffer {
  private readonly tracks = new Map<string, PositionSample[]>();

  add(eosID: string, sample: PositionSample): void {
    let arr = this.tracks.get(eosID);
    if (!arr) { arr = []; this.tracks.set(eosID, arr); }
    arr.push(sample);
  }

  /** Replace the entire track for a player (must be pre-sorted by tMs). */
  addSorted(eosID: string, samples: PositionSample[]): void {
    this.tracks.set(eosID, samples);
  }

  /** Last sample at or before tMs, or null if none. */
  atTime(eosID: string, tMs: number): PositionSample | null {
    const arr = this.tracks.get(eosID);
    if (!arr) return null;
    const i = bsearchFloor(arr, tMs);
    return i >= 0 ? arr[i] : null;
  }

  /** All samples within [fromMs, toMs] inclusive. */
  range(eosID: string, fromMs: number, toMs: number): PositionSample[] {
    const arr = this.tracks.get(eosID);
    if (!arr) return [];
    // Start index via binary search
    const out: PositionSample[] = [];
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].tMs < fromMs) lo = mid + 1; else hi = mid - 1;
    }
    for (let i = lo; i < arr.length && arr[i].tMs <= toMs; i++) out.push(arr[i]);
    return out;
  }

  /**
   * Was the player moving in the `windowMs` before `tMs`?
   * Returns true if the player's position changed by more than `minDistCm`.
   */
  wasMoving(eosID: string, tMs: number, windowMs: number, minDistCm = 150): boolean {
    const samples = this.range(eosID, tMs - windowMs, tMs);
    if (samples.length < 2) return false;
    const first = samples[0], last = samples[samples.length - 1];
    const d = Math.hypot(last.pos.x - first.pos.x, last.pos.y - first.pos.y);
    return d > minDistCm;
  }

  /**
   * All players alive at tMs whose last known position is within distanceCm of `pos`.
   * Pass `excludeTeam` to skip players on that team (e.g. to find enemies only).
   */
  nearbyAlive(
    tMs: number,
    pos: Vec3,
    distanceCm: number,
    excludeTeam?: number
  ): Array<{ eosID: string; sample: PositionSample; distanceCm: number }> {
    const out: Array<{ eosID: string; sample: PositionSample; distanceCm: number }> = [];
    for (const [eosID, arr] of this.tracks) {
      const i = bsearchFloor(arr, tMs);
      if (i < 0) continue;
      const s = arr[i];
      if (tMs - s.tMs > STALE_MS) continue;
      if (s.state !== 'alive') continue;
      if (excludeTeam != null && s.team === excludeTeam) continue;
      const d = Math.hypot(s.pos.x - pos.x, s.pos.y - pos.y);
      if (d <= distanceCm) out.push({ eosID, sample: s, distanceCm: d });
    }
    return out;
  }

  /**
   * Allies of `eosID` at `tMs` within `distanceCm` (same team, excludes self).
   */
  nearbyAllies(
    eosID: string,
    tMs: number,
    distanceCm: number
  ): Array<{ eosID: string; sample: PositionSample; distanceCm: number }> {
    const self = this.atTime(eosID, tMs);
    if (!self) return [];
    const out: Array<{ eosID: string; sample: PositionSample; distanceCm: number }> = [];
    for (const [id, arr] of this.tracks) {
      if (id === eosID) continue;
      const i = bsearchFloor(arr, tMs);
      if (i < 0) continue;
      const s = arr[i];
      if (tMs - s.tMs > STALE_MS) continue;
      if (s.state !== 'alive') continue;
      if (s.team !== self.team) continue;
      const d = Math.hypot(s.pos.x - self.pos.x, s.pos.y - self.pos.y);
      if (d <= distanceCm) out.push({ eosID: id, sample: s, distanceCm: d });
    }
    return out;
  }

  keys(): IterableIterator<string> {
    return this.tracks.keys();
  }
}
