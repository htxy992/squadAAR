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
function terrainZ(x: number, y: number): number {
  let z = 1000 + 600 * Math.sin(x / 30000) * Math.cos(y / 28000);
  for (const hl of HILLS) z += hl.h * Math.exp(-((x - hl.cx) ** 2 + (y - hl.cy) ** 2) / (2 * hl.r ** 2));
  return z;
}
const STAND = 95; // entity capsule offset above ground

// ----------------------------- config --------------------------------------
const HALF = 150000; // ±1500 m world (Harju ~3 km)
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
    return { name, x: -120000 + f * 240000, y: -120000 + f * 240000 };
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
  mkTeam(1, USA_ROLES, -135000, -135000);
  mkTeam(2, RUS_ROLES, 135000, 135000);

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
  for (const v of vehicles) {
    const crewRole = v.team === 1 ? 'USA_Crewman_01' : 'RUS_Crewman_01';
    const cand = players.filter((p) => p.team === v.team && p.squad === 1).slice(0, 2);
    for (const c of cand.splice(0, 2)) {
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
    emit(atMs, `LogSquadStats: FobCreated: fob=${id} team=${team} pos=${x.toFixed(1)},${y.toFixed(1)},${terrainZ(x, y).toFixed(1)} creator=${sl?.eos ?? '-'}`);
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
    const base = fob ? { x: fob.x, y: fob.y } : p.team === 1 ? { x: -135000, y: -135000 } : { x: 135000, y: 135000 };
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
      // revive wounded medics nearby
      const obj = p.vehicle ? p.vehicle.pos : objectiveFor(p.team, tNorm);
      const tx = obj.x + (rand() - 0.5) * 45000;
      const ty = obj.y + (rand() - 0.5) * 45000;
      const spd = p.vehicle ? 4200 : 1500;
      p.pos.x += clampMag(tx - p.pos.x, spd);
      p.pos.y += clampMag(ty - p.pos.y, spd);
      p.yaw = (Math.atan2(ty - p.pos.y, tx - p.pos.x) * 180) / Math.PI;
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
