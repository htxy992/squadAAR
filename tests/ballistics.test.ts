import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTerrainField, analyzeProjectile, classifyWeapon } from '../src/analysis/ballistics.js';
import type { Vec3 } from '../src/parser/events.js';

const bounds = { minX: -100000, minY: -100000, maxX: 100000, maxY: 100000 };

// flat terrain at ~0 plus a tall hill at the origin
function field() {
  const pts: Vec3[] = [];
  for (let x = -100000; x <= 100000; x += 4000) {
    for (let y = -100000; y <= 100000; y += 4000) {
      const hill = 6000 * Math.exp(-((x * x + y * y) / (2 * 25000 * 25000)));
      pts.push({ x, y, z: 100 + hill + 95 });
    }
  }
  return buildTerrainField(bounds, pts);
}

test('weapon classification', () => {
  assert.equal(classifyWeapon('BP_M110').family, 'sniper');
  assert.equal(classifyWeapon('BP_M4A1').family, 'rifle');
  assert.equal(classifyWeapon('BP_M72LAW').family, 'at');
  assert.equal(classifyWeapon('BP_PKP').family, 'mg');
});

test('clear short shot is plausible', () => {
  const f = field();
  const from: Vec3 = { x: -60000, y: 60000, z: 300 };
  const to: Vec3 = { x: -52000, y: 60000, z: 300 };
  const r = analyzeProjectile(f, from, to, classifyWeapon('BP_M4A1'));
  assert.ok(r.score > 0.8, `expected plausible, got ${r.score}`);
  assert.equal(r.flags.length, 0);
});

test('shot through the hill is flagged (no line of sight)', () => {
  const f = field();
  const from: Vec3 = { x: -40000, y: 0, z: 300 };
  const to: Vec3 = { x: 40000, y: 0, z: 300 }; // straight through origin hill
  const r = analyzeProjectile(f, from, to, classifyWeapon('BP_M110'));
  assert.ok(!r.hasLineOfSight, 'should have no LOS');
  assert.ok(r.occlusionDepthM > 5, `expected deep occlusion, got ${r.occlusionDepthM}`);
  assert.ok(r.score < 0.5, `expected suspicious, got ${r.score}`);
});

test('beyond-range shot is flagged', () => {
  const f = field();
  const from: Vec3 = { x: -90000, y: -90000, z: 300 };
  const to: Vec3 = { x: 90000, y: -90000, z: 300 }; // 1800m for a pistol
  const r = analyzeProjectile(f, from, to, classifyWeapon('BP_M9_pistol'));
  assert.ok(!r.withinRange);
  assert.ok(r.flags.some((x) => x.includes('range')));
});
