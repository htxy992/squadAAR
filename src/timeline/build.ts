import type { TimelineEvent, Vec3 } from '../parser/events.js';
import { resolveMap, worldToNorm, type MapInfo } from '../maps/mapRegistry.js';
import { infantryPoolForRole, type Pool } from '../elo/pools.js';
import { classifyVehicleType } from '../elo/vehicleTypes.js';
import { buildTerrainField, terrainHeightAt, analyzeProjectile, classifyWeapon, type TerrainField } from '../analysis/ballistics.js';
import { PositionBuffer } from '../engagement/positionBuffer.js';
import { buildBulletEvents, detectBursts, enrichWithNearMiss } from '../engagement/shots.js';
import { buildEngagements } from '../engagement/detect.js';
import { applyCoachingFlags } from '../engagement/coaching.js';
import type { EngagementReport, BurstSummary } from '../engagement/types.js';
import type { ProjectileTrack, PlayerSuspicion, RoundAnalysis, DeathReport, DamageContribution, TerrainGrid, VehicleTrackSummary, MapMarkerPoint } from './types.js';
import type {
  Round,
  RoundMeta,
  RoundPlayer,
  RoleSpan,
  Snapshot,
  SnapshotPlayer,
  SnapshotVehicle,
  SnapshotFlag,
  SnapshotFob,
  MapEvent,
  NormPos
} from './types.js';

interface PSample {
  t: number;
  pos: Vec3;
  yaw: number;
  health: number;
  team: number;
  squad?: number;
  role?: string;
  state: 'alive' | 'wound' | 'dead';
}
interface VSample {
  t: number;
  pos: Vec3;
  yaw: number;
  turretYaw?: number;
  health: number;
  maxHealth: number;
}

const MAX_FRAMES = 600;
const STALE_MS = 25_000;

function sampleAt<T extends { t: number }>(arr: T[], t: number): T | undefined {
  // last sample with .t <= t (arr assumed sorted)
  let lo = 0,
    hi = arr.length - 1,
    res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t) {
      res = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return res >= 0 ? arr[res] : undefined;
}

export interface BuildOptions {
  id?: string;
  serverName?: string;
  source?: string;
  /** pre-loaded real DEM (from a heightmap); overrides reconstructed terrain */
  terrainField?: TerrainField;
}

