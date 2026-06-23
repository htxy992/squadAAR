import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBulletEvents, detectBursts, perpDistCm } from '../src/engagement/shots.js';
import { buildEngagements } from '../src/engagement/detect.js';
import { PositionBuffer } from '../src/engagement/positionBuffer.js';
import { LookBuffer, enrichWithAim, bearingDegSquad, elevationDeg, angleBetween } from '../src/engagement/aim.js';
import type { TimelineEvent } from '../src/parser/events.js';
import type { PositionSample } from '../src/engagement/types.js';
import type { DeathReport, RoundPlayer } from '../src/timeline/types.js';

// ─── perpDistCm ───────────────────────────────────────────────────────────────

test('perpDistCm: point on ray has distance 0', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const dir = { x: 1, y: 0, z: 0 };
  const P = { x: 50, y: 0, z: 0 };
  assert.ok(perpDistCm(origin, dir, P) < 1e-9, 'point on ray should have dist ~0');
});

test('perpDistCm: perpendicular offset returns correct distance', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const dir = { x: 1, y: 0, z: 0 }; // ray along X
  const P = { x: 0, y: 200, z: 0 }; // 200 cm off to the side
  const d = perpDistCm(origin, dir, P);
  assert.ok(Math.abs(d - 200) < 0.001, `expected 200, got ${d}`);
});

test('perpDistCm: diagonal point', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const dir = { x: 0, y: 0, z: 1 }; // ray straight up
  const P = { x: 300, y: 400, z: 100 }; // 500 cm away in XY
  const d = perpDistCm(origin, dir, P);
  assert.ok(Math.abs(d - 500) < 0.01, `expected 500 (3-4-5 triple), got ${d}`);
});

// ─── buildBulletEvents ────────────────────────────────────────────────────────

function makeProjectile(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    type: 'PROJECTILE',
    time: 1000,
    shooterEOSID: 'eos1',
    weapon: 'M4A1',
    from: { x: 0, y: 0, z: 0 },
    to: { x: 1000, y: 0, z: 0 },
    hit: false,
    victimEOSID: undefined,
    ...overrides
  } as unknown as TimelineEvent;
}

test('buildBulletEvents: converts PROJECTILE to BulletEvent with relative tMs', () => {
  const startMs = 5000;
  const events: TimelineEvent[] = [
    makeProjectile({ time: 6000 }),
    makeProjectile({ type: 'NEW_GAME' as any }), // should be ignored
    makeProjectile({ time: 7500 }),
  ];
  const bullets = buildBulletEvents(events, startMs);
  assert.equal(bullets.length, 2);
  assert.equal(bullets[0].tMs, 1000);
  assert.equal(bullets[1].tMs, 2500);
});

test('buildBulletEvents: normalizes dirVec to unit length', () => {
  const bullets = buildBulletEvents([
    makeProjectile({ from: { x: 0, y: 0, z: 0 }, to: { x: 300, y: 400, z: 0 }, time: 1000 })
  ], 0);
  const d = bullets[0].dirVec;
  const len = Math.hypot(d.x, d.y, d.z);
  assert.ok(Math.abs(len - 1) < 1e-6, `dirVec should be unit length, got ${len}`);
  assert.ok(Math.abs(d.x - 0.6) < 1e-6, `expected dx=0.6, got ${d.x}`);
  assert.ok(Math.abs(d.y - 0.8) < 1e-6, `expected dy=0.8, got ${d.y}`);
});

test('buildBulletEvents: results sorted by tMs', () => {
  const bullets = buildBulletEvents([
    makeProjectile({ time: 3000 }),
    makeProjectile({ time: 1000 }),
    makeProjectile({ time: 2000 }),
  ], 0);
  assert.equal(bullets[0].tMs, 1000);
  assert.equal(bullets[1].tMs, 2000);
  assert.equal(bullets[2].tMs, 3000);
});

// ─── detectBursts ─────────────────────────────────────────────────────────────

