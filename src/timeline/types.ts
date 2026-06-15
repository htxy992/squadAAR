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
  assetKey: string;
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

export interface SnapshotSpawn {
  kind: string; // HAB | Rally
  team: number;
  squad?: number;
  pos: NormPos;
}

export interface SnapshotDeployable {
  deplType: string; // HMG, Mortar, TOW, AT-gun, ...
  team: number;
  pos: NormPos;
}

export interface MapMarkerPoint {
  tMs: number;
  type: string; // enemy_infantry | enemy_vehicle | enemy_fob | ...
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
  spawns: SnapshotSpawn[];
  deployables: SnapshotDeployable[];
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
  | 'vehicle_destroyed'
  | 'explosion';

export interface MapEventExtra {
  /** blast radius in metres for explosion markers */
  radiusM?: number;
}

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
  radiusM?: number;
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

export interface DamageContribution {
  eosID: string;
  name: string;
  damage: number;
}

/** A reconstructed death: who killed whom, how, and the full damage sequence. */
export interface DeathReport {
  tMs: number;
  victimEOSID?: string;
  victimName: string;
  victimTeam?: number;
  victimPos?: NormPos;
  killerEOSID?: string;
  killerName?: string;
  killerTeam?: number;
  killerPos?: NormPos;
  weapon?: string;
  distanceM?: number;
  headshot: boolean;
  teamkill: boolean;
  cause: 'killed' | 'bled out' | 'gave up' | 'team-killed';
  /** all attackers who damaged the victim this life, by damage dealt */
  contributors: DamageContribution[];
  /** plausibility of the killing shot, if a projectile matched */
  plausibility?: { score: number; flags: string[] };
  /** killing-shot endpoints for drawing the engagement */
  from?: NormPos;
  to?: NormPos;
  /** ground elevation (m) at killer / victim, and the killer's height advantage */
  killerElevationM?: number;
  victimElevationM?: number;
  highGroundM?: number;
  /** terrain ground vs straight bullet-line height (m) sampled killer->victim */
  elevationProfile?: { ground: number[]; line: number[] };
  hasLineOfSight?: boolean;
}

/** Serializable terrain height grid (metres), for client hillshade/contours. */
export interface TerrainGrid {
  grid: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  min: number;
  max: number;
  /** row-major heights in metres, index = y*grid + x */
  heights: number[];
  coverage: number;
}

export interface VehiclePathPoint {
  tMs: number;
  nx: number;
  ny: number;
}

/** A spot where a vehicle stood still long enough to be notable. */
export interface VehicleDwell {
  nx: number;
  ny: number;
  fromMs: number;
  toMs: number;
  durationMs: number;
}

/** Per-vehicle movement analysis: route, where it stood, distance & speed. */
export interface VehicleTrackSummary {
  id: string;
  type: string;
  pool: Pool | null;
  team: number;
  path: VehiclePathPoint[];
  dwell: VehicleDwell[];
  distanceM: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  activeMs: number;
  standingMs: number;
  firstSeenMs: number;
  lastSeenMs: number;
  destroyedMs?: number;
}

export interface Round {
  meta: RoundMeta;
  players: Record<string, RoundPlayer>;
  snapshots: Snapshot[];
  mapEvents: MapEvent[];
  analysis: RoundAnalysis;
  deaths: DeathReport[];
  terrain: TerrainGrid;
  vehicleTracks: VehicleTrackSummary[];
  markers: MapMarkerPoint[];
  /** the raw normalized events, kept for the points engine + drill-down */
  events: TimelineEvent[];
}
