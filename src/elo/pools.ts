/**
 * Class- and vehicle-pools used by SquadElo (documentation §4.1.2, Tabelle 6/7).
 *
 * Every player action in a round is attributed to exactly one pool; a separate
 * Elo is tracked per pool, plus a standardized "global" Elo across pools.
 */

export type InfantryPool = 'SL' | 'Medic' | 'LAT' | 'HAT' | 'CE' | 'Generic';
export type VehiclePool = 'MBT' | 'Heavy IFV' | 'Light IFV' | 'APC' | 'Scout' | 'Heli';
export type RatedPool = InfantryPool | VehiclePool;
export type Pool = RatedPool | 'Unrated';

export const INFANTRY_POOLS: InfantryPool[] = ['SL', 'Medic', 'LAT', 'HAT', 'CE', 'Generic'];
export const VEHICLE_POOLS: VehiclePool[] = ['MBT', 'Heavy IFV', 'Light IFV', 'APC', 'Scout', 'Heli'];
export const RATED_POOLS: RatedPool[] = [...INFANTRY_POOLS, ...VEHICLE_POOLS];

/**
 * Published class-pool point distribution means/std-devs (Tabelle 7). Used to
 * standardize per-pool points into a comparable z-score for the global Elo.
 */
export const POOL_STATS: Record<RatedPool, { mean: number; std: number }> = {
  CE: { mean: 12.15, std: 12.48 },
  Generic: { mean: 7.01, std: 7.67 },
  HAT: { mean: 14.07, std: 11.66 },
  LAT: { mean: 8.87, std: 8.53 },
  Medic: { mean: 18.4, std: 11.52 },
  SL: { mean: 10.67, std: 9.62 },
  MBT: { mean: 13.04, std: 10.52 },
  'Heavy IFV': { mean: 14.4, std: 11.38 },
  'Light IFV': { mean: 13.16, std: 11.04 },
  APC: { mean: 11.03, std: 9.98 },
  Scout: { mean: 12.51, std: 10.63 },
  Heli: { mean: 1.96, std: 4.67 }
};

/**
 * Map an in-game role/kit classname to an infantry pool. Returns null for
 * non-infantry / unrated kits (crewman, pilot, unarmed) — those are handled by
 * the vehicle the player occupies instead.
 */
export function infantryPoolForRole(role: string | undefined): InfantryPool | 'Unrated' | null {
  if (!role) return null;
  const r = role.toLowerCase();
  if (r.includes('crewman') || r.includes('pilot') || r.includes('unarmed')) return 'Unrated';
  if (r.includes('medic')) return 'Medic';
  // SL kits: "_SL", "_SL_", "squadleader", "leader"
  if (/(_sl(_|\d|$))|squadleader|leader/.test(r)) return 'SL';
  if (r.includes('_hat') || r.includes('heavyantitank') || r.includes('heavy_anti')) return 'HAT';
  if (r.includes('_lat') || r.includes('lightantitank') || r.includes('light_anti') || r.includes('antitank')) return 'LAT';
  if (r.includes('engineer') || r.includes('sapper')) return 'CE';
  // Generic pool: rifleman, grenadier, raider, sniper, MG, marksman, ambusher, infiltrator, automaticrifleman...
  if (
    /rifleman|grenadier|raider|sniper|machinegun|machine_gun|_mg|automaticrifle|autorifle|marksman|ambusher|infiltrator|scout(?!.*car)/.test(
      r
    )
  )
    return 'Generic';
  return 'Generic';
}