test('detectBursts: three shots within 200ms form one burst', () => {
  const bullets = buildBulletEvents([
    makeProjectile({ time: 1000 }),
    makeProjectile({ time: 1150 }),
    makeProjectile({ time: 1300 }),
  ], 0);
  const result = detectBursts(bullets);
  const bursts = result.get('eos1') ?? [];
  assert.equal(bursts.length, 1, 'should be 1 burst');
  assert.equal(bursts[0].shotCount, 3);
});

test('detectBursts: shots with >200ms gap form separate bursts', () => {
  const bullets = buildBulletEvents([
    makeProjectile({ time: 1000 }),
    makeProjectile({ time: 1150 }),
    makeProjectile({ time: 2000 }), // gap = 850ms > 200ms
    makeProjectile({ time: 2100 }),
  ], 0);
  const result = detectBursts(bullets);
  const bursts = result.get('eos1') ?? [];
  assert.equal(bursts.length, 2, 'should be 2 bursts');
  assert.equal(bursts[0].shotCount, 2);
  assert.equal(bursts[1].shotCount, 2);
});

test('detectBursts: single shot burst has spread=0 and control=1', () => {
  const bullets = buildBulletEvents([makeProjectile({ time: 1000 })], 0);
  const result = detectBursts(bullets);
  const burst = (result.get('eos1') ?? [])[0];
  assert.ok(burst !== undefined);
  assert.equal(burst.spraySpread, 0);
  assert.equal(burst.sprayControlScore, 1);
  assert.equal(burst.maxRecoilH, 0);
  assert.equal(burst.maxRecoilV, 0);
});

test('detectBursts: first shot recoil is always 0,0', () => {
  const bullets = buildBulletEvents([
    makeProjectile({ time: 1000 }),
    makeProjectile({ time: 1100, to: { x: 500, y: 300, z: 200 } }),
  ], 0);
  detectBursts(bullets);
  assert.equal(bullets[0].recoilH, 0);
  assert.equal(bullets[0].recoilV, 0);
});

test('detectBursts: hitRate counts actual hits', () => {
  const bullets = buildBulletEvents([
    makeProjectile({ time: 1000, hit: false }),
    makeProjectile({ time: 1100, hit: true }),
    makeProjectile({ time: 1200, hit: true }),
  ], 0);
  const result = detectBursts(bullets);
  const burst = (result.get('eos1') ?? [])[0];
  assert.ok(burst !== undefined);
  assert.ok(Math.abs(burst.hitRate - 2 / 3) < 1e-9, `expected hitRate=0.667, got ${burst.hitRate}`);
  assert.equal(burst.hits, 2);
  assert.equal(burst.firstShotHit, false);
});

// ─── buildEngagements ─────────────────────────────────────────────────────────

function makePosBuffer(entries: Array<{ eos: string; tMs: number; x: number; y: number; team: number }>): PositionBuffer {
  const buf = new PositionBuffer();
  for (const e of entries) {
    const sample: PositionSample = {
      tMs: e.tMs,
      pos: { x: e.x, y: e.y, z: 100 },
      yaw: 0, health: 100, team: e.team, state: 'alive'
    };
    buf.add(e.eos, sample);
  }
  return buf;
}

test('buildEngagements: two nearby opponents produce one engagement', () => {
  const tStart = 0;
  // eos1 (team1) shoots eos2 (team2) at t=1000, distance ~5000 cm = 50 m
  const bullets = buildBulletEvents([
    makeProjectile({
      time: tStart + 1000,
      shooterEOSID: 'eos1',
      to: { x: 5000, y: 0, z: 0 },
      hit: true, victimEOSID: 'eos2'
    })
  ], tStart);

  const posBuffer = makePosBuffer([
    { eos: 'eos1', tMs: 1000, x: 0, y: 0, team: 1 },
    { eos: 'eos2', tMs: 1000, x: 4000, y: 0, team: 2 },
  ]);

  const players: Record<string, RoundPlayer> = {
    eos1: { name: 'Alpha', eosID: 'eos1', team: 1, squad: 1, roles: [], firstSeenMs: 0, lastSeenMs: 0, playtimeMs: 0 },
    eos2: { name: 'Bravo', eosID: 'eos2', team: 2, squad: 1, roles: [], firstSeenMs: 0, lastSeenMs: 0, playtimeMs: 0 },
  };

  const engs = buildEngagements(bullets, [], posBuffer, players, 'test-round');
  assert.equal(engs.length, 1, 'should produce exactly 1 engagement');
  const eng = engs[0];
  // Both players involved
  const involvedEOS = new Set([eng.attackerEOSID, eng.defenderEOSID]);
  assert.ok(involvedEOS.has('eos1') && involvedEOS.has('eos2'), 'engagement must involve eos1 and eos2');
  assert.equal(eng.outcome, 'no_kill', 'no death event → no_kill');
  assert.equal(eng.roundId, 'test-round');
});

