import type { Round } from '../timeline/types.js';
import type { PlayerPointReport, RoundReport, PointBreakdown, PlayerStats } from './types.js';
import type { Pool, RatedPool } from '../elo/pools.js';
import { infantryPoolForRole, VEHICLE_POOLS } from '../elo/pools.js';
import { classifyVehicleType } from '../elo/vehicleTypes.js';
import { POINTS, VEHICLE_TICKET_VALUE, componentMultiplier } from './config.js';
import { FobValuation } from './fobValuation.js';

interface WReport extends Omit<PlayerPointReport, 'poolPoints' | 'poolTimeMs'> {
  poolPoints: Map<RatedPool, number>;
  poolTimeMs: Map<RatedPool, number>;
}

const zeroBreakdown = (): PointBreakdown => ({
  combat: 0,
  revive: 0,
  heal: 0,
  flag: 0,
  fobDestroy: 0,
  vehicleDestroy: 0,
  component: 0,
  logistics: 0,
  transport: 0,
  fobValue: 0,
  penalty: 0
});
const zeroStats = (): PlayerStats => ({
  kills: 0,
  wounds: 0,
  deaths: 0,
  teamkills: 0,
  revivesGiven: 0,
  revivesReceived: 0,
  damageInfantry: 0,
  damageVehicle: 0,
  longestKillM: 0,
  headshots: 0,
  fobsDestroyed: 0,
  vehiclesDestroyed: 0,
  flagsCaptured: 0
});

