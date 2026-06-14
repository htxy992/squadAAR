import type { VehiclePool } from '../elo/pools.js';

/**
 * SquadPoints tuning constants, taken from the SquadStats documentation
 * (chapter 3). Where the doc leaves a value implementation-defined we pick a
 * sensible default and note it.
 */
export const POINTS = {
  /** points per infantry wound, split across attackers by damage share (§3.2.2) */
  woundPoolPoints: 1,
  /** commander kills are worth 2 tickets -> 2 points (§3.2.2 fn.3) */
  commanderWoundPoints: 2,
  /** giving up / non-combat death penalty (§3.2.2) */
  giveUpPenalty: -1,
  /** revive base point for the medic (§3.2.2) */
  revivePoints: 1,
  /** per healed HP (§3.2.12); a full revive heal ~95hp => ~0.95 */
  healPerHp: 0.01,
  approxHealHpPerRevive: 95,
  /** neutral vs enemy flag capture pools, distributed by cap-ticks (§3.2.5) */
  flagNeutralPoints: 20,
  flagEnemyPoints: 60,
  /** FOB destruction base, scaled by destruction multiplier 1..2 (§3.2.4 / §3.2.7) */
  fobDestroyPoints: 20,
  /** capture radius used to attribute flag points (metres) */
  flagRadiusM: 100,
  /** radius around a FOB within which players are credited for its destruction (m) */
  fobDestroyRadiusM: 100,
  /** objective kill multiplier (§3.2.11) */
  objectiveMultiplier: 1.25,
  /** headshot multiplier (§3.2.12) */
  headshotMultiplier: 1.25,
  /** transport share of transported players' points (§3.2.8) */
  transportShare: 0.1,
  /** logistics: up to 1.0 point per consumed ammo point, here scaled per delivery */
  logiPerAmmo: 1 / 1000,
  /** how long a damage contribution stays valid for kill attribution (ms) (§3.2.2) */
  damageWindowMs: 3 * 60 * 1000
} as const;

/** Vehicle ticket values (= base point value when destroyed). MBT = 15 (§3.2.3). */
export const VEHICLE_TICKET_VALUE: Record<VehiclePool, number> = {
  MBT: 15,
  'Heavy IFV': 13,
  'Light IFV': 11,
  APC: 8,
  Scout: 6,
  Heli: 12
};

/** Per-component destruction multipliers, applied to full vehicle value (§3.2.10, Tabelle 4). */
export const COMPONENT_MULTIPLIER: Record<string, number> = {
  wheel: 0.025,
  track: 0.15,
  turret: 0.15,
  turm: 0.15,
  engine: 0.15,
  ammo: 0.3,
  ammorack: 0.3,
  rotor: 0.15
};

export function componentMultiplier(component: string): number {
  const c = component.toLowerCase().replace(/[_\s]/g, '');
  for (const [k, v] of Object.entries(COMPONENT_MULTIPLIER)) if (c.includes(k)) return v;
  return 0;
}
