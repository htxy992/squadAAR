import type { TimelineEvent, Vec3 } from '../parser/events.js';
import { resolveMap, worldToNorm, type MapInfo } from '../maps/mapRegistry.js';
import { infantryPoolForRole, type Pool } from '../elo/pools.js';
import { classifyVehicleType } from '../elo/vehicleTypes.js';
import { buildTerrainField, analyzeProjectile, classifyWeapon, type TerrainField } from '../analysis/ballistics.js';
import type { ProjectileTrack, PlayerSuspicion, RoundAnalysis } from './types.js';
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
    const snap: Snapshot = { tMs: rel(t), tickets: {}, players: [], vehicles: [], flags: [], fobs: [] };
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

  // ---- projectile detection + plausibility analysis -----------------
  const analysis = buildAnalysis({
    events,
    startTime,
    map,
    pTracks,
    vTracks,
    nameToEos,
    eosToName,
    teamOf,
    np,
    rel,
    bounds: map.world
  });

  // ---- final tickets / faction inference ----------------------------
  const finalTickets: Record<number, number> = {};
  for (const [team, arr] of tickets) finalTickets[team] = arr[arr.length - 1]?.tickets ?? 0;
  if (roundEnded?.winnerTeam && roundEnded.tickets != null) finalTickets[roundEnded.winnerTeam] = roundEnded.tickets;

  const meta: RoundMeta = {
    id: opts.id ?? `${layer}-${new Date(startTime).toISOString().replace(/[:.]/g, '-')}`,
    layer,
    mapKey: map.keys[0] ?? map.name,
    mapName: map.name,
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

  return { meta, players, snapshots, mapEvents, analysis, events };
}

/* --------------------------- projectile analysis --------------------------- */

interface AnalysisCtx {
  events: TimelineEvent[];
  startTime: number;
  map: MapInfo;
  pTracks: Map<string, PSample[]>;
  vTracks: Map<string, { type: string; team: number; samples: VSample[]; comp: Map<string, { t: number; health: number }[]> }>;
  nameToEos: Map<string, string>;
  eosToName: Map<string, string>;
  teamOf: Map<string, number>;
  np: (p: Vec3) => NormPos;
  rel: (t: number) => number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const SUSPICION_THRESHOLD = 0.5;

function buildAnalysis(c: AnalysisCtx): RoundAnalysis {
  // terrain point cloud from every observed entity position
  const pts: Vec3[] = [];
  for (const arr of c.pTracks.values()) for (const s of arr) pts.push(s.pos);
  for (const v of c.vTracks.values()) for (const s of v.samples) pts.push(s.pos);
  const field: TerrainField = buildTerrainField(c.bounds, pts);

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
    if (ex && ex.some((t) => Math.abs(t - e.time) < 2500)) continue;
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
