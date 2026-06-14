/**
 * Normalized event model produced by the log parser.
 *
 * These map onto the SquadStats "Squad-Events" (Tabelle 1 of the documentation):
 * RoundStart, PlayerDied, PlayerWound, PlayerRevived, PlayerDamage, FobCreate,
 * FlagCaptured, CapZoneData, TicketData, PlayerData, VehicleData, ... etc.
 *
 * Two families feed this model:
 *  - VANILLA lines: emitted by every Squad dedicated server (kills, wounds, revives,
 *    damage, possess, connect, tickets/round result). Their syntax matches SquadJS.
 *  - EXTENDED telemetry (`LogSquadStats:` lines): position/health/cap streams that a
 *    server plugin / the SquadStats SDK emits. Vanilla logs do NOT carry continuous
 *    positions, so these are required for the map replay (see docs/LOG_FORMAT.md).
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type EventType =
  | 'NEW_GAME'
  | 'ROUND_ENDED'
  | 'PLAYER_CONNECTED'
  | 'JOIN_SUCCEEDED'
  | 'PLAYER_DISCONNECTED'
  | 'PLAYER_POSSESS'
  | 'PLAYER_UNPOSSESS'
  | 'PLAYER_DAMAGED'
  | 'PLAYER_WOUNDED'
  | 'PLAYER_DIED'
  | 'PLAYER_REVIVED'
  | 'DEPLOYABLE_DAMAGED'
  | 'TICKETS'
  | 'PLAYER_POS'
  | 'VEHICLE_POS'
  | 'VEHICLE_COMPONENT'
  | 'VEHICLE_DAMAGE'
  | 'CAPZONE'
  | 'FLAG_CAPTURED'
  | 'FOB_CREATED'
  | 'FOB_DESTROYED'
  | 'SPAWN_CREATED'
  | 'PLAYER_SPAWN'
  | 'PLAYER_ROLE'
  | 'SQUAD_CREATED'
  | 'AMMO_DELIVERY'
  | 'MAP_MARKER'
  | 'PROJECTILE';

export interface BaseEvent {
  type: EventType;
  /** epoch ms (UTC) */
  time: number;
  /** raw timestamp string from the log */
  ts: string;
  /** UE frame "chain" id */
  chainID: number;
  /** original log line */
  raw?: string;
}

export interface NewGameEvent extends BaseEvent {
  type: 'NEW_GAME';
  dlc: string;
  mapClassname: string;
  layerClassname: string;
}

export interface RoundEndedEvent extends BaseEvent {
  type: 'ROUND_ENDED';
  winnerTeam?: number;
  winnerFaction?: string;
  loserTeam?: number;
  loserFaction?: string;
  tickets?: number;
  layer?: string;
}

export interface PlayerConnectedEvent extends BaseEvent {
  type: 'PLAYER_CONNECTED';
  playercontroller: string;
  ip?: string;
  eosID?: string;
  steamID?: string;
}

export interface JoinSucceededEvent extends BaseEvent {
  type: 'JOIN_SUCCEEDED';
  playerSuffix: string;
  eosID?: string;
  steamID?: string;
  playercontroller?: string;
}

export interface PlayerDisconnectedEvent extends BaseEvent {
  type: 'PLAYER_DISCONNECTED';
  eosID?: string;
  playerController?: string;
  ip?: string;
}

export interface PlayerPossessEvent extends BaseEvent {
  type: 'PLAYER_POSSESS';
  playerSuffix: string;
  possessClassname: string;
  eosID?: string;
  steamID?: string;
}

export interface PlayerUnpossessEvent extends BaseEvent {
  type: 'PLAYER_UNPOSSESS';
  playerSuffix: string;
  eosID?: string;
  switchPossess?: boolean;
}

export interface PlayerDamagedEvent extends BaseEvent {
  type: 'PLAYER_DAMAGED';
  victimName: string;
  damage: number;
  attackerName?: string;
  attackerController?: string;
  attackerEOSID?: string;
  attackerSteamID?: string;
  weapon?: string;
}

export interface PlayerWoundedEvent extends BaseEvent {
  type: 'PLAYER_WOUNDED';
  victimName: string;
  damage: number;
  attackerPlayerController?: string;
  attackerEOSID?: string;
  attackerSteamID?: string;
  weapon?: string;
}

export interface PlayerDiedEvent extends BaseEvent {
  type: 'PLAYER_DIED';
  victimName: string;
  damage: number;
  attackerPlayerController?: string;
  attackerEOSID?: string;
  attackerSteamID?: string;
  weapon?: string;
}