test('buildEngagements: engagement outcome is attacker_won when defender dies', () => {
  const bullets = buildBulletEvents([
    makeProjectile({
      time: 1000,
      shooterEOSID: 'eos1',
      to: { x: 3000, y: 0, z: 0 },
      hit: true, victimEOSID: 'eos2'
    })
  ], 0);

  const posBuffer = makePosBuffer([
    { eos: 'eos1', tMs: 1000, x: 0, y: 0, team: 1 },
    { eos: 'eos2', tMs: 1000, x: 2500, y: 0, team: 2 },
  ]);

  const deaths: DeathReport[] = [{
    tMs: 1200,
    cause: 'killed',
    killerEOSID: 'eos1', killerName: 'Alpha', killerTeam: 1,
    victimEOSID: 'eos2', victimName: 'Bravo', victimTeam: 2,
    weapon: 'M4A1', headshot: false, distanceM: 25, teamkill: false,
    attackerPos: { x: 0, y: 0, z: 0 }, victimPos: { x: 2500, y: 0, z: 0 },
    killerElevationM: 0, victimElevationM: 0, highGroundM: 0,
    hasLineOfSight: true, elevationProfile: null, plausibility: null, contributors: []
  } as unknown as DeathReport];

  const players: Record<string, RoundPlayer> = {
    eos1: { name: 'Alpha', eosID: 'eos1', team: 1, squad: 1, roles: [], firstSeenMs: 0, lastSeenMs: 0, playtimeMs: 0 },
    eos2: { name: 'Bravo', eosID: 'eos2', team: 2, squad: 1, roles: [], firstSeenMs: 0, lastSeenMs: 0, playtimeMs: 0 },
  };

  const engs = buildEngagements(bullets, deaths, posBuffer, players, 'r1');
  assert.equal(engs.length, 1);
  // eos1 shot eos2 (hit) and eos2 died → the engagement should have attacker_won or defender_won
  // depending on who is attacker; either way eos2 died
  const eng = engs[0];
  assert.ok(eng.outcome === 'attacker_won' || eng.outcome === 'defender_won', `unexpected outcome: ${eng.outcome}`);
  assert.equal(eng.killerEOSID, 'eos1');
  assert.ok(eng.ttkMs != null && eng.ttkMs >= 0);
});

// ─── aim analysis (LookBuffer + enrichWithAim) ──────────────────────────────────

test('bearingDegSquad: cardinal directions (0 = north, CW)', () => {
  assert.ok(Math.abs(bearingDegSquad(0, 100) - 0) < 1e-9, 'north');
  assert.ok(Math.abs(bearingDegSquad(100, 0) - 90) < 1e-9, 'east');
  assert.ok(Math.abs(bearingDegSquad(0, -100) - 180) < 1e-9, 'south');
  assert.ok(Math.abs(bearingDegSquad(-100, 0) - 270) < 1e-9, 'west');
});

test('elevationDeg + angleBetween basics', () => {
  assert.ok(Math.abs(elevationDeg(100, 0, 0)) < 1e-9, 'level');
  assert.ok(Math.abs(elevationDeg(0, 0, 100) - 90) < 1e-9, 'straight up');
  assert.ok(Math.abs(angleBetween(90, 0, 90, 0)) < 1e-9, 'identical dirs → 0');
  assert.ok(Math.abs(angleBetween(0, 0, 90, 0) - 90) < 1e-6, 'N vs E → 90');
});