export function buildRound(events: TimelineEvent[], opts: BuildOptions = {}): Round {
  const newGame = events.find((e) => e.type === 'NEW_GAME') as Extract<TimelineEvent, { type: 'NEW_GAME' }> | undefined;
  const roundEnded = events.find((e) => e.type === 'ROUND_ENDED') as
    | Extract<TimelineEvent, { type: 'ROUND_ENDED' }>
    | undefined;

  const times = events.map((e) => e.time).filter((t) => t > 0);
  const startTime = newGame?.time ?? Math.min(...times);
  const endTime = roundEnded?.time ?? Math.max(...times);
  const durationMs = Math.max(0, endTime - startTime);

  const layer = newGame?.layerClassname ?? roundEnded?.layer ?? 'Unknown';
  const map: MapInfo = resolveMap(layer || newGame?.mapClassname);
  const rel = (t: number) => t - startTime;

  // ---- identity maps -------------------------------------------------
  const eosToName = new Map<string, string>();
  const nameToEos = new Map<string, string>();
  const eosToSteam = new Map<string, string>();
  const link = (eos?: string, name?: string, steam?: string) => {
    if (!eos) return;
    if (name) {
      eosToName.set(eos, name);
      nameToEos.set(name, eos);
    }
    if (steam) eosToSteam.set(eos, steam);
  };

  // ---- tracks --------------------------------------------------------
  const pTracks = new Map<string, PSample[]>();
  const vTracks = new Map<string, { type: string; team: number; samples: VSample[]; comp: Map<string, { t: number; health: number }[]> }>();
  const flagTracks = new Map<string, { t: number; pos: Vec3; team: number; progress: number; status: string }[]>();
  const fobs = new Map<string, { team: number; pos: Vec3; createdMs: number; destroyedMs?: number }>();
  const tickets = new Map<number, { t: number; tickets: number }[]>();
  const roleSpans = new Map<string, RoleSpan[]>();
  const teamOf = new Map<string, number>();
  const squadOf = new Map<string, number>();
  const factions: Record<number, string> = {};
  const spawnsRaw: Array<{ kind: string; team: number; squad?: number; pos: Vec3; createdMs: number }> = [];
  const deployRaw: Array<{ deplType: string; team: number; pos: Vec3; createdMs: number }> = [];

  const pushRole = (eos: string, role: string, t: number) => {
    const pool = poolForRole(role);
    const spans = roleSpans.get(eos) ?? [];
    const last = spans[spans.length - 1];
    if (last && last.role === role) return;
    if (last) last.toMs = rel(t);
    spans.push({ role, pool, fromMs: rel(t), toMs: rel(endTime) });
    roleSpans.set(eos, spans);
  };

  for (const e of events) {
    switch (e.type) {
      case 'JOIN_SUCCEEDED':
        link(e.eosID, e.playerSuffix, e.steamID);
        break;
      case 'PLAYER_CONNECTED':
        link(e.eosID, undefined, e.steamID);
        break;
      case 'PLAYER_POSSESS':
        link(e.eosID, e.playerSuffix, e.steamID);
        break;
      case 'PLAYER_DAMAGED':
        if (e.attackerEOSID) link(e.attackerEOSID, e.attackerName, e.attackerSteamID);
        break;
      case 'PLAYER_REVIVED':
        link(e.reviverEOSID, e.reviverName);
        link(e.victimEOSID, e.victimName);
        break;
      case 'PLAYER_POS': {
        const arr = pTracks.get(e.eosID) ?? [];
        arr.push({ t: e.time, pos: e.pos, yaw: e.yaw, health: e.health, team: e.team, squad: e.squad, role: e.role, state: e.state ?? 'alive' });
        pTracks.set(e.eosID, arr);
        teamOf.set(e.eosID, e.team);
        if (e.squad != null) squadOf.set(e.eosID, e.squad);
        if (e.role) pushRole(e.eosID, e.role, e.time);
        break;
      }
      case 'PLAYER_ROLE':
        pushRole(e.eosID, e.role, e.time);
        break;
      case 'VEHICLE_POS': {
        const v = vTracks.get(e.vehicle) ?? { type: e.vehType, team: e.team, samples: [] as VSample[], comp: new Map<string, { t: number; health: number }[]>() };
        v.type = e.vehType;
        v.team = e.team;
        v.samples.push({ t: e.time, pos: e.pos, yaw: e.yaw, turretYaw: e.turretYaw, health: e.health, maxHealth: e.maxHealth });
        vTracks.set(e.vehicle, v);
        break;
      }
      case 'VEHICLE_COMPONENT': {
        const v = vTracks.get(e.vehicle);
        if (v) {
          const arr = v.comp.get(e.component) ?? [];
          arr.push({ t: e.time, health: e.health });
          v.comp.set(e.component, arr);
        }
        break;
      }
      case 'CAPZONE': {
        const arr = flagTracks.get(e.flag) ?? [];
        arr.push({ t: e.time, pos: e.pos, team: e.team, progress: e.captureProgress, status: e.status });
        flagTracks.set(e.flag, arr);
        break;
      }
      case 'FOB_CREATED':
        fobs.set(e.fob, { team: e.team, pos: e.pos, createdMs: e.time });
        break;
      case 'FOB_DESTROYED': {
        const f = fobs.get(e.fob);
        if (f) f.destroyedMs = e.time;
        break;
      }
      case 'TICKETS': {
        const arr = tickets.get(e.team) ?? [];
        arr.push({ t: e.time, tickets: e.tickets });
        tickets.set(e.team, arr);
        break;
      }
      case 'SPAWN_CREATED':
        spawnsRaw.push({ kind: e.kind, team: e.team, squad: e.squad, pos: e.pos, createdMs: e.time });
        break;
      case 'DEPLOYABLE_CREATED':
        deployRaw.push({ deplType: e.deplType, team: e.team, pos: e.pos, createdMs: e.time });
        break;
      case 'ROUND_ENDED':
        if (e.winnerTeam && e.winnerFaction) factions[e.winnerTeam] = e.winnerFaction;
        break;
      default:
        break;
    }
  }

  // sort tracks
  for (const arr of pTracks.values()) arr.sort((a, b) => a.t - b.t);
  for (const v of vTracks.values()) {
    v.samples.sort((a, b) => a.t - b.t);
    for (const c of v.comp.values()) c.sort((a, b) => a.t - b.t);
  }
  for (const arr of flagTracks.values()) arr.sort((a, b) => a.t - b.t);
  for (const arr of tickets.values()) arr.sort((a, b) => a.t - b.t);

  // ---- players -------------------------------------------------------
  const players: Record<string, RoundPlayer> = {};
  const allEos = new Set<string>([...pTracks.keys(), ...eosToName.keys(), ...teamOf.keys()]);
  for (const eos of allEos) {
    const track = pTracks.get(eos) ?? [];
    const first = track[0]?.t ?? startTime;
    const last = track[track.length - 1]?.t ?? endTime;
    players[eos] = {
      eosID: eos,
      steamID: eosToSteam.get(eos),
      name: eosToName.get(eos) ?? eos.slice(0, 8),
      team: teamOf.get(eos) ?? track[0]?.team ?? 0,
      squad: squadOf.get(eos),
      roles: roleSpans.get(eos) ?? [],
      firstSeenMs: rel(first),
      lastSeenMs: rel(last),
      playtimeMs: Math.max(0, last - first)
    };
  }

  const np = (p: Vec3): NormPos => {
    const { nx, ny } = worldToNorm(map, p.x, p.y);
    return { nx, ny };
  };

  // ---- snapshots -----------------------------------------------------
  const step = Math.max(1000, Math.ceil(durationMs / MAX_FRAMES / 1000) * 1000) || 3000;
  const snapshots: Snapshot[] = [];
  for (let t = startTime; t <= endTime + 1; t += step) {
    const snap: Snapshot = { tMs: rel(t), tickets: {}, players: [], vehicles: [], flags: [], fobs: [], spawns: [], deployables: [] };
    for (const [team, arr] of tickets) {
      const s = sampleAt(arr, t);
      if (s) snap.tickets[team] = s.tickets;
    }
    for (const [eos, arr] of pTracks) {
      const s = sampleAt(arr, t);
      if (!s || t - s.t > STALE_MS) continue;
      if (s.state === 'dead') continue;
      snap.players.push({
        eosID: eos,
        name: players[eos]?.name ?? eos.slice(0, 8),
        team: s.team,
        squad: s.squad,
        role: s.role,
        pos: np(s.pos),
        world: s.pos,
        yaw: s.yaw,
        health: s.health,
        state: s.state
      });
    }
    for (const [id, v] of vTracks) {
      const s = sampleAt(v.samples, t);
      if (!s || t - s.t > STALE_MS) continue;
      if (s.health <= 0) continue;
      const comps: Record<string, number> = {};
      for (const [name, carr] of v.comp) {
        const cs = sampleAt(carr, t);
        if (cs) comps[name] = cs.health;
      }
      snap.vehicles.push({
        id,
        type: v.type,
        pool: classifyVehicleType(v.type),
        team: v.team,
        pos: np(s.pos),
        world: s.pos,
        yaw: s.yaw,
        turretYaw: s.turretYaw,
        health: s.health,
        maxHealth: s.maxHealth,
        components: comps,
        crew: []
      });
    }
    for (const [name, arr] of flagTracks) {
      const s = sampleAt(arr, t);
      if (!s) continue;
      snap.flags.push({ name, pos: np(s.pos), team: s.team, progress: s.progress, status: s.status });
    }
    for (const [id, f] of fobs) {
      if (f.createdMs <= t && (!f.destroyedMs || f.destroyedMs > t)) snap.fobs.push({ id, team: f.team, pos: np(f.pos) });
    }
    for (const s of spawnsRaw) {
      const life = /rally/i.test(s.kind) ? 240_000 : Infinity;
      if (s.createdMs <= t && t - s.createdMs <= life) snap.spawns.push({ kind: s.kind, team: s.team, squad: s.squad, pos: np(s.pos) });
    }
    for (const d of deployRaw) {
      if (d.createdMs <= t) snap.deployables.push({ deplType: d.deplType, team: d.team, pos: np(d.pos) });
    }
    snapshots.push(snap);
  }

  // ---- positioned map events ----------------------------------------
  const mapEvents: MapEvent[] = [];
  const posOfEosAt = (eos: string | undefined, t: number): NormPos | undefined => {
    if (!eos) return undefined;
    const s = sampleAt(pTracks.get(eos) ?? [], t);
    return s ? np(s.pos) : undefined;
  };

  for (const e of events) {
    if (e.type === 'PLAYER_DIED') {
      const victimEos = nameToEos.get(e.victimName);
      const attackerEos = e.attackerEOSID;
      const vTeam = victimEos ? teamOf.get(victimEos) : undefined;
      const aTeam = attackerEos ? teamOf.get(attackerEos) : undefined;
      const teamkill = vTeam != null && aTeam != null && vTeam === aTeam && victimEos !== attackerEos;
      const victimPos = posOfEosAt(victimEos, e.time);
      const fromPos = posOfEosAt(attackerEos, e.time);
      const attackerName = attackerEos ? eosToName.get(attackerEos) : undefined;
      if (attackerEos && attackerEos !== victimEos) {
        mapEvents.push({
          kind: teamkill ? 'teamkill' : 'kill',
          tMs: rel(e.time),
          team: aTeam,
          pos: victimPos,
          from: fromPos,
          attackerEOSID: attackerEos,
          victimEOSID: victimEos,
          weapon: cleanWeapon(e.weapon),
          label: `${attackerName ?? 'Unknown'} ${teamkill ? 'team-killed' : 'killed'} ${e.victimName}`,
          detail: cleanWeapon(e.weapon)
        });
      } else {
        mapEvents.push({
          kind: 'death',
          tMs: rel(e.time),
          team: vTeam,
          pos: victimPos,
          victimEOSID: victimEos,
          label: `${e.victimName} died`
        });
      }
    } else if (e.type === 'PLAYER_REVIVED') {
      const pos = posOfEosAt(e.victimEOSID, e.time) ?? posOfEosAt(e.reviverEOSID, e.time);
      mapEvents.push({
        kind: 'revive',
        tMs: rel(e.time),
        team: e.reviverEOSID ? teamOf.get(e.reviverEOSID) : undefined,
        pos,
        attackerEOSID: e.reviverEOSID,
        victimEOSID: e.victimEOSID,
        label: `${e.reviverName} revived ${e.victimName}`
      });
    } else if (e.type === 'FOB_CREATED') {
      mapEvents.push({ kind: 'fob_created', tMs: rel(e.time), team: e.team, pos: np(e.pos), label: `Team ${e.team} FOB built` });
    } else if (e.type === 'FOB_DESTROYED') {
      mapEvents.push({ kind: 'fob_destroyed', tMs: rel(e.time), team: e.team, pos: e.pos ? np(e.pos) : undefined, label: `Team ${e.team} FOB destroyed` });
    } else if (e.type === 'FLAG_CAPTURED') {
      mapEvents.push({ kind: 'flag_captured', tMs: rel(e.time), team: e.team, pos: e.pos ? np(e.pos) : undefined, label: `Team ${e.team} captured ${e.flag}` });
    }
  }

  // vehicle destruction events (first time a vehicle hits 0 hp)
  for (const [id, v] of vTracks) {
    const dead = v.samples.find((s) => s.health <= 0);
    if (dead) {
      mapEvents.push({ kind: 'vehicle_destroyed', tMs: rel(dead.t), team: v.team, pos: np(dead.pos), label: `${v.type} destroyed (Team ${v.team})` });
    }
  }

  mapEvents.sort((a, b) => a.tMs - b.tMs);

  // ---- terrain height field (shared: analysis + deaths + client render) --
  let field = opts.terrainField;
  if (!field) {
    const terrainPts: Vec3[] = [];
    for (const arr of pTracks.values()) for (const s of arr) terrainPts.push(s.pos);
    for (const v of vTracks.values()) for (const s of v.samples) terrainPts.push(s.pos);
    field = buildTerrainField(map.world, terrainPts);
  }

  // ---- projectile detection + plausibility analysis -----------------
  const analysis = buildAnalysis({ events, field, pTracks, nameToEos, eosToName, teamOf, np, rel });

  // indirect-fire (mortar/artillery/rocket) impacts -> explosion markers
  for (const pr of analysis.projectiles) {
    if (pr.weaponFamily === 'explosive') {
      mapEvents.push({
        kind: 'explosion',
        tMs: pr.tMs,
        team: pr.team,
        pos: pr.to,
        label: `${pr.weapon ?? 'Explosive'} impact`,
        radiusM: pr.weapon && /artillery|airstrike/i.test(pr.weapon) ? 50 : 35
      });
    }
  }
  mapEvents.sort((a, b) => a.tMs - b.tMs);

  // ---- deaths / 1v1 engagements ("why you died") --------------------
  const deaths = buildDeaths({ events, field, pTracks, nameToEos, eosToName, teamOf, np, rel, projectiles: analysis.projectiles });

  const terrain = serializeTerrain(field);
  const vehicleTracks = computeVehicleTracks(vTracks, np, rel);

  const markers: MapMarkerPoint[] = [];
  for (const e of events) {
    if (e.type !== 'MAP_MARKER') continue;
    markers.push({ tMs: rel(e.time), type: e.markerType, team: teamOf.get(e.eosID) ?? 0, pos: np(e.pos) });
  }

  // ---- final tickets / faction inference ----------------------------
  const finalTickets: Record<number, number> = {};
  for (const [team, arr] of tickets) finalTickets[team] = arr[arr.length - 1]?.tickets ?? 0;
  if (roundEnded?.winnerTeam && roundEnded.tickets != null) finalTickets[roundEnded.winnerTeam] = roundEnded.tickets;

  const meta: RoundMeta = {
    id: opts.id ?? `${layer}-${new Date(startTime).toISOString().replace(/[:.]/g, '-')}`,
    layer,
    mapKey: map.keys[0] ?? map.name,
    mapName: map.name,
    assetKey: map.assetKey,
    sizeMeters: map.sizeMeters,
    world: map.world,
    startTime,
    endTime,
    durationMs,
    winnerTeam: roundEnded?.winnerTeam,
    factions,
    finalTickets,
    playerCount: Object.keys(players).length,
    serverName: opts.serverName,
    source: opts.source
  };

  // ---- CQB engagement analysis --------------------------------------
  const { engagements, bursts } = buildCQBEngagements(events, deaths, analysis, pTracks, players, teamOf, startTime, meta.id);

  return { meta, players, snapshots, mapEvents, analysis, deaths, terrain, vehicleTracks, markers, events, engagements, bursts };
}

