import type { Pool } from '../elo/pools.js';
import type { TimelineEvent, Vec3 } from '../parser/events.js';

export interface NormPos {
  nx: number;
  ny: number;
}

export interface RoleSpan {
  role: string;
  pool: Pool;
  fromMs: number;
  toMs: number;
}

export interface RoundPlayer {
  eosID: string;
  steamID?: string;
  name: string;
  team: number;
  squad?: number;
  roles: RoleSpan[];
  firstSeenMs: number;
  lastSeenMs: number;
  /** total ms in a "playing"/possessed state (best effort) */
  playtimeMs: number;
}

export interface RoundMeta {
  id: string;
  layer: string;
  mapKey: string;
  mapName: string;
  sizeMeters: number;
  world: { minX: number; minY: number; maxX: number; maxY: number };
  startTime: number;
  endTime: number;
  durationMs: number;
  winnerTeam?: number;
  factions: Record<number, string>;
  finalTickets: Record<number, number>;
  playerCount: number;
  serverName?: string;
  source?: string;
}

export interface SnapshotPlayer {
  eosID: string;
  name: string;
  team: number;
  squad?: number;
  role?: string;
  pos: NormPos;
  world: Vec3;
  yaw: number;
  health: number;
  state: 'alive' | 'wound' | 'dead';
  vehicleId?: string;
}

export interface SnapshotVehicle {
  id: string;
  type: string;
  pool?: Pool | null;
  team: number;
  pos: NormPos;
  world: Vec3;
  yaw: number;
  turretYaw?: number;
  health: number;
  maxHealth: number;
  components: Record<string, number>;
  crew: string[]; // eosIDs
}

export interface SnapshotFlag {
  name: string;
  pos: NormPos;
  team: number;
  progress: number;
  status: string;
}

export interface SnapshotFob {
  id: string;
  team: number;
  pos: NormPos;
}

export interface Snapshot {
  tMs: number;
  tickets: Record<number, number>;
  players: SnapshotPlayer[];
  vehicles: SnapshotVehicle[];
  flags: SnapshotFlag[];
  fobs: SnapshotFob[];
}

export type MapEventKind =
  | 'kill'
  | 'teamkill'
  | 'wound'
  | 'revive'
  | 'death'
  | 'fob_created'
  | 'fob_destroyed'
  | 'flag_captured'
  | 'vehicle_destroyed';

export interface MapEvent {
  kind: MapEventKind;
  tMs: number;
  team?: number;
  /** primary position (victim / object) */
  pos?: NormPos;
  /** secondary position (attacker) for drawing kill lines */
  from?: NormPos;
  label: string;
  detail?: string;
  attackerEOSID?: string;
  victimEOSID?: string;
  weapon?: string;
}

export interface ProjectileTrack {
  tMs: number;
  shooterEOSID?: string;
  shooterName?: string;
  victimEOSID?: string;
  weapon?: string;
  weaponFamily: string;
  from: NormPos;
  to: NormPos;
  fromWorld: Vec3;
  toWorld: Vec3;
  rangeM: number;
  elevationDeg: number;
  speed: number;
  hit: boolean;
  /** true if reconstructed from a kill/hit rather than explicit telemetry */
  derived: boolean;
  team?: number;
  plausibility: {
    score: number;
    flags: string[];
    occlusionDepthM: number;
    withinRange: boolean;
    hasLineOfSight: boolean;
  };
}

export interface PlayerSuspicion {
  eosID: string;
  name: string;
  shots: number;
  suspiciousShots: number;
  minScore: number;
  avgScore: number;
  flags: string[];
}

export interface RoundAnalysis {
  terrainCoverage: number;
  threshold: number;
  projectiles: ProjectileTrack[];
  suspicious: ProjectileTrack[];
  playerSuspicion: PlayerSuspicion[];
}

export interface Round {
  meta: RoundMeta;
  players: Record<string, RoundPlayer>;
  snapshots: Snapshot[];
  mapEvents: MapEvent[];
  analysis: RoundAnalysis;
  /** the raw normalized events, kept for the points engine + drill-down */
  events: TimelineEvent[];
}
