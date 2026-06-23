/**
 * Generates a realistic Squad *dedicated-server* log for a full RAAS round.
 *
 * Output mixes two layers (see docs/LOG_FORMAT.md):
 *   - VANILLA lines in the exact syntax every Squad server emits (and that
 *     SquadJS parses): NEW_GAME, PostLogin/Join, OnPossess, ActualDamage,
 *     Wound()/Die(), revived, round result.
 *   - EXTENDED `LogSquadStats:` telemetry that a server plugin would add:
 *     player/vehicle positions, cap zones, FOBs, tickets, and per-shot
 *     `Projectile:` lines (incl. a few deliberately implausible wallbang /
 *     impossible-range shots to exercise the plausibility analyzer).
 *
 * Run: `npm run gen:sample` -> writes data/logs/SquadGame-sample.log
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { formatLogTime } from '../util/time.js';

// ----------------------------- RNG (seeded) --------------------------------
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------- terrain -------------------------------------
interface Hill {
  cx: number;
  cy: number;
  h: number;
  r: number;
}
const HILLS: Hill[] = [
  { cx: 0, cy: 0, h: 5500, r: 32000 }, // central ridge that blocks LOS
  { cx: -80000, cy: 60000, h: 3000, r: 26000 },
  { cx: 70000, cy: -70000, h: 3500, r: 28000 }
];
export function terrainZ(x: number, y: number): number {
  let z = 1000 + 600 * Math.sin(x / 30000) * Math.cos(y / 28000);
  for (const hl of HILLS) z += hl.h * Math.exp(-((x - hl.cx) ** 2 + (y - hl.cy) ** 2) / (2 * hl.r ** 2));
  return z;
}
const STAND = 95; // entity capsule offset above ground

// ----------------------------- config --------------------------------------
const HALF = 195000; // ±1950 m world (Harju is ±2016 m)
const PER_TEAM = 25;
const TICK_MS = 5000;
const DURATION_MS = 24 * 60 * 1000;
const SQUAD_SIZE = 9;

const USA_ROLES = ['USA_SL_01', 'USA_Medic_01', 'USA_LAT_01', 'USA_Rifleman_01', 'USA_Rifleman_02', 'USA_AutomaticRifleman_01', 'USA_Grenadier_01', 'USA_Marksman_01', 'USA_CombatEngineer_01'];
const RUS_ROLES = ['RUS_SL_01', 'RUS_Medic_01', 'RUS_HAT_01', 'RUS_Rifleman_01', 'RUS_Rifleman_02', 'RUS_MachineGunner_01', 'RUS_Grenadier_01', 'RUS_Marksman_01', 'RUS_Sapper_01'];
const SOLDIER = (role: string) => `BP_Soldier_${role}`;
const WEAPON_BY_ROLE: Record<string, string> = {
  Rifleman: 'BP_M4A1',
  AutomaticRifleman: 'BP_M249',
  MachineGunner: 'BP_PKP',
  Marksman: 'BP_M110',
  Grenadier: 'BP_M4A1_M203',
  LAT: 'BP_M4A1',
  HAT: 'BP_M4A1',
  Medic: 'BP_M4A1',
  SL: 'BP_M4A1',
  CombatEngineer: 'BP_M4A1',
  Sapper: 'BP_AK74'
};
function weaponForRole(role: string): string {
  for (const k of Object.keys(WEAPON_BY_ROLE)) if (role.includes(k)) return WEAPON_BY_ROLE[k];
  return 'BP_AK74';
}

const NAMES = [
  'Vidar', 'Bjorn', 'Sven', 'Algol', 'Jerson', 'illest', 'Laim', 'solmir', 'Timbow', 'Fletschoa', 'KappaKay', 'Ghost', 'Razor', 'Maverick', 'Hawk', 'Viper', 'Wolf', 'Bear', 'Tango', 'Delta', 'Echo', 'Foxtrot', 'Spectre', 'Nomad', 'Reaper', 'Saint', 'Diesel', 'Comrade', 'Ivan', 'Dmitri', 'Sasha', 'Yuri', 'Boris', 'Mikhail', 'Pavel', 'Anton', 'Oleg', 'Igor', 'Niko', 'Stalker', 'Bandit', 'Cipher', 'Quill', 'Frost', 'Ember', 'Talon', 'Onyx', 'Vega', 'Lynx', 'Crow'
];

interface Vehicle {
  id: string;
  type: string;
  team: number;
  pos: { x: number; y: number };
  yaw: number;
  turretYaw: number;
  hp: number;
  maxHp: number;
  components: Record<string, number>;
  alive: boolean;
  crew: Sim[];
}
interface Sim {
  eos: string;
  steam: string;
  name: string;
  controller: string;
  team: number;
  squad: number;
  role: string;
  soldierClass: string;
  weapon: string;
  pos: { x: number; y: number };
  yaw: number;
  hp: number;
  alive: boolean;
  wounded: boolean;
  respawnAt: number;
  isSL: boolean;
  isMedic: boolean;
  vehicle?: Vehicle;
  holdUntil?: number;
}

interface Line {
  t: number;
  body: string;
}

function hex(rand: () => number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

function main() {
  const rand = mulberry32(20260610);
  const start = Date.UTC(2026, 5, 10, 19, 5, 0); // 2026-06-10 19:05 UTC
  const lines: Line[] = [];
  let chain = 100;
  const emit = (t: number, body: string) => lines.push({ t, body });

  // -- flags along a diagonal lane crossing the central ridge ---------------
  const flagNames = ['Ridgeline', 'Quarry', 'Central_Hill', 'Watchtower', 'Outpost'];
  const flags = flagNames.map((name, i) => {
    const f = i / (flagNames.length - 1);
    return { name, x: -170000 + f * 340000, y: -170000 + f * 340000 };
  });

  // -- build rosters --------------------------------------------------------
  const usedNames = new Set<string>();
  const pickName = (i: number) => {
    let n = NAMES[i % NAMES.length];
    while (usedNames.has(n)) n = n + (Math.floor(rand() * 90) + 10);
    usedNames.add(n);
    return n;
  };

  const players: Sim[] = [];
  let ctrl = 2147400000;
  const mkTeam = (team: number, roles: string[], mainX: number, mainY: number) => {
    const count = PER_TEAM;
    for (let i = 0; i < count; i++) {
      const squad = Math.floor(i / SQUAD_SIZE) + 1;
      const role = roles[i % roles.length];
      const name = pickName(team * 100 + i);
      players.push({
        eos: hex(rand, 32),
        steam: '7656' + Math.floor(rand() * 1e13).toString().padStart(13, '0'),
        name,
        controller: `BP_PlayerController_C_${ctrl++}`,
        team,
        squad,
        role,
        soldierClass: SOLDIER(role),
        weapon: weaponForRole(role),
        pos: { x: mainX + (rand() - 0.5) * 20000, y: mainY + (rand() - 0.5) * 20000 },
        yaw: 0,
        hp: 100,
        alive: true,
        wounded: false,
        respawnAt: 0,
        isSL: role.includes('_SL_'),
        isMedic: role.includes('Medic')
      });
    }
  };
  mkTeam(1, USA_ROLES, -185000, -185000);
  mkTeam(2, RUS_ROLES, 185000, 185000);

  // -- vehicles -------------------------------------------------------------
  let vid = 2147500000;
  const vehicles: Vehicle[] = [
    mkVeh(1, 'M1A2', -120000, -120000),
    mkVeh(1, 'M1126', -110000, -125000),
    mkVeh(2, 'T72B3', 120000, 120000),
    mkVeh(2, 'BMP2', 110000, 125000)
  ];
  function mkVeh(team: number, type: string, x: number, y: number): Vehicle {
    const maxHp = type === 'M1A2' || type === 'T72B3' ? 3000 : 1500;
    return {
      id: `BP_${type}_C_${vid++}`,
      type,
      team,
      pos: { x, y },
      yaw: 0,
      turretYaw: 0,
      hp: maxHp,
      maxHp,
      components: { Engine: 100, TurretDrive: 100, LeftTrack: 100, RightTrack: 100, Barrel: 100 },
      alive: true,
      crew: []
    };
  }
  // assign 2 crew per vehicle from each team's first squad, mark crewman role
  const assignedCrew = new Set<string>();
  for (const v of vehicles) {
    const crewRole = v.team === 1 ? 'USA_Crewman_01' : 'RUS_Crewman_01';
    const cand = players.filter((p) => p.team === v.team && !assignedCrew.has(p.eos) && !p.isSL && !p.isMedic).slice(0, 2);
    for (const c of cand) {
      assignedCrew.add(c.eos);
      c.role = crewRole;
      c.soldierClass = SOLDIER(crewRole);
      c.vehicle = v;
      v.crew.push(c);
    }
  }

  // -- round bootstrap lines ------------------------------------------------
  emit(start - 8000, `LogWorld: Bringing World /Game/Maps/Harju/Gameplay_Layers/Harju_RAAS_v1.Harju_RAAS_v1`);
  for (const p of players) {
    emit(start - 6000, `LogSquad: PostLogin: NewPlayer: BP_PlayerController_C /Game/Maps/Harju/Harju.Harju:PersistentLevel.${p.controller} (IP: 10.0.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)} | Online IDs: EOS: ${p.eos} steam: ${p.steam})`);
    emit(start - 5990, `LogNet: Join succeeded: ${p.name}`);
  }
  // squad creation + possess
  for (const p of players) {
    emit(start - 4000, `LogSquadStats: SquadCreated: team=${p.team} squad=${p.squad} name=Squad${p.squad} creator=${p.eos}`);
    emit(start - 3500, `LogSquadTrace: [DedicatedServer]ASQPlayerController::OnPossess(): PC=${p.name} (Online IDs: EOS: ${p.eos} steam: ${p.steam}) Pawn=${p.soldierClass}_C_${vid++}`);
    emit(start - 3400, `LogSquadStats: PlayerRole: eos=${p.eos} role=${p.role} lead=${p.isSL ? 1 : 0}`);
  }

  // -- FOBs -----------------------------------------------------------------
  const fobs: Array<{ id: string; team: number; x: number; y: number; createMs: number; destroyMs?: number; creator: string }> = [];
  const slOf = (team: number, squad: number) => players.find((p) => p.team === team && p.squad === squad && p.isSL);
  const addFob = (team: number, x: number, y: number, atMs: number) => {
    const sl = slOf(team, 1) ?? players.find((p) => p.team === team && p.isSL);
    const id = `BP_FOBRadius_C_${vid++}`;
    fobs.push({ id, team, x, y, createMs: atMs, creator: sl?.eos ?? '' });
    const z = terrainZ(x, y).toFixed(1);
    emit(atMs, `LogSquadStats: FobCreated: fob=${id} team=${team} pos=${x.toFixed(1)},${y.toFixed(1)},${z} creator=${sl?.eos ?? '-'}`);
    // HAB spawn + a couple of emplacements next to the FOB
    emit(atMs + 50, `LogSquadStats: SpawnCreated: kind=HAB team=${team} squad=1 pos=${(x + 1500).toFixed(1)},${(y + 1500).toFixed(1)},${z}`);
    const empl = team === 1 ? ['HMG', 'TOW'] : ['HMG', 'Kornet'];
    empl.forEach((tp, i) => emit(atMs + 100 + i * 10, `LogSquadStats: Deployable: type=${tp} team=${team} pos=${(x + (i ? 3500 : -3500)).toFixed(1)},${(y + 2500).toFixed(1)},${z}`));
  };
  addFob(1, -90000, -90000, start + 60000);
  addFob(2, 90000, 90000, start + 60000);
  addFob(1, -10000, -20000, start + 8 * 60000);
  addFob(2, 25000, 15000, start + 9 * 60000);

  // -- ticket state ---------------------------------------------------------
  const tickets: Record<number, number> = { 1: 250, 2: 250 };
  const flagOwner: Record<string, number> = {};
  let capturedCount = 0;

  // -- simulation loop ------------------------------------------------------
  const aliveEnemiesNear = (p: Sim, range: number) =>
    players.filter((q) => q.alive && !q.wounded && q.team !== p.team && dist(p.pos, q.pos) < range);

  const respawn = (p: Sim, now: number) => {
    const fob = fobs.find((f) => f.team === p.team && (!f.destroyMs || f.destroyMs > now));
    const base = fob ? { x: fob.x, y: fob.y } : p.team === 1 ? { x: -185000, y: -185000 } : { x: 185000, y: 185000 };
    p.pos = { x: base.x + (rand() - 0.5) * 12000, y: base.y + (rand() - 0.5) * 12000 };
    p.alive = true;
    p.wounded = false;
    p.hp = 100;
    emit(now, `LogSquadTrace: [DedicatedServer]ASQPlayerController::OnPossess(): PC=${p.name} (Online IDs: EOS: ${p.eos} steam: ${p.steam}) Pawn=${p.soldierClass}_C_${vid++}`);
    emit(now + 5, `LogSquadStats: PlayerSpawn: eos=${p.eos} spawn=${fob ? 'FOB' : 'Main'} pos=${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)},${terrainZ(p.pos.x, p.pos.y).toFixed(1)}`);
  };

  const objectiveFor = (team: number, tNorm: number) => {
    // team1 pushes from flag0 -> flag4 over time, team2 the reverse; converge on contested flag
    const idx = Math.min(flags.length - 1, Math.floor(tNorm * flags.length));
    return flags[Math.min(flags.length - 1, idx)];
  };

  const woundList: Array<{ p: Sim; at: number; attacker?: Sim }> = [];

  for (let t = start; t <= start + DURATION_MS; t += TICK_MS) {
    const tNorm = (t - start) / DURATION_MS;
    const contested = flags[Math.min(flags.length - 1, Math.floor(tNorm * (flags.length - 0.001)))];

    // movement: advance toward objective with noise; crew ride vehicles
    for (const p of players) {
      if (!p.alive) {
        if (t >= p.respawnAt) respawn(p, t);
        else continue;
      }
      // crews hold overwatch positions periodically -> creates routes + dwell
      if (p.vehicle && p.holdUntil && t < p.holdUntil) continue;
      const obj = p.vehicle ? objectiveFor(p.team, tNorm) : objectiveFor(p.team, tNorm);
      const spread = p.vehicle ? 60000 : 45000;
      const tx = obj.x + (rand() - 0.5) * spread;
      const ty = obj.y + (rand() - 0.5) * spread;
      const spd = p.vehicle ? 4200 : 1500;
      p.pos.x += clampMag(tx - p.pos.x, spd);
      p.pos.y += clampMag(ty - p.pos.y, spd);
      p.yaw = (Math.atan2(ty - p.pos.y, tx - p.pos.x) * 180) / Math.PI;
      // once near the objective, a crew may set up and hold (overwatch / camp)
      if (p.vehicle && Math.hypot(obj.x - p.pos.x, obj.y - p.pos.y) < 50000 && (!p.holdUntil || t > p.holdUntil + 30000) && rand() < 0.3) {
        p.holdUntil = t + 60000 + Math.floor(rand() * 120000);
      }
    }
    // vehicles follow their crew driver
    for (const v of vehicles) {
      if (!v.alive) continue;
      const driver = v.crew[0];
      if (driver && driver.alive) {
        v.pos = { ...driver.pos };
        v.yaw = driver.yaw;
        v.turretYaw = (v.turretYaw + (rand() - 0.5) * 40 + 360) % 360;
      }
    }

    // emit telemetry
    for (const p of players) {
      if (!p.alive && t < p.respawnAt) continue;
      const z = terrainZ(p.pos.x, p.pos.y) + STAND;
      const state = p.wounded ? 'wound' : p.alive ? 'alive' : 'dead';
      emit(t, `LogSquadStats: PlayerPos: eos=${p.eos} ctrl=${p.controller} pos=${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)},${z.toFixed(1)} yaw=${p.yaw.toFixed(1)} hp=${p.hp.toFixed(1)} team=${p.team} squad=${p.squad} role=${p.role} state=${state}`);
    }
    for (const v of vehicles) {
      if (!v.alive) continue;
      const z = terrainZ(v.pos.x, v.pos.y) + 120;
      emit(t, `LogSquadStats: VehiclePos: veh=${v.id} type=${v.type} pos=${v.pos.x.toFixed(1)},${v.pos.y.toFixed(1)},${z.toFixed(1)} yaw=${v.yaw.toFixed(1)} tyaw=${v.turretYaw.toFixed(1)} hp=${v.hp.toFixed(1)}/${v.maxHp.toFixed(1)} team=${v.team}`);
      for (const [c, h] of Object.entries(v.components)) emit(t, `LogSquadStats: VehicleComp: veh=${v.id} comp=${c} hp=${h.toFixed(1)}`);
    }

    // cap zone progress on the contested flag
    const capTeam = tNorm < 0.5 ? 1 : tNorm < 0.85 ? (rand() > 0.4 ? 1 : 2) : 2;
    const progress = Math.min(1, ((t - start) % (DURATION_MS / flags.length)) / (DURATION_MS / flags.length / 1.2));
    emit(t, `LogSquadStats: CapZone: flag=${contested.name} pos=${contested.x.toFixed(1)},${contested.y.toFixed(1)},${terrainZ(contested.x, contested.y).toFixed(1)} team=${capTeam} progress=${progress.toFixed(2)} status=Contested`);
    if (progress > 0.98 && capturedCount < flags.length) {
      const f = flags[capturedCount];
      flagOwner[f.name] = capTeam;
      emit(t, `LogSquadStats: FlagCaptured: flag=${f.name} team=${capTeam} pos=${f.x.toFixed(1)},${f.y.toFixed(1)},${terrainZ(f.x, f.y).toFixed(1)}`);
      capturedCount++;
    }

    // tickets drift
    if ((t - start) % 30000 === 0) {
      emit(t, `LogSquadStats: Tickets: team=1 tickets=${tickets[1].toFixed(0)}`);
      emit(t, `LogSquadStats: Tickets: team=2 tickets=${tickets[2].toFixed(0)}`);
    }
    // rally points: each SL drops one near themselves periodically
    if ((t - start) % 90000 === 45000) {
      for (const sl of players.filter((p) => p.isSL && p.alive)) {
        emit(t, `LogSquadStats: SpawnCreated: kind=RallyPoint team=${sl.team} squad=${sl.squad} pos=${sl.pos.x.toFixed(1)},${sl.pos.y.toFixed(1)},${(terrainZ(sl.pos.x, sl.pos.y) + STAND).toFixed(1)}`);
      }
    }
    // SLs / crews spot nearby enemies -> map markers
    if ((t - start) % 20000 === 0) {
      for (const sp of players.filter((p) => (p.isSL || p.vehicle) && p.alive).slice(0, 8)) {
        const enemy = aliveEnemiesNear(sp, 80000)[0];
        if (enemy) {
          const type = enemy.vehicle ? 'enemy_vehicle' : 'enemy_infantry';
          emit(t, `LogSquadStats: MapMarker: eos=${sp.eos} type=${type} pos=${enemy.pos.x.toFixed(1)},${enemy.pos.y.toFixed(1)},${(terrainZ(enemy.pos.x, enemy.pos.y) + STAND).toFixed(1)}`);
        }
      }
    }

    // combat: each tick, a handful of engagements between nearby enemies w/ LOS
    const skirmishes = 1 + Math.floor(rand() * 3);
    for (let s = 0; s < skirmishes; s++) {
      const shooters = players.filter((p) => p.alive && !p.wounded && !p.vehicle);
      const atk = shooters[Math.floor(rand() * shooters.length)];
      if (!atk) continue;
      const targets = aliveEnemiesNear(atk, 60000).filter((q) => hasLOS(atk.pos, q.pos));
      if (!targets.length) continue;
      const vic = targets[Math.floor(rand() * targets.length)];
      doKill(t, atk, vic, false);
    }

    // suppressive fire: tracers that miss, so "where bullets went" is visible
    const supp = 2 + Math.floor(rand() * 4);
    for (let s = 0; s < supp; s++) {
      const shooters = players.filter((p) => p.alive && !p.wounded && !p.vehicle);
      const atk = shooters[Math.floor(rand() * shooters.length)];
      if (!atk) continue;
      const targets = aliveEnemiesNear(atk, 50000).filter((q) => hasLOS(atk.pos, q.pos));
      if (!targets.length) continue;
      const tgt = targets[Math.floor(rand() * targets.length)];
      emitMiss(t + Math.floor(rand() * TICK_MS), atk, tgt);
    }

    // medic revives ~half of recent wounds
    for (const w of woundList.splice(0)) {
      if (t - w.at > 25000) continue;
      if (rand() < 0.45) {
        const medic = players.find((m) => m.alive && m.team === w.p.team && m.isMedic && dist(m.pos, w.p.pos) < 30000);
        if (medic && w.p.wounded) {
          w.p.wounded = false;
          w.p.alive = true;
          w.p.hp = 60;
          emit(t + 1200, `LogSquad: ${medic.name} (Online IDs: EOS: ${medic.eos} steam: ${medic.steam}) has revived ${w.p.name} (Online IDs: EOS: ${w.p.eos} steam: ${w.p.steam}).`);
        } else schedDeath(t, w.p, w.attacker);
      } else schedDeath(t, w.p, w.attacker);
    }
  }

  // ---- scripted special events -------------------------------------------
  // SUSPICIOUS wallbang: shooter behind central ridge kills target on far side (no LOS)
  scriptedSuspicious(start + 11 * 60000, 1, 2, 'wallbang');
  scriptedSuspicious(start + 16 * 60000, 2, 1, 'range');

  // Scripted CQB 1v1s with full aim telemetry (offset +2300 ms so the burst
  // window never overlaps a 5 s sim tick that would clobber the duel positions).
  cqbDuel(start + 4 * 60000 + 2300, 1, 2);
  cqbDuel(start + 7 * 60000 + 2300, 2, 1);
  cqbDuel(start + 12 * 60000 + 2300, 1, 2);
  cqbDuel(start + 15 * 60000 + 2300, 2, 1);
  cqbDuel(start + 20 * 60000 + 2300, 1, 2);

  // enemy FOB destruction (team1 destroys team2's forward FOB) -> tickets
  {
    const tDes = start + 14 * 60000;
    const f = fobs.find((x) => x.team === 2 && x.x === 25000);
    if (f) {
      f.destroyMs = tDes;
      // a few team1 players nearby + deployable damage lines
      const near = players.filter((p) => p.team === 1).slice(0, 3);
      for (const p of near) {
        p.pos = { x: f.x + (rand() - 0.5) * 8000, y: f.y + (rand() - 0.5) * 8000 };
        emit(tDes - 2000, `LogSquadStats: PlayerPos: eos=${p.eos} ctrl=${p.controller} pos=${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)},${(terrainZ(p.pos.x, p.pos.y) + STAND).toFixed(1)} yaw=0 hp=100 team=1 squad=${p.squad} role=${p.role} state=alive`);
        emit(tDes - 1000, `LogSquadTrace: [DedicatedServer]ASQDeployable::TakeDamage(): ${f.id.replace(/_C_\d+$/, '')}_C_${vid++}: 350.0 damage attempt by causer BP_M67Grenade_C_${vid++} instigator ${p.name} with damage type BP_Explosive_DamageType_C health remaining 0.0`);
      }
      emit(tDes, `LogSquadStats: FobDestroyed: fob=${f.id} team=2 pos=${f.x.toFixed(1)},${f.y.toFixed(1)},${terrainZ(f.x, f.y).toFixed(1)}`);
      tickets[2] -= 20;
    }
  }

  // vehicle destruction: team1 HAT/AT kills team2 BMP2
  {
    const tv = start + 18 * 60000;
    const bmp = vehicles.find((v) => v.type === 'BMP2');
    const at = players.find((p) => p.team === 1 && p.role.includes('LAT')) ?? players.find((p) => p.team === 1);
    if (bmp && at) {
      bmp.pos = { x: 30000, y: 20000 };
      at.pos = { x: 18000, y: 12000 };
      const fromZ = terrainZ(at.pos.x, at.pos.y) + STAND;
      const toZ = terrainZ(bmp.pos.x, bmp.pos.y) + 120;
      for (let k = 0; k < 3; k++) {
        emit(tv + k * 1500, `LogSquadStats: VehicleDamage: veh=${bmp.id} type=${bmp.type} attacker=${at.eos} dmg=${(bmp.maxHp / 2.5).toFixed(1)} dtype=HEAT direct=1`);
        emit(tv + k * 1500 + 10, `LogSquadStats: Projectile: shooter=${at.eos} weapon=BP_M72LAW from=${at.pos.x.toFixed(1)},${at.pos.y.toFixed(1)},${fromZ.toFixed(1)} to=${bmp.pos.x.toFixed(1)},${bmp.pos.y.toFixed(1)},${toZ.toFixed(1)} speed=300 hit=1 victim=-`);
      }
      emit(tv + 4600, `LogSquadStats: VehicleComp: veh=${bmp.id} comp=Engine hp=0.0`);
      emit(tv + 4700, `LogSquadStats: VehicleComp: veh=${bmp.id} comp=LeftTrack hp=0.0`);
      emit(tv + 4800, `LogSquadStats: VehiclePos: veh=${bmp.id} type=${bmp.type} pos=${bmp.pos.x.toFixed(1)},${bmp.pos.y.toFixed(1)},${toZ.toFixed(1)} yaw=0 tyaw=0 hp=0.0/${bmp.maxHp.toFixed(1)} team=2`);
      bmp.alive = false;
      tickets[2] -= 11;
    }
  }

  // mortar barrages (indirect fire) onto contested objectives
  function mortarBarrage(t: number, team: number, target: { x: number; y: number }, rounds: number) {
    const shooter = players.find((p) => p.team === team && p.isSL) ?? players.find((p) => p.team === team);
    if (!shooter) return;
    // mortar emplacement well behind the line
    const mortar = { x: shooter.pos.x, y: shooter.pos.y };
    for (let i = 0; i < rounds; i++) {
      const it = t + i * 4000;
      const ix = target.x + (rand() - 0.5) * 12000;
      const iy = target.y + (rand() - 0.5) * 12000;
      const fromZ = terrainZ(mortar.x, mortar.y) + 100;
      const toZ = terrainZ(ix, iy) + STAND;
      emit(it, `LogSquadStats: Projectile: shooter=${shooter.eos} weapon=BP_Mortar_Projectile from=${mortar.x.toFixed(1)},${mortar.y.toFixed(1)},${fromZ.toFixed(1)} to=${ix.toFixed(1)},${iy.toFixed(1)},${toZ.toFixed(1)} speed=110 hit=1 victim=-`);
      // sometimes catch an enemy in the blast
      const caught = players.find((p) => p.alive && !p.wounded && p.team !== team && Math.hypot(p.pos.x - ix, p.pos.y - iy) < 4000);
      if (caught) {
        emit(it + 10, `LogSquad: Player:${caught.name} ActualDamage=140.000 from ${shooter.name} (Online IDs: EOS: ${shooter.eos} steam: ${shooter.steam} | Player Controller ID: ${shooter.controller})caused by BP_Mortar_Projectile_C`);
        emit(it + 20, `LogSquadTrace: [DedicatedServer]ASQSoldier::Wound(): Player:${caught.name} KillingDamage=-140.000000 from ${shooter.controller} (Online IDs: EOS: ${shooter.eos} steam: ${shooter.steam} | Controller ID: ${shooter.controller}) caused by BP_Mortar_Projectile_C`);
        emit(it + 1500, `LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:${caught.name} KillingDamage=-140.000000 from ${shooter.controller} (Online IDs: EOS: ${shooter.eos} steam: ${shooter.steam} | Contoller ID: ${shooter.controller}) caused by BP_Mortar_Projectile_C`);
        caught.wounded = false; caught.alive = false; caught.respawnAt = it + 25000;
      }
    }
  }
  mortarBarrage(start + 9 * 60000, 1, flags[2], 6);
  mortarBarrage(start + 19 * 60000, 2, flags[3], 7);

  // logistics deliveries
  for (let i = 0; i < 6; i++) {
    const t = start + (3 + i * 3) * 60000;
    const team = i % 2 === 0 ? 1 : 2;
    const fob = fobs.find((f) => f.team === team);
    const logiSL = players.find((p) => p.team === team && p.isSL);
    if (fob && logiSL) emit(t, `LogSquadStats: AmmoDelivery: fob=${fob.id} eos=${logiSL.eos} amount=${500 + Math.floor(rand() * 1000)}`);
  }

  // ---- round end ----------------------------------------------------------
  const endT = start + DURATION_MS + 5000;
  const winner = tickets[1] >= tickets[2] ? 1 : 2;
  const winFac = winner === 1 ? ['USA', 'US Army'] : ['RUS', 'Russian Ground Forces'];
  const losFac = winner === 1 ? ['RUS', 'Russian Ground Forces'] : ['USA', 'US Army'];
  emit(endT, `LogSquadStats: Tickets: team=1 tickets=${tickets[1].toFixed(0)}`);
  emit(endT, `LogSquadStats: Tickets: team=2 tickets=${tickets[2].toFixed(0)}`);
  emit(endT + 100, `LogSquadGameEvents: Display: Team ${winner}, ${winFac[0]} ( ${winFac[1]} ) has won the match with ${Math.max(tickets[winner], 1).toFixed(0)} Tickets on layer Harju RAAS v1 (level Harju)!`);
  emit(endT + 110, `LogSquadGameEvents: Display: Team ${winner === 1 ? 2 : 1}, ${losFac[0]} ( ${losFac[1]} ) has lost the match with 0 Tickets on layer Harju RAAS v1 (level Harju)!`);
  emit(endT + 200, `LogGameState: Match State Changed from InProgress to WaitingPostMatch`);

  // ---- helpers that mutate sim & emit ------------------------------------
  function schedDeath(t: number, p: Sim, attacker?: Sim) {
    if (!p.wounded && !p.alive) return;
    const a = attacker ?? p; // self => give-up
    emit(t + 1500, `LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:${p.name} KillingDamage=-100.000000 from ${a.controller} (Online IDs: EOS: ${a.eos} steam: ${a.steam} | Contoller ID: ${a.controller}) caused by ${a.soldierClass}_C`);
    emit(t + 1505, `LogSquadStats: PlayerPos: eos=${p.eos} ctrl=${p.controller} pos=${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)},${(terrainZ(p.pos.x, p.pos.y) + STAND).toFixed(1)} yaw=${p.yaw.toFixed(1)} hp=0 team=${p.team} squad=${p.squad} role=${p.role} state=dead`);
    p.alive = false;
    p.wounded = false;
    p.respawnAt = t + 20000 + Math.floor(rand() * 15000);
  }

  function emitMiss(t: number, atk: Sim, tgt: Sim) {
    const ox = (rand() - 0.5) * 4500, oy = (rand() - 0.5) * 4500;
    const to = { x: tgt.pos.x + ox, y: tgt.pos.y + oy };
    const fromZ = terrainZ(atk.pos.x, atk.pos.y) + STAND + 60;
    const toZ = terrainZ(to.x, to.y) + STAND;
    emit(t, `LogSquadStats: Projectile: shooter=${atk.eos} weapon=${atk.weapon} from=${atk.pos.x.toFixed(1)},${atk.pos.y.toFixed(1)},${fromZ.toFixed(1)} to=${to.x.toFixed(1)},${to.y.toFixed(1)},${toZ.toFixed(1)} speed=850 hit=0 victim=-`);
  }

  function doKill(t: number, atk: Sim, vic: Sim, suspicious: boolean) {
    const d = dist(atk.pos, vic.pos);
    const rng = d / 100;
    const fromZ = terrainZ(atk.pos.x, atk.pos.y) + STAND + 60; // eye height
    const toZ = terrainZ(vic.pos.x, vic.pos.y) + STAND;
    const dmg = 60 + rand() * 50;
    // damage line (ActualDamage) - attacker IDs + name
    emit(t, `LogSquad: Player:${vic.name} ActualDamage=${dmg.toFixed(3)} from ${atk.name} (Online IDs: EOS: ${atk.eos} steam: ${atk.steam} | Player Controller ID: ${atk.controller})caused by ${atk.soldierClass}_C`);
    // explicit projectile
    emit(t + 5, `LogSquadStats: Projectile: shooter=${atk.eos} weapon=${atk.weapon} from=${atk.pos.x.toFixed(1)},${atk.pos.y.toFixed(1)},${fromZ.toFixed(1)} to=${vic.pos.x.toFixed(1)},${vic.pos.y.toFixed(1)},${toZ.toFixed(1)} speed=850 hit=1 victim=${vic.eos}`);
    // wound (note "Controller ID" spelling for Wound)
    emit(t + 20, `LogSquadTrace: [DedicatedServer]ASQSoldier::Wound(): Player:${vic.name} KillingDamage=-${dmg.toFixed(6)} from ${atk.controller} (Online IDs: EOS: ${atk.eos} steam: ${atk.steam} | Controller ID: ${atk.controller}) caused by ${atk.soldierClass}_C`);
    vic.wounded = true;
    vic.alive = true; // wounded but not yet dead
    vic.hp = 0;
    woundList.push({ p: vic, at: t, attacker: atk });
  }

  function scriptedSuspicious(t: number, atkTeam: number, vicTeam: number, kind: 'wallbang' | 'range') {
    const atk = players.find((p) => p.team === atkTeam && !p.vehicle && p.role.includes('Marksman')) ?? players.find((p) => p.team === atkTeam);
    const vic = players.find((p) => p.team === vicTeam && !p.vehicle);
    if (!atk || !vic) return;
    atk.alive = vic.alive = true;
    atk.wounded = vic.wounded = false;
    if (kind === 'wallbang') {
      // place attacker and victim on opposite low sides of the central ridge
      atk.pos = { x: -38000, y: 38000 };
      vic.pos = { x: 38000, y: -38000 };
      atk.weapon = 'BP_M110';
    } else {
      // impossible-range cross-map shot
      atk.pos = { x: -140000, y: -140000 };
      vic.pos = { x: 140000, y: 140000 };
      atk.weapon = 'BP_M4A1';
    }
    const fromZ = terrainZ(atk.pos.x, atk.pos.y) + STAND + 60;
    const toZ = terrainZ(vic.pos.x, vic.pos.y) + STAND;
    // ensure positions are observed in tracks around this time
    emit(t - 100, `LogSquadStats: PlayerPos: eos=${atk.eos} ctrl=${atk.controller} pos=${atk.pos.x.toFixed(1)},${atk.pos.y.toFixed(1)},${(terrainZ(atk.pos.x, atk.pos.y) + STAND).toFixed(1)} yaw=0 hp=100 team=${atk.team} squad=${atk.squad} role=${atk.role} state=alive`);
    emit(t - 100, `LogSquadStats: PlayerPos: eos=${vic.eos} ctrl=${vic.controller} pos=${vic.pos.x.toFixed(1)},${vic.pos.y.toFixed(1)},${toZ.toFixed(1)} yaw=0 hp=100 team=${vic.team} squad=${vic.squad} role=${vic.role} state=alive`);
    emit(t, `LogSquad: Player:${vic.name} ActualDamage=120.000 from ${atk.name} (Online IDs: EOS: ${atk.eos} steam: ${atk.steam} | Player Controller ID: ${atk.controller})caused by ${atk.soldierClass}_C`);
    emit(t + 5, `LogSquadStats: Projectile: shooter=${atk.eos} weapon=${atk.weapon} from=${atk.pos.x.toFixed(1)},${atk.pos.y.toFixed(1)},${fromZ.toFixed(1)} to=${vic.pos.x.toFixed(1)},${vic.pos.y.toFixed(1)},${toZ.toFixed(1)} speed=850 hit=1 victim=${vic.eos}`);
    emit(t + 20, `LogSquadTrace: [DedicatedServer]ASQSoldier::Wound(): Player:${vic.name} KillingDamage=-120.000000 from ${atk.controller} (Online IDs: EOS: ${atk.eos} steam: ${atk.steam} | Controller ID: ${atk.controller}) caused by ${atk.soldierClass}_C`);
    emit(t + 1500, `LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:${vic.name} KillingDamage=-120.000000 from ${atk.controller} (Online IDs: EOS: ${atk.eos} steam: ${atk.steam} | Contoller ID: ${atk.controller}) caused by ${atk.soldierClass}_C`);
  }

  // Close-quarters 1v1 with full aim telemetry (PlayerLook + PlayerState + multi-
  // shot bursts) so the AAR's recoil / "where you aimed" analysis has data. The
  // pusher (loser) peeks in firing first with a high-right, climbing spray; the
  // holder (winner) is pre-aimed and tight, and wins the trade.
  function cqbDuel(t: number, winnerTeam: number, loserTeam: number) {
    const pick = (team: number, exclude?: Sim) => {
      const arr = players.filter((p) => p.team === team && !p.vehicle && p !== exclude && p.role.includes('Rifleman'));
      return arr[Math.floor(rand() * arr.length)] ?? players.find((p) => p.team === team && p !== exclude);
    };
    const winner = pick(winnerTeam);
    const loser = pick(loserTeam, winner);
    if (!winner || !loser) return;

    winner.alive = loser.alive = true;
    winner.wounded = loser.wounded = false;
    winner.hp = loser.hp = 100;

    // Winner holds an angle; loser pushes in from ~40 m down to ~25 m.
    const base = { x: -20000 + (rand() - 0.5) * 60000, y: -20000 + (rand() - 0.5) * 60000 };
    winner.pos = { ...base };
    const axis = rand() < 0.5 ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const wz = terrainZ(winner.pos.x, winner.pos.y) + STAND;

    const posLine = (p: Sim, z: number, state: string) =>
      `LogSquadStats: PlayerPos: eos=${p.eos} ctrl=${p.controller} pos=${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)},${z.toFixed(1)} yaw=${p.yaw.toFixed(1)} hp=${p.hp.toFixed(1)} team=${p.team} squad=${p.squad} role=${p.role} state=${state}`;

    // approach: loser advances (moving → peek), winner holds (pre-aimed, still).
    // Samples span the full 3 s approach window the engagement heuristic looks
    // back over (with a point just before t−3000), so attacker/defender, approach
    // delta and moving flags are computed from the duel — never a stale sim tick.
    const approach: Array<[number, number]> = [
      [-3100, 4000], [-2900, 3900], [-1600, 3500], [-1100, 3200],
      [-700, 2900], [-350, 2650], [-120, 2500], [150, 2500],
    ]; // [dt ms, range cm] — 40 m → 25 m
    for (const [dt, range] of approach) {
      loser.pos = { x: base.x + axis.x * range, y: base.y + axis.y * range };
      emit(t + dt, posLine(winner, wz, 'alive'));
      emit(t + dt, posLine(loser, terrainZ(loser.pos.x, loser.pos.y) + STAND, 'alive'));
    }
    loser.pos = { x: base.x + axis.x * 2500, y: base.y + axis.y * 2500 };

    emit(t - 50, `LogSquadStats: PlayerState: eos=${winner.eos} stance=crouch sprint=0`);
    emit(t - 50, `LogSquadStats: PlayerState: eos=${loser.eos} stance=stand sprint=0`);

    // burst emitter — PlayerLook + Projectile per shot. Squad convention:
    // yaw 0 = north (+Y), CW; pitch + = up. Misses fly along the aim ray so the
    // recoil plot shows the muzzle walk; hits are pinned to the victim.
    const burst = (
      sh: Sim, tg: Sim,
      o: { shots: number; t0: number; gap: number; biasH: number; biasV: number; climb: number; jitter: number; hits: number[] }
    ) => {
      const eyeZ = terrainZ(sh.pos.x, sh.pos.y) + STAND + 60;
      const tz = terrainZ(tg.pos.x, tg.pos.y) + STAND;
      const dx = tg.pos.x - sh.pos.x, dy = tg.pos.y - sh.pos.y, dz = tz - eyeZ;
      const R = Math.hypot(dx, dy) || 1;
      const bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
      const elev = Math.atan2(dz, R) * 180 / Math.PI;
      sh.yaw = bearing;
      for (let i = 0; i < o.shots; i++) {
        const tt = o.t0 + i * o.gap;
        const aimYaw = bearing + o.biasH + (rand() - 0.5) * o.jitter * 2;
        const aimPitch = elev + o.biasV + o.climb * i + (rand() - 0.5) * o.jitter * 2;
        emit(tt, `LogSquadStats: PlayerLook: eos=${sh.eos} pitch=${aimPitch.toFixed(1)} yaw=${aimYaw.toFixed(1)}`);
        if (o.hits.includes(i)) {
          emit(tt + 1, `LogSquad: Player:${tg.name} ActualDamage=55.000 from ${sh.name} (Online IDs: EOS: ${sh.eos} steam: ${sh.steam} | Player Controller ID: ${sh.controller})caused by ${sh.soldierClass}_C`);
          emit(tt + 2, `LogSquadStats: Projectile: shooter=${sh.eos} weapon=${sh.weapon} from=${sh.pos.x.toFixed(1)},${sh.pos.y.toFixed(1)},${eyeZ.toFixed(1)} to=${tg.pos.x.toFixed(1)},${tg.pos.y.toFixed(1)},${tz.toFixed(1)} speed=850 hit=1 victim=${tg.eos}`);
        } else {
          const ay = aimYaw * Math.PI / 180, ap = aimPitch * Math.PI / 180, cp = Math.cos(ap);
          const ex = sh.pos.x + cp * Math.sin(ay) * R;
          const ey = sh.pos.y + cp * Math.cos(ay) * R;
          const ez = eyeZ + Math.sin(ap) * R;
          emit(tt + 2, `LogSquadStats: Projectile: shooter=${sh.eos} weapon=${sh.weapon} from=${sh.pos.x.toFixed(1)},${sh.pos.y.toFixed(1)},${eyeZ.toFixed(1)} to=${ex.toFixed(1)},${ey.toFixed(1)},${ez.toFixed(1)} speed=850 hit=0 victim=-`);
        }
      }
    };

    // loser peeks and fires first — off-target (high-right) + uncompensated climb, all miss
    burst(loser, winner, { shots: 4, t0: t, gap: 85, biasH: 2.4, biasV: 1.6, climb: 2.0, jitter: 0.7, hits: [] });
    // winner reacts — tight, near-centre aim, controlled climb, two hits
    burst(winner, loser, { shots: 5, t0: t + 130, gap: 75, biasH: 0.2, biasV: 0.1, climb: 0.18, jitter: 0.3, hits: [2, 3] });

    // wound on the first connecting shot, death shortly after (winner wins)
    const woundT = t + 130 + 2 * 75;
    emit(woundT + 4, `LogSquadTrace: [DedicatedServer]ASQSoldier::Wound(): Player:${loser.name} KillingDamage=-55.000000 from ${winner.controller} (Online IDs: EOS: ${winner.eos} steam: ${winner.steam} | Controller ID: ${winner.controller}) caused by ${winner.soldierClass}_C`);
    loser.wounded = true; loser.hp = 0;
    const dieT = woundT + 220;
    emit(dieT, `LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:${loser.name} KillingDamage=-100.000000 from ${winner.controller} (Online IDs: EOS: ${winner.eos} steam: ${winner.steam} | Contoller ID: ${winner.controller}) caused by ${winner.soldierClass}_C`);
    loser.alive = false; loser.wounded = false; loser.respawnAt = dieT + 20000;
    emit(dieT + 5, posLine(loser, terrainZ(loser.pos.x, loser.pos.y) + STAND, 'dead'));
  }

  // ---- finalize -----------------------------------------------------------
  lines.sort((a, b) => a.t - b.t);
  let frame = 100;
  const out = lines
    .map((l) => {
      frame = (frame + 1) % 100000;
      return `[${formatLogTime(l.t)}][${String(frame).padStart(3, ' ')}]${l.body}`;
    })
    .join('\n');

  return out;
}

// ----------------------------- geometry ------------------------------------
function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function clampMag(v: number, m: number): number {
  return Math.max(-m, Math.min(m, v));
}
function hasLOS(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const za = terrainZ(a.x, a.y) + STAND + 60;
  const zb = terrainZ(b.x, b.y) + STAND;
  const N = 16;
  for (let i = 1; i < N; i++) {
    const f = i / N;
    const x = a.x + (b.x - a.x) * f;
    const y = a.y + (b.y - a.y) * f;
    const lineZ = za + (zb - za) * f;
    if (terrainZ(x, y) + 150 > lineZ) return false;
  }
  return true;
}

// ----------------------------- entrypoint ----------------------------------
export async function writeSampleLog(outPath?: string): Promise<string> {
  const file = outPath ?? path.resolve(process.cwd(), 'data/logs/SquadGame-sample.log');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, main(), 'utf8');
  return file;
}

// run when invoked directly (`tsx src/tools/generateSampleLog.ts`)
if (process.argv[1] && process.argv[1].includes('generateSampleLog')) {
  const file = await writeSampleLog();
  const stat = await fs.stat(file);
  console.log(`Wrote ${file} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}