/* --------------------------- vehicle analytics --------------------------- */

const DWELL_RADIUS_CM = 1800; // 18 m
const DWELL_MIN_MS = 30_000;
const MOVING_MPS = 2;
const TELEPORT_MPS = 35; // ~126 km/h — above this a segment is a respawn/teleport

function computeVehicleTracks(
  vTracks: Map<string, { type: string; team: number; samples: VSample[]; comp: Map<string, { t: number; health: number }[]> }>,
  np: (p: Vec3) => NormPos,
  rel: (t: number) => number
): VehicleTrackSummary[] {
  const out: VehicleTrackSummary[] = [];
  for (const [id, v] of vTracks) {
    const s = v.samples;
    if (s.length < 2) continue;
    const path: VehicleTrackSummary['path'] = s.map((x) => {
      const n = np(x.pos);
      return { tMs: rel(x.t), nx: n.nx, ny: n.ny };
    });
    let dist = 0, maxSpeed = 0, standing = 0, active = 0;
    for (let i = 1; i < s.length; i++) {
      const dt = (s[i].t - s[i - 1].t) / 1000;
      if (dt <= 0) continue;
      const dM = Math.hypot(s[i].pos.x - s[i - 1].pos.x, s[i].pos.y - s[i - 1].pos.y) / 100;
      const mps = dM / dt;
      if (mps > TELEPORT_MPS) continue; // ignore respawn/teleport jumps
      dist += dM;
      maxSpeed = Math.max(maxSpeed, mps * 3.6);
      if (mps < MOVING_MPS) standing += dt * 1000;
      else active += dt * 1000;
    }
    // dwell clusters: greedy windows where the vehicle stays within DWELL_RADIUS
    const dwell: VehicleTrackSummary['dwell'] = [];
    let i = 0;
    while (i < s.length) {
      let j = i + 1;
      while (j < s.length && Math.hypot(s[j].pos.x - s[i].pos.x, s[j].pos.y - s[i].pos.y) < DWELL_RADIUS_CM) j++;
      const dur = s[j - 1].t - s[i].t;
      if (dur >= DWELL_MIN_MS && j - i >= 2) {
        let cx = 0, cy = 0;
        for (let k = i; k < j; k++) { cx += s[k].pos.x; cy += s[k].pos.y; }
        const n = np({ x: cx / (j - i), y: cy / (j - i), z: 0 });
        dwell.push({ nx: n.nx, ny: n.ny, fromMs: rel(s[i].t), toMs: rel(s[j - 1].t), durationMs: dur });
        i = j;
      } else i++;
    }
    const destroyed = s.find((x) => x.health <= 0);
    const activeS = active / 1000;
    out.push({
      id,
      type: v.type,
      pool: classifyVehicleType(v.type),
      team: v.team,
      path,
      dwell,
      distanceM: Math.round(dist),
      maxSpeedKmh: Math.round(maxSpeed),
      avgSpeedKmh: activeS > 0 ? Math.round((dist / activeS) * 3.6) : 0,
      activeMs: Math.round(active),
      standingMs: Math.round(standing),
      firstSeenMs: rel(s[0].t),
      lastSeenMs: rel(s[s.length - 1].t),
      destroyedMs: destroyed ? rel(destroyed.t) : undefined
    });
  }
  out.sort((a, b) => b.distanceM - a.distanceM);
  return out;
}