export function computePoints(round: Round): RoundReport {
  const { players, snapshots, meta, events } = round;
  const reports = new Map<string, WReport>();
  const nameToEos = new Map<string, string>();

  for (const [eos, p] of Object.entries(players)) {
    nameToEos.set(p.name, eos);
    reports.set(eos, {
      eosID: eos,
      steamID: p.steamID,
      name: p.name,
      team: p.team,
      pool: 'Generic',
      poolPoints: new Map(),
      poolTimeMs: new Map(),
      breakdown: zeroBreakdown(),
      totalPoints: 0,
      stats: zeroStats()
    });
  }

  // --- vehicle pool per crew player (nearest co-located vehicle) ----------
  const vehiclePoolOf = computeVehiclePools(round);

  // --- pool-at-time helper ------------------------------------------------
  const poolAtTime = (eos: string, tRel: number): Pool => {
    const pl = players[eos];
    if (!pl) return 'Generic';
    const span = pl.roles.find((s) => tRel >= s.fromMs && tRel <= s.toMs) ?? pl.roles[pl.roles.length - 1];
    let pool: Pool = span?.pool ?? 'Generic';
    if ((pool === 'Unrated' || isCrewRole(span?.role)) && vehiclePoolOf.has(eos)) pool = vehiclePoolOf.get(eos)!;
    return pool;
  };

  const addPool = (eos: string, pool: Pool, amt: number) => {
    if (pool === 'Unrated') return;
    const r = reports.get(eos);
    if (!r) return;
    r.poolPoints.set(pool as RatedPool, (r.poolPoints.get(pool as RatedPool) ?? 0) + amt);
  };
  const award = (eos: string | undefined, cat: keyof PointBreakdown, amt: number, tRel: number) => {
    if (!eos) return;
    const r = reports.get(eos);
    if (!r) return;
    r.breakdown[cat] += amt;
    addPool(eos, poolAtTime(eos, tRel), amt);
  };

  // --- snapshot lookup ----------------------------------------------------
  const step = snapshots.length > 1 ? snapshots[1].tMs - snapshots[0].tMs : 1000;
  const snapAt = (tRel: number) => snapshots[Math.max(0, Math.min(snapshots.length - 1, Math.round(tRel / step)))];
  const sizeM = meta.sizeMeters;
  const normDistM = (a: { nx: number; ny: number }, b: { nx: number; ny: number }) =>
    Math.hypot(a.nx - b.nx, a.ny - b.ny) * sizeM;

  const commanderAt = (eos: string, tRel: number) => {
    const pl = players[eos];
    const span = pl?.roles.find((s) => tRel >= s.fromMs && tRel <= s.toMs);
    return !!span && /commander/i.test(span.role);
  };

  const onActiveObjective = (eos: string, tRel: number): boolean => {
    const snap = snapAt(tRel);
    if (!snap) return false;
    const me = snap.players.find((p) => p.eosID === eos);
    if (!me) return false;
    for (const f of snap.flags) {
      if (/lock|inactive/i.test(f.status)) continue;
      if (normDistM(me.pos, f.pos) <= POINTS.flagRadiusM) return true;
    }
    return false;
  };

  // --- damage buffers for kill attribution --------------------------------
  const dmgBuf = new Map<string, Array<{ eos: string; dmg: number; t: number }>>(); // victimEos -> contributions
  const rel = (absMs: number) => absMs - meta.startTime;

  // ===== combat: damage -> wounds -> deaths ===============================
  for (const e of events) {
    if (e.type === 'PLAYER_DAMAGED') {
      const victimEos = nameToEos.get(e.victimName);
      if (!victimEos || !e.attackerEOSID) continue;
      const buf = dmgBuf.get(victimEos) ?? [];
      buf.push({ eos: e.attackerEOSID, dmg: e.damage, t: e.time });
      dmgBuf.set(victimEos, buf);
      const r = reports.get(e.attackerEOSID);
      if (r) r.stats.damageInfantry += e.damage;
    } else if (e.type === 'PLAYER_WOUNDED') {
      const victimEos = nameToEos.get(e.victimName);
      if (!victimEos) continue;
      const tRel = rel(e.time);
      const buf = (dmgBuf.get(victimEos) ?? []).filter((c) => e.time - c.t <= POINTS.damageWindowMs);
      // ensure the final blow is represented even if its ActualDamage line was missing
      if (e.attackerEOSID && !buf.some((c) => c.eos === e.attackerEOSID)) buf.push({ eos: e.attackerEOSID, dmg: e.damage, t: e.time });
      const totalDmg = buf.reduce((s, c) => s + c.dmg, 0);
      if (totalDmg <= 0) {
        dmgBuf.delete(victimEos);
        continue;
      }
      const victimIsCmd = commanderAt(victimEos, tRel);
      const pool = victimIsCmd ? POINTS.commanderWoundPoints : POINTS.woundPoolPoints;
      const headshot = isHeadshot(e.weapon, e.damage);
      // aggregate damage per attacker
      const byAtk = new Map<string, number>();
      for (const c of buf) byAtk.set(c.eos, (byAtk.get(c.eos) ?? 0) + c.dmg);
      let topAtk: string | undefined;
      let topDmg = -1;
      for (const [atk, dmg] of byAtk) {
        const share = dmg / totalDmg;
        let pts = pool * share;
        if (onActiveObjective(victimEos, tRel) || onActiveObjective(atk, tRel)) pts *= POINTS.objectiveMultiplier;
        if (headshot) pts *= POINTS.headshotMultiplier;
        // team-kill: attacker same team as victim -> negative, counted as penalty
        if (reports.get(atk)?.team === reports.get(victimEos)?.team && atk !== victimEos) {
          award(atk, 'penalty', -Math.abs(pts), tRel);
          const r = reports.get(atk);
          if (r) r.stats.teamkills += 1;
        } else {
          award(atk, 'combat', pts, tRel);
        }
        if (dmg > topDmg) {
          topDmg = dmg;
          topAtk = atk;
        }
      }
      if (topAtk && reports.get(topAtk)?.team !== reports.get(victimEos)?.team) {
        const r = reports.get(topAtk)!;
        r.stats.wounds += 1;
        if (headshot) r.stats.headshots += 1;
      }
      dmgBuf.delete(victimEos);
    } else if (e.type === 'PLAYER_DIED') {
      const victimEos = nameToEos.get(e.victimName);
      const tRel = rel(e.time);
      if (victimEos) reports.get(victimEos)!.stats.deaths += 1;
      const attackerEos = e.attackerEOSID;
      if (!attackerEos || attackerEos === victimEos) {
        // gave up / suicide
        if (victimEos) {
          const pen = commanderAt(victimEos, tRel) ? POINTS.giveUpPenalty * 2 : POINTS.giveUpPenalty;
          award(victimEos, 'penalty', pen, tRel);
        }
      } else if (reports.get(attackerEos)?.team !== reports.get(victimEos ?? '')?.team) {
        const r = reports.get(attackerEos);
        if (r) {
          r.stats.kills += 1;
          // longest kill: distance from matching projectile / positions
          const proj = round.analysis.projectiles.find(
            (p) => p.victimEOSID === victimEos && Math.abs(p.tMs - tRel) < 2500 && p.shooterEOSID === attackerEos
          );
          if (proj) r.stats.longestKillM = Math.max(r.stats.longestKillM, Math.round(proj.rangeM));
        }
      }
    }
  }

  // ===== revives ==========================================================
  for (const e of events) {
    if (e.type !== 'PLAYER_REVIVED') continue;
    const tRel = rel(e.time);
    if (e.reviverEOSID) {
      award(e.reviverEOSID, 'revive', POINTS.revivePoints, tRel);
      award(e.reviverEOSID, 'heal', POINTS.approxHealHpPerRevive * POINTS.healPerHp, tRel);
      const r = reports.get(e.reviverEOSID);
      if (r) r.stats.revivesGiven += 1;
    }
    if (e.victimEOSID) {
      const r = reports.get(e.victimEOSID);
      if (r) r.stats.revivesReceived += 1;
    }
  }

  // ===== flags ============================================================
  const flagOwner = new Map<string, number>();
  for (const e of events) {
    if (e.type !== 'FLAG_CAPTURED') continue;
    const tRel = rel(e.time);
    const prevOwner = flagOwner.get(e.flag);
    const enemyCap = prevOwner != null && prevOwner !== e.team;
    flagOwner.set(e.flag, e.team);
    const pts = enemyCap ? POINTS.flagEnemyPoints : POINTS.flagNeutralPoints;
    const snap = snapAt(tRel);
    const flagPos = e.pos ? round && worldNorm(round, e.pos) : snap?.flags.find((f) => f.name === e.flag)?.pos;
    if (!flagPos) continue;
    const near = snap.players.filter((p) => p.team === e.team && normDistM(p.pos, flagPos) <= POINTS.flagRadiusM);
    if (!near.length) continue;
    const each = pts / near.length;
    for (const p of near) {
      award(p.eosID, 'flag', each, tRel);
      const r = reports.get(p.eosID);
      if (r) r.stats.flagsCaptured += 1 / near.length;
    }
  }

  // ===== FOB valuation + SL share (feeds destruction multiplier) ==========
  const fobVal = new Map<string, FobValuation>();
  const fobMeta = new Map<string, { team: number; pos: { nx: number; ny: number }; creatorEOSID?: string; createdMs: number; destroyedMs?: number }>();
  for (const e of events) {
    if (e.type === 'FOB_CREATED') {
      fobVal.set(e.fob, new FobValuation());
      fobMeta.set(e.fob, { team: e.team, pos: worldNorm(round, e.pos), creatorEOSID: e.creatorEOSID, createdMs: e.time });
    } else if (e.type === 'FOB_DESTROYED') {
      const m = fobMeta.get(e.fob);
      if (m) m.destroyedMs = e.time;
    }
  }
  // attribute 10% of each player's positive combat/flag points to nearest friendly active FOB + its SL
  const attributeFobValue = (eos: string, pts: number, tRel: number) => {
    if (pts <= 0) return;
    const r = reports.get(eos);
    if (!r) return;
    let best: string | undefined;
    let bestD = Infinity;
    const snap = snapAt(tRel);
    const me = snap?.players.find((p) => p.eosID === eos);
    if (!me) return;
    for (const [id, m] of fobMeta) {
      if (m.team !== r.team) continue;
      if (m.createdMs - meta.startTime > tRel) continue;
      if (m.destroyedMs && m.destroyedMs - meta.startTime < tRel) continue;
      const d = normDistM(me.pos, m.pos);
      if (d < bestD && d <= 300) {
        bestD = d;
        best = id;
      }
    }
    if (!best) return;
    const share = pts * POINTS.transportShare; // 10%
    fobVal.get(best)?.add(tRel, share);
    const creator = fobMeta.get(best)?.creatorEOSID;
    if (creator) award(creator, 'fobValue', share, tRel);
  };
  // run attribution over combat + flag awards by replaying positive combat events cheaply:
  for (const e of events) {
    if (e.type === 'PLAYER_WOUNDED') {
      const victimEos = nameToEos.get(e.victimName);
      const tRel = rel(e.time);
      const buf = (dmgBuf.get(victimEos ?? '') ?? []); // emptied already; recompute light: use attacker only
      if (e.attackerEOSID && reports.get(e.attackerEOSID)?.team !== reports.get(victimEos ?? '')?.team)
        attributeFobValue(e.attackerEOSID, POINTS.woundPoolPoints, tRel);
    }
  }

  // ===== FOB destruction ==================================================
  const meanVal = (t: number) => {
    const vals = [...fobVal.values()].map((v) => v.value(t));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  for (const e of events) {
    if (e.type !== 'FOB_DESTROYED') continue;
    const tRel = rel(e.time);
    const val = fobVal.get(e.fob);
    const mult = val ? val.destructionMultiplier(tRel, meanVal(tRel)) : 1.5;
    const pts = POINTS.fobDestroyPoints * mult;
    const snap = snapAt(tRel);
    const fobPos = e.pos ? worldNorm(round, e.pos) : fobMeta.get(e.fob)?.pos;
    if (!fobPos) continue;
    const near = snap.players.filter((p) => p.team !== e.team && normDistM(p.pos, fobPos) <= POINTS.fobDestroyRadiusM);
    if (!near.length) continue;
    const each = pts / near.length;
    near.forEach((p, i) => {
      award(p.eosID, 'fobDestroy', each, tRel);
      if (i === 0) reports.get(p.eosID)!.stats.fobsDestroyed += 1;
    });
  }

  // ===== vehicle destruction + components =================================
  const vehDmg = new Map<string, Map<string, number>>(); // vehId -> attackerEos -> dmg
  const vehType = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'VEHICLE_DAMAGE') {
      vehType.set(e.vehicle, e.vehType ?? '');
      const m = vehDmg.get(e.vehicle) ?? new Map();
      if (e.attackerEOSID) m.set(e.attackerEOSID, (m.get(e.attackerEOSID) ?? 0) + e.damage);
      vehDmg.set(e.vehicle, m);
      const r = e.attackerEOSID ? reports.get(e.attackerEOSID) : undefined;
      if (r) r.stats.damageVehicle += e.damage;
    } else if (e.type === 'VEHICLE_POS') {
      vehType.set(e.vehicle, e.vehType);
    }
  }
  const destroyedComponents = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type === 'VEHICLE_COMPONENT' && e.health <= 0) {
      const set = destroyedComponents.get(e.vehicle) ?? new Set();
      set.add(e.component);
      destroyedComponents.set(e.vehicle, set);
    }
  }
  // distribute per damaged vehicle that has a destruction event
  for (const [vehId, contribs] of vehDmg) {
    const type = vehType.get(vehId) ?? '';
    const pool = classifyVehicleType(type);
    if (!pool) continue;
    // was it destroyed? look for a vehicle_destroyed mapEvent of same type
    const destroyed = round.mapEvents.find((m) => m.kind === 'vehicle_destroyed' && m.label.includes(type));
    if (!destroyed) continue;
    const tRel = destroyed.tMs;
    const value = VEHICLE_TICKET_VALUE[pool];
    const total = [...contribs.values()].reduce((a, b) => a + b, 0);
    if (total <= 0) continue;
    let top: string | undefined;
    let topD = -1;
    for (const [atk, dmg] of contribs) {
      const share = dmg / total;
      award(atk, 'vehicleDestroy', value * share, tRel);
      if (dmg > topD) {
        topD = dmg;
        top = atk;
      }
    }
    if (top) reports.get(top)!.stats.vehiclesDestroyed += 1;
    // components -> multiplier on full value for the top attacker(s)
    const comps = destroyedComponents.get(vehId);
    if (comps && top) {
      let mult = 0;
      for (const c of comps) mult += componentMultiplier(c);
      if (mult > 0) award(top, 'component', value * mult, tRel);
    }
  }

  // ===== logistics ========================================================
  for (const e of events) {
    if (e.type !== 'AMMO_DELIVERY') continue;
    award(e.eosID, 'logistics', Math.min(2, e.amount * POINTS.logiPerAmmo), rel(e.time));
  }

  // ===== pool time + finalize =============================================
  for (const [eos, p] of Object.entries(players)) {
    const r = reports.get(eos)!;
    for (const span of p.roles) {
      let pool: Pool = span.pool;
      if ((pool === 'Unrated' || isCrewRole(span.role)) && vehiclePoolOf.has(eos)) pool = vehiclePoolOf.get(eos)!;
      if (pool === 'Unrated') continue;
      const dur = Math.max(0, span.toMs - span.fromMs);
      r.poolTimeMs.set(pool as RatedPool, (r.poolTimeMs.get(pool as RatedPool) ?? 0) + dur);
    }
  }

  const out: PlayerPointReport[] = [];
  const teamPoints: Record<number, number> = {};
  for (const r of reports.values()) {
    const total = Object.values(r.breakdown).reduce((a, b) => a + b, 0);
    r.totalPoints = round2(total);
    // primary pool = most time, fallback most |points|
    let primary: Pool = 'Generic';
    let bestT = -1;
    for (const [pool, t] of r.poolTimeMs) if (t > bestT) (bestT = t), (primary = pool);
    if (bestT < 0) {
      let bestP = -1;
      for (const [pool, pts] of r.poolPoints) if (Math.abs(pts) > bestP) (bestP = Math.abs(pts)), (primary = pool);
    }
    r.pool = primary;
    teamPoints[r.team] = (teamPoints[r.team] ?? 0) + r.totalPoints;
    out.push({
      ...r,
      poolPoints: round2Map(r.poolPoints),
      poolTimeMs: Object.fromEntries(r.poolTimeMs) as any,
      breakdown: round2Breakdown(r.breakdown)
    });
  }
  out.sort((a, b) => b.totalPoints - a.totalPoints);

  return {
    global: {
      roundId: meta.id,
      layer: meta.layer,
      mapName: meta.mapName,
      durationMs: meta.durationMs,
      startTime: meta.startTime,
      winnerTeam: meta.winnerTeam,
      finalTickets: meta.finalTickets,
      factions: meta.factions,
      playerCount: meta.playerCount,
      teamPoints
    },
    players: out
  };
}