export interface PlayerRevivedEvent extends BaseEvent {
  type: 'PLAYER_REVIVED';
  reviverName: string;
  victimName: string;
  reviverEOSID?: string;
  victimEOSID?: string;
}

export interface DeployableDamagedEvent extends BaseEvent {
  type: 'DEPLOYABLE_DAMAGED';
  deployable: string;
  damage: number;
  weapon?: string;
  playerSuffix?: string;
  damageType?: string;
  healthRemaining?: number;
}

export interface TicketsEvent extends BaseEvent {
  type: 'TICKETS';
  team: number;
  tickets: number;
}

export interface PlayerPosEvent extends BaseEvent {
  type: 'PLAYER_POS';
  eosID: string;
  controller?: string;
  pos: Vec3;
  yaw: number;
  health: number;
  team: number;
  squad?: number;
  role?: string;
  state?: 'alive' | 'wound' | 'dead';
}

export interface VehiclePosEvent extends BaseEvent {
  type: 'VEHICLE_POS';
  vehicle: string;
  vehType: string;
  pos: Vec3;
  yaw: number;
  turretYaw?: number;
  health: number;
  maxHealth: number;
  team: number;
}

export interface VehicleComponentEvent extends BaseEvent {
  type: 'VEHICLE_COMPONENT';
  vehicle: string;
  component: string;
  health: number;
}

export interface VehicleDamageEvent extends BaseEvent {
  type: 'VEHICLE_DAMAGE';
  vehicle: string;
  vehType?: string;
  attackerEOSID?: string;
  damage: number;
  damageType?: string;
  direct?: boolean;
}

export interface CapZoneEvent extends BaseEvent {
  type: 'CAPZONE';
  flag: string;
  pos: Vec3;
  team: number;
  captureProgress: number;
  status: string;
}

export interface FlagCapturedEvent extends BaseEvent {
  type: 'FLAG_CAPTURED';
  flag: string;
  team: number;
  pos?: Vec3;
}

export interface FobCreatedEvent extends BaseEvent {
  type: 'FOB_CREATED';
  fob: string;
  team: number;
  pos: Vec3;
  creatorEOSID?: string;
}

export interface FobDestroyedEvent extends BaseEvent {
  type: 'FOB_DESTROYED';
  fob: string;
  team: number;
  pos?: Vec3;
}

export interface SpawnCreatedEvent extends BaseEvent {
  type: 'SPAWN_CREATED';
  kind: string; // RallyPoint | HAB
  team: number;
  squad?: number;
  pos: Vec3;
}

export interface PlayerSpawnEvent extends BaseEvent {
  type: 'PLAYER_SPAWN';
  eosID: string;
  spawnName: string;
  pos: Vec3;
}

export interface PlayerRoleEvent extends BaseEvent {
  type: 'PLAYER_ROLE';
  eosID: string;
  role: string;
  isLead: boolean;
}

export interface SquadCreatedEvent extends BaseEvent {
  type: 'SQUAD_CREATED';
  creatorEOSID?: string;
  squadID: number;
  squadName: string;
  team: number;
}

export interface AmmoDeliveryEvent extends BaseEvent {
  type: 'AMMO_DELIVERY';
  fob: string;
  eosID: string;
  amount: number;
}

export interface MapMarkerEvent extends BaseEvent {
  type: 'MAP_MARKER';
  eosID: string;
  markerType: string;
  pos: Vec3;
}

export interface ProjectileEvent extends BaseEvent {
  type: 'PROJECTILE';
  shooterEOSID?: string;
  weapon: string;
  /** muzzle / origin position (cm) */
  from: Vec3;
  /** impact position (cm) */
  to: Vec3;
  /** muzzle velocity in m/s (0 / unknown if not provided) */
  speed: number;
  hit: boolean;
  victimEOSID?: string;
}

export type TimelineEvent =
  | NewGameEvent
  | RoundEndedEvent
  | PlayerConnectedEvent
  | JoinSucceededEvent
  | PlayerDisconnectedEvent
  | PlayerPossessEvent
  | PlayerUnpossessEvent
  | PlayerDamagedEvent
  | PlayerWoundedEvent
  | PlayerDiedEvent
  | PlayerRevivedEvent
  | DeployableDamagedEvent
  | TicketsEvent
  | PlayerPosEvent
  | VehiclePosEvent
  | VehicleComponentEvent
  | VehicleDamageEvent
  | CapZoneEvent
  | FlagCapturedEvent
  | FobCreatedEvent
  | FobDestroyedEvent
  | SpawnCreatedEvent
  | PlayerSpawnEvent
  | PlayerRoleEvent
  | SquadCreatedEvent
  | AmmoDeliveryEvent
  | MapMarkerEvent
  | ProjectileEvent;