function serializeTerrain(field: TerrainField): TerrainGrid {
  const heights = new Array(field.cells.length);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < field.cells.length; i++) {
    const m = field.cells[i] / 100; // cm -> m
    heights[i] = Math.round(m * 10) / 10;
    if (m < min) min = m;
    if (m > max) max = m;
  }
  return { grid: field.grid, minX: field.minX, minY: field.minY, maxX: field.maxX, maxY: field.maxY, min, max, heights, coverage: field.coverage };
}

/* ----------------------------- death reports ----------------------------- */

interface DeathCtx {
  events: TimelineEvent[];
  field: TerrainField;
  pTracks: Map<string, PSample[]>;
  nameToEos: Map<string, string>;
  eosToName: Map<string, string>;
  teamOf: Map<string, number>;
  np: (p: Vec3) => NormPos;
  rel: (t: number) => number;
  projectiles: ProjectileTrack[];
}

const DMG_WINDOW_MS = 3 * 60 * 1000;

function buildDeaths(c: DeathCtx): DeathReport[] {
  const out: DeathReport[] = [];
  const buf = new Map<string, Array<{ eos: string; dmg: number; t: number; weapon?: string }>>();
  const posAt = (eos: string | undefined, t: number): Vec3 | undefined => {
    if (!eos) return undefined;
    return sampleAt(c.pTracks.get(eos) ?? [], t)?.pos;
  };

  for (const e of c.events) {
    if (e.type === 'PLAYER_DAMAGED') {
      const v = c.nameToEos.get(e.victimName);
      if (!v || !e.attackerEOSID) continue;
      const arr = buf.get(v) ?? [];
      arr.push({ eos: e.attackerEOSID, dmg: e.damage, t: e.time, weapon: e.weapon });
      buf.set(v, arr);
    } else if (e.type === 'PLAYER_REVIVED') {
      if (e.victimEOSID) buf.delete(e.victimEOSID);
    } else if (e.type === 'PLAYER_DIED') {
      const victimEos = c.nameToEos.get(e.victimName);
      const tRel = c.rel(e.time);
      const contribsRaw = (buf.get(victimEos ?? '') ?? []).filter((x) => e.time - x.t <= DMG_WINDOW_MS);
      const byAtk = new Map<string, number>();
      for (const x of contribsRaw) byAtk.set(x.eos, (byAtk.get(x.eos) ?? 0) + x.dmg);
      const contributors: DamageContribution[] = [...byAtk.entries()]
        .map(([eos, damage]) => ({ eosID: eos, name: c.eosToName.get(eos) ?? eos.slice(0, 8), damage: Math.round(damage) }))
        .sort((a, b) => b.damage - a.damage);

      // effective killer: explicit attacker on the Die line, else top contributor
      let killerEos = e.attackerEOSID && e.attackerEOSID !== victimEos ? e.attackerEOSID : contributors[0]?.eosID;
      const vTeam = victimEos ? c.teamOf.get(victimEos) : undefined;
      const kTeam = killerEos ? c.teamOf.get(killerEos) : undefined;
      const teamkill = vTeam != null && kTeam != null && vTeam === kTeam && killerEos !== victimEos;

      let cause: DeathReport['cause'] = 'killed';
      if (!killerEos || killerEos === victimEos) cause = 'gave up';
      else if (!e.attackerEOSID || e.attackerEOSID === victimEos) cause = 'bled out';
      else if (teamkill) cause = 'team-killed';

      const vPos = posAt(victimEos, e.time);
      const kPos = posAt(killerEos, e.time);
      const distanceM = vPos && kPos ? Math.round(Math.hypot(vPos.x - kPos.x, vPos.y - kPos.y) / 100) : undefined;

      // match the killing projectile (nearest in time, same shooter+victim) for
      // plausibility, the actual weapon, and the engagement endpoints
      let proj: ProjectileTrack | undefined;
      let bestDt = Infinity;
      for (const pp of c.projectiles) {
        if (pp.victimEOSID === victimEos && pp.shooterEOSID === killerEos) {
          const dt = Math.abs(pp.tMs - tRel);
          if (dt < bestDt && dt < 12000) { bestDt = dt; proj = pp; }
        }
      }
      const weapon = proj?.weapon ?? cleanWeapon(contribsRaw[contribsRaw.length - 1]?.weapon) ?? cleanWeapon(e.weapon);
      const headshot = isBulletWeapon(weapon) && e.damage >= 95;

      // elevation + line-of-sight profile killer -> victim
      let killerElevationM: number | undefined;
      let victimElevationM: number | undefined;
      let highGroundM: number | undefined;
      let elevationProfile: { ground: number[]; line: number[] } | undefined;
      let hasLineOfSight: boolean | undefined = proj?.plausibility.hasLineOfSight;
      if (kPos && vPos) {
        killerElevationM = round1(terrainHeightAt(c.field, kPos.x, kPos.y) / 100);
        victimElevationM = round1(terrainHeightAt(c.field, vPos.x, vPos.y) / 100);
        highGroundM = round1(killerElevationM - victimElevationM);
        const a = proj ? proj.fromWorld : { x: kPos.x, y: kPos.y, z: kPos.z + 60 };
        const bb = proj ? proj.toWorld : { x: vPos.x, y: vPos.y, z: vPos.z };
        const N = 24;
        const ground: number[] = [];
        const line: number[] = [];
        let blocked = false;
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          const px = a.x + (bb.x - a.x) * t;
          const py = a.y + (bb.y - a.y) * t;
          const g = terrainHeightAt(c.field, px, py) / 100;
          const ln = (a.z + (bb.z - a.z) * t) / 100;
          ground.push(round1(g));
          line.push(round1(ln));
          if (i > 0 && i < N && g > ln + 1.5) blocked = true;
        }
        elevationProfile = { ground, line };
        if (hasLineOfSight == null) hasLineOfSight = !blocked;
      }

      out.push({
        tMs: tRel,
        victimEOSID: victimEos,
        victimName: e.victimName,
        victimTeam: vTeam,
        victimPos: vPos ? c.np(vPos) : undefined,
        killerEOSID: killerEos,
        killerName: killerEos ? c.eosToName.get(killerEos) : undefined,
        killerTeam: kTeam,
        killerPos: kPos ? c.np(kPos) : undefined,
        weapon,
        distanceM,
        headshot,
        teamkill,
        cause,
        contributors,
        plausibility: proj ? { score: proj.plausibility.score, flags: proj.plausibility.flags } : undefined,
        from: proj ? proj.from : kPos ? c.np(kPos) : undefined,
        to: proj ? proj.to : vPos ? c.np(vPos) : undefined,
        killerElevationM,
        victimElevationM,
        highGroundM,
        elevationProfile,
        hasLineOfSight
      });
      if (victimEos) buf.delete(victimEos);
    }
  }
  return out;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function isBulletWeapon(weapon?: string): boolean {
  const w = (weapon ?? '').toLowerCase();
  return /ak|m4|m16|rifle|sniper|svd|carbine|pistol|mg|pkp|pkm|m240|m110|m249/.test(w);
}