test('LookBuffer.atTime: floor within the stale window, null when too old/missing', () => {
  const lb = new LookBuffer();
  lb.addSorted('s', [
    { tMs: 0, pitch: 0, yaw: 0 },
    { tMs: 1000, pitch: 1, yaw: 10 },
    { tMs: 2000, pitch: 2, yaw: 20 },
  ]);
  assert.equal(lb.atTime('s', 1200)?.yaw, 10, 'floor at 1000, 200 ms old → ok');
  assert.equal(lb.atTime('s', 5000), null, '3 s old → stale');
  assert.equal(lb.atTime('missing', 0), null);
});

test('enrichWithAim: PlayerLook scores the crosshair offset from the enemy', () => {
  const bullets = buildBulletEvents([
    makeProjectile({ time: 1000, shooterEOSID: 's', from: { x: 0, y: 0, z: 0 }, to: { x: 4000, y: 0, z: 0 }, hit: false })
  ], 0);
  bullets[0].nearestEnemyEOSID = 't';
  const pos = new PositionBuffer();
  pos.add('t', { tMs: 1000, pos: { x: 5000, y: 0, z: 0 }, yaw: 0, health: 100, team: 2, state: 'alive' });
  const look = new LookBuffer();
  look.add('s', { tMs: 1000, pitch: 2, yaw: 93 }); // target is due-east (90) & level (0)
  enrichWithAim(bullets, look, pos);
  const b = bullets[0];
  assert.equal(b.aimFromLook, true);
  assert.equal(b.aimTargetEOSID, 't');
  assert.ok(Math.abs((b.aimErrorH ?? 0) - 3) < 1e-6, `aimErrorH ${b.aimErrorH} (expected +3 = right)`);
  assert.ok(Math.abs((b.aimErrorV ?? 0) - 2) < 1e-6, `aimErrorV ${b.aimErrorV} (expected +2 = high)`);
  assert.ok((b.aimErrorDeg ?? 0) > 3.5 && (b.aimErrorDeg ?? 0) < 3.7, `aimErrorDeg ${b.aimErrorDeg}`);
});

test('enrichWithAim: a hit without PlayerLook stays unscored (no artifact zero)', () => {
  const bullets = buildBulletEvents([
    makeProjectile({ time: 1000, shooterEOSID: 's', from: { x: 0, y: 0, z: 0 }, to: { x: 5000, y: 0, z: 0 }, hit: true, victimEOSID: 't' })
  ], 0);
  const pos = new PositionBuffer();
  pos.add('t', { tMs: 1000, pos: { x: 5000, y: 0, z: 0 }, yaw: 0, health: 100, team: 2, state: 'alive' });
  enrichWithAim(bullets, new LookBuffer(), pos);
  assert.equal(bullets[0].aimErrorDeg, undefined);
  assert.equal(bullets[0].aimFromLook, undefined);
});

test('enrichWithAim: a miss without PlayerLook falls back to the projectile direction', () => {
  const bullets = buildBulletEvents([
    makeProjectile({ time: 1000, shooterEOSID: 's', from: { x: 0, y: 0, z: 0 }, to: { x: 5000, y: -260, z: 0 }, hit: false })
  ], 0);
  bullets[0].nearestEnemyEOSID = 't';
  const pos = new PositionBuffer();
  pos.add('t', { tMs: 1000, pos: { x: 5000, y: 0, z: 0 }, yaw: 0, health: 100, team: 2, state: 'alive' });
  enrichWithAim(bullets, new LookBuffer(), pos);
  const b = bullets[0];
  assert.equal(b.aimFromLook, false);
  assert.ok(Math.abs(b.aimErrorH ?? 0) > 2 && Math.abs(b.aimErrorH ?? 0) < 4, `aimErrorH ${b.aimErrorH}`);
  assert.ok((b.aimErrorDeg ?? 0) > 0, 'non-zero fallback aim error for a miss');
});
