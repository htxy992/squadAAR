import type { Pool, RatedPool } from '../elo/pools.js';

export interface PointBreakdown {
  combat: number; // kills/wounds via damage share
  revive: number;
  heal: number;
  flag: number;
  fobDestroy: number;
  vehicleDestroy: number;
  component: number;
  logistics: number;
  transport: number;
  fobValue: number; // SL value from spawns
  penalty: number; // give-ups, teamkills
}

export interface PlayerStats {
  kills: number;
  wounds: number;
  deaths: number;
  teamkills: number;
  revivesGiven: number;
  revivesReceived: number;
  damageInfantry: number;
  damageVehicle: number;
  longestKillM: number;
  headshots: number;
  fobsDestroyed: number;
  vehiclesDestroyed: number;
  flagsCaptured: number;
}

export interface PlayerPointReport {
  eosID: string;
  steamID?: string;
  name: string;
  team: number;
  /** primary pool for the round (longest played) */
  pool: Pool;
  /** points attributed per pool (for SquadElo) */
  poolPoints: Partial<Record<RatedPool, number>>;
  /** ms played per pool */
  poolTimeMs: Partial<Record<RatedPool, number>>;
  breakdown: PointBreakdown;
  totalPoints: number;
  stats: PlayerStats;
}

export interface GlobalPointReport {
  roundId: string;
  layer: string;
  mapName: string;
  durationMs: number;
  startTime: number;
  winnerTeam?: number;
  finalTickets: Record<number, number>;
  factions: Record<number, string>;
  playerCount: number;
  teamPoints: Record<number, number>;
}

export interface RoundReport {
  global: GlobalPointReport;
  players: PlayerPointReport[];
}