/* --------------------------- projectile analysis --------------------------- */

interface AnalysisCtx {
  events: TimelineEvent[];
  field: TerrainField;
  pTracks: Map<string, PSample[]>;
  nameToEos: Map<string, string>;
  eosToName: Map<string, string>;
  teamOf: Map<string, number>;
  np: (p: Vec3) => NormPos;
  rel: (t: number) => number;
}

const SUSPICION_THRESHOLD = 0.5;

function buildAnalysis(c: AnalysisCtx): RoundAnalysis {
  const field = c.field;

  const posAt = (eos: string | undefined, t: number): Vec3 | undefined => {
    if (!eos) return undefined;
    const s = sampleAt(c.pTracks.get(eos) ?? [], t);
    return s?.pos;
  };

  const projectiles: ProjectileTrack[] = [];
  const explicitVictimTimes = new Map<string, number[]>();

  // 1) explicit projectile telemetry
  for (const e of c.events) {
    if (e.type !== 'PROJECTILE') continue;
    const wi = classifyWeapon(e.weapon);
    const pl = analyzeProjectile(field, e.from, e.to, wi);
    projectiles.push({
      tMs: c.rel(e.time),
      shooterEOSID: e.shooterEOSID,
      shooterName: e.shooterEOSID ? c.eosToName.get(e.shooterEOSID) : undefined,
      victimEOSID: e.victimEOSID,
      weapon: cleanWeapon(e.weapon),
      weaponFamily: wi.family,
      from: c.np(e.from),
      to: c.np(e.to),
      fromWorld: e.from,
      toWorld: e.to,
      rangeM: pl.rangeM,
      elevationDeg: pl.elevationDeg,
      speed: e.speed,
      hit: e.hit,
      derived: false,
      team: e.shooterEOSID ? c.teamOf.get(e.shooterEOSID) : undefined,
      plausibility: { score: pl.score, flags: pl.flags, occlusionDepthM: pl.occlusionDepthM, withinRange: pl.withinRange, hasLineOfSight: pl.hasLineOfSight }
    });
    if (e.victimEOSID && e.hit) {
      const arr = explicitVictimTimes.get(e.victimEOSID) ?? [];
      arr.push(e.time);
      explicitVictimTimes.set(e.victimEOSID, arr);
    }
  }

  // 2) derived projectiles from kills lacking explicit telemetry
  for (const e of c.events) {
    if (e.type !== 'PLAYER_DIED') continue;
    const victimEos = c.nameToEos.get(e.victimName);
    const attackerEos = e.attackerEOSID;
    if (!attackerEos || attackerEos === victimEos) continue;
    // skip if an explicit projectile already covers this victim near this time
    const ex = victimEos ? explicitVictimTimes.get(victimEos) : undefined;
    if (ex && ex.some((t) => Math.abs(t - e.time) < 12000)) continue;
    const from = posAt(attackerEos, e.time);
    const to = posAt(victimEos, e.time);
    if (!from || !to) continue;
    const wi = classifyWeapon(e.weapon);
    const pl = analyzeProjectile(field, from, to, wi);
    projectiles.push({
      tMs: c.rel(e.time),
      shooterEOSID: attackerEos,
      shooterName: c.eosToName.get(attackerEos),
      victimEOSID: victimEos,
      weapon: cleanWeapon(e.weapon),
      weaponFamily: wi.family,
      from: c.np(from),
      to: c.np(to),
      fromWorld: from,
      toWorld: to,
      rangeM: pl.rangeM,
      elevationDeg: pl.elevationDeg,
      speed: 0,
      hit: true,
      derived: true,
      team: c.teamOf.get(attackerEos),
      plausibility: { score: pl.score, flags: pl.flags, occlusionDepthM: pl.occlusionDepthM, withinRange: pl.withinRange, hasLineOfSight: pl.hasLineOfSight }
    });
  }

  projectiles.sort((a, b) => a.tMs - b.tMs);
  const suspicious = projectiles.filter((p) => p.plausibility.score < SUSPICION_THRESHOLD);

  // per-player suspicion aggregate (Auto-Mod input)
  const byPlayer = new Map<string, ProjectileTrack[]>();
  for (const p of projectiles) {
    if (!p.shooterEOSID) continue;
    const arr = byPlayer.get(p.shooterEOSID) ?? [];
    arr.push(p);
    byPlayer.set(p.shooterEOSID, arr);
  }
  const playerSuspicion: PlayerSuspicion[] = [];
  for (const [eos, arr] of byPlayer) {
    const susp = arr.filter((p) => p.plausibility.score < SUSPICION_THRESHOLD);
    if (!susp.length) continue;
    const scores = arr.map((p) => p.plausibility.score);
    const flags = new Set<string>();
    for (const p of susp) for (const f of p.plausibility.flags) flags.add(f.replace(/~\d+m|\([0-9.]+m.*?\)|\d+°|\d+m/g, '…'));
    playerSuspicion.push({
      eosID: eos,
      name: c.eosToName.get(eos) ?? eos.slice(0, 8),
      shots: arr.length,
      suspiciousShots: susp.length,
      minScore: Math.min(...scores),
      avgScore: scores.reduce((a, b) => a + b, 0) / scores.length,
      flags: [...flags]
    });
  }
  playerSuspicion.sort((a, b) => b.suspiciousShots - a.suspiciousShots || a.minScore - b.minScore);

  return { terrainCoverage: field.coverage, threshold: SUSPICION_THRESHOLD, projectiles, suspicious, playerSuspicion };
}