/* ------------------------------ helpers ----------------------------------- */

function isCrewRole(role?: string): boolean {
  return !!role && /crewman|pilot/i.test(role);
}

function isHeadshot(weapon: string | undefined, damage: number): boolean {
  const w = (weapon ?? '').toLowerCase();
  const bulletWeapon = /ak|m4|m16|rifle|sniper|svd|carbine|pistol|mg|pkp|pkm|m240/.test(w) || w === '';
  return bulletWeapon && damage >= 95;
}

function worldNorm(round: Round, pos: { x: number; y: number }): { nx: number; ny: number } {
  const { minX, minY, maxX, maxY } = round.meta.world;
  return { nx: clamp01((pos.x - minX) / (maxX - minX)), ny: clamp01(1 - (pos.y - minY) / (maxY - minY)) };
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round2 = (v: number) => Math.round(v * 100) / 100;
const round2Map = (m: Map<RatedPool, number>): Partial<Record<RatedPool, number>> => {
  const o: Partial<Record<RatedPool, number>> = {};
  for (const [k, v] of m) o[k] = round2(v);
  return o;
};
const round2Breakdown = (b: PointBreakdown): PointBreakdown => {
  const o = { ...b };
  for (const k of Object.keys(o) as (keyof PointBreakdown)[]) o[k] = round2(o[k]);
  return o;
};

/** Assign a vehicle pool to crew players by nearest co-located friendly vehicle. */
function computeVehiclePools(round: Round): Map<string, RatedPool> {
  const tally = new Map<string, Map<RatedPool, number>>();
  const sizeCm = round.meta.sizeMeters * 100;
  for (const snap of round.snapshots) {
    for (const p of snap.players) {
      const pl = round.players[p.eosID];
      const isCrew = pl?.roles.some((s) => isCrewRole(s.role)) || /crewman|pilot/i.test(p.role ?? '');
      if (!isCrew) continue;
      let best: RatedPool | null = null;
      let bestD = Infinity;
      for (const v of snap.vehicles) {
        if (v.team !== p.team || !v.pool) continue;
        const d = Math.hypot((p.pos.nx - v.pos.nx) * sizeCm, (p.pos.ny - v.pos.ny) * sizeCm);
        if (d < bestD && d <= 1500) {
          bestD = d;
          best = v.pool as RatedPool;
        }
      }
      if (best) {
        const m = tally.get(p.eosID) ?? new Map();
        m.set(best, (m.get(best) ?? 0) + 1);
        tally.set(p.eosID, m);
      }
    }
  }
  const out = new Map<string, RatedPool>();
  for (const [eos, m] of tally) {
    let best: RatedPool | null = null;
    let bestN = -1;
    for (const [pool, n] of m) if (n > bestN) (bestN = n), (best = pool);
    if (best && VEHICLE_POOLS.includes(best as any)) out.set(eos, best);
  }
  return out;
}