function poolForRole(role: string): Pool {
  const p = infantryPoolForRole(role);
  return (p ?? 'Generic') as Pool;
}

function cleanWeapon(w?: string): string | undefined {
  if (!w) return undefined;
  return w
    .replace(/^BP_/, '')
    .replace(/_C(_\d+)?$/, '')
    .replace(/_/g, ' ')
    .trim();
}

/* ─── CQB engagement pipeline ─────────────────────────────────────────────── */

function buildCQBEngagements(
  events: TimelineEvent[],
  deaths: DeathReport[],
  analysis: RoundAnalysis,
  pTracks: Map<string, PSample[]>,
  players: Record<string, RoundPlayer>,
  teamOf: Map<string, number>,
  startTime: number,
  roundId: string
): { engagements: EngagementReport[]; bursts: Record<string, BurstSummary[]> } {
  // Only run if we have explicit direct-fire projectile telemetry (not mortars/explosives)
  const hasProjectiles = analysis.projectiles.some(
    p => !p.derived && p.weaponFamily !== 'explosive' && p.weaponFamily !== 'grenade'
  );
  if (!hasProjectiles) return { engagements: [], bursts: {} };

  // Build the 30 Hz position buffer from pTracks
  const posBuffer = new PositionBuffer();
  for (const [eosID, samples] of pTracks) {
    posBuffer.addSorted(eosID, samples.map(s => ({
      tMs: s.t - startTime,
      pos: s.pos,
      yaw: s.yaw,
      health: s.health,
      team: s.team,
      state: s.state
    })));
  }

  const bullets = buildBulletEvents(events, startTime);
  const burstMap = detectBursts(bullets);
  enrichWithNearMiss(bullets, posBuffer, teamOf);

  const engagements = buildEngagements(bullets, deaths, posBuffer, players, roundId);
  applyCoachingFlags(engagements);

  const bursts: Record<string, BurstSummary[]> = {};
  for (const [eosID, summaries] of burstMap) bursts[eosID] = summaries;

  return { engagements, bursts };
}
