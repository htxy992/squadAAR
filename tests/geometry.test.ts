import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BVH } from '../src/geometry/bvh.js';
import { SDKMeshGeometry, NullGeometry } from '../src/geometry/provider.js';
import type { Vec3 } from '../src/geometry/bvh.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build a Float32Array of triangles from [ax,ay,az, bx,by,bz, cx,cy,cz] tuples. */
function tris(...ts: number[][]): Float32Array {
  return new Float32Array(ts.flat());
}

/**
 * A horizontal triangle at z=0 spanning:
 *   A=(0,0,0)  B=(1000,0,0)  C=(0,1000,0)
 */
function horizontalTri(): Float32Array {
  return tris(
    [0, 0, 0,  1000, 0, 0,  0, 1000, 0]
  );
}

// ─── BVH construction ─────────────────────────────────────────────────────────

test('BVH: rejects non-multiple-of-9 vertex array', () => {
  assert.throws(() => new BVH(new Float32Array(7)), /multiple of 9/);
});

test('BVH: constructs from empty array', () => {
  const bvh = new BVH(new Float32Array(0));
  const hit = bvh.raycast({ x: 0, y: 0, z: 100 }, { x: 0, y: 0, z: -1 }, 500);
  assert.equal(hit, null, 'empty BVH should return no hits');
});

// ─── BVH raycast ──────────────────────────────────────────────────────────────

test('BVH raycast: hits horizontal triangle from above', () => {
  const bvh = new BVH(horizontalTri());
  // Ray from (100, 100, 500) pointing straight down
  const hit = bvh.raycast(
    { x: 100, y: 100, z: 500 },
    { x: 0, y: 0, z: -1 },
    1000
  );
  assert.ok(hit !== null, 'ray from above should hit');
  assert.ok(Math.abs(hit!.t - 500) < 0.01, `expected t≈500, got ${hit!.t}`);
  assert.ok(Math.abs(hit!.point.z) < 0.1, `hit z should be near 0, got ${hit!.point.z}`);
  assert.equal(hit!.triIndex, 0);
});

test('BVH raycast: misses when ray points away', () => {
  const bvh = new BVH(horizontalTri());
  // Ray pointing UP from below the triangle
  const hit = bvh.raycast(
    { x: 100, y: 100, z: -100 },
    { x: 0, y: 0, z: -1 }, // pointing down, away from triangle
    500
  );
  assert.equal(hit, null, 'ray pointing away should miss');
});

test('BVH raycast: misses outside triangle bounds', () => {
  const bvh = new BVH(horizontalTri());
  // Ray above but outside the triangle XY footprint
  const hit = bvh.raycast(
    { x: 2000, y: 2000, z: 500 },
    { x: 0, y: 0, z: -1 },
    1000
  );
  assert.equal(hit, null, 'ray outside XY footprint should miss');
});

test('BVH raycast: respects maxT limit', () => {
  const bvh = new BVH(horizontalTri());
  // Ray from z=600, triangle at z=0, max distance 400 (can't reach)
  const hit = bvh.raycast(
    { x: 100, y: 100, z: 600 },
    { x: 0, y: 0, z: -1 },
    400
  );
  assert.equal(hit, null, 'ray too short to reach triangle should miss');
});

test('BVH raycast: returns nearest of multiple triangles', () => {
  // Two horizontal triangles: one at z=0, one at z=500
  const verts = tris(
    [0, 0, 500,  1000, 0, 500,  0, 1000, 500],  // tri0 at z=500
    [0, 0, 0,   1000, 0, 0,    0, 1000, 0]       // tri1 at z=0
  );
  const bvh = new BVH(verts);
  const hit = bvh.raycast(
    { x: 100, y: 100, z: 800 },
    { x: 0, y: 0, z: -1 },
    1000
  );
  assert.ok(hit !== null, 'should hit something');
  assert.equal(hit!.triIndex, 0, 'should hit the upper triangle first (tri0)');
  assert.ok(Math.abs(hit!.t - 300) < 0.1, `expected t≈300 (from z=800 to z=500), got ${hit!.t}`);
});

// ─── BVH segmentClear ─────────────────────────────────────────────────────────

test('BVH segmentClear: segment blocked by triangle', () => {
  const bvh = new BVH(horizontalTri());
  // segment from z=500 to z=-500, passes through z=0 plane
  const a: Vec3 = { x: 100, y: 100, z: 500 };
  const b: Vec3 = { x: 100, y: 100, z: -500 };
  assert.equal(bvh.segmentClear(a, b), false, 'segment through triangle should be blocked');
});

test('BVH segmentClear: segment that does not cross triangle', () => {
  const bvh = new BVH(horizontalTri());
  // Both endpoints above triangle
  const a: Vec3 = { x: 100, y: 100, z: 200 };
  const b: Vec3 = { x: 100, y: 100, z: 100 };
  assert.equal(bvh.segmentClear(a, b), true, 'segment above triangle should be clear');
});

test('BVH segmentClear: degenerate segment (same point)', () => {
  const bvh = new BVH(horizontalTri());
  const a: Vec3 = { x: 100, y: 100, z: 50 };
  assert.equal(bvh.segmentClear(a, a), true, 'zero-length segment should be clear');
});

// ─── GeometryProvider ─────────────────────────────────────────────────────────

test('NullGeometry: always returns clear and no hit', () => {
  const g = new NullGeometry();
  assert.equal(g.source, 'null');
  assert.equal(g.segmentClear({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }), true);
  assert.equal(g.raycast({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 1000), null);
});

test('SDKMeshGeometry.fromBuffer: rejects too-short buffer', () => {
  assert.throws(() => SDKMeshGeometry.fromBuffer(Buffer.alloc(10)), /too short/);
});

test('SDKMeshGeometry.fromBuffer: rejects bad magic', () => {
  const buf = Buffer.alloc(36 + 9 * 4);
  buf.writeUInt32LE(0xdeadbeef, 0); // wrong magic
  buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(1, 8);
  assert.throws(() => SDKMeshGeometry.fromBuffer(buf), /bad magic/);
});

test('SDKMeshGeometry.fromBuffer: rejects unsupported version', () => {
  const buf = Buffer.alloc(36 + 9 * 4);
  buf.writeUInt32LE(0x47425153, 0); // "SQBG"
  buf.writeUInt32LE(2, 4);          // version 2
  buf.writeUInt32LE(1, 8);
  assert.throws(() => SDKMeshGeometry.fromBuffer(buf), /unsupported version/);
});

test('SDKMeshGeometry.fromBuffer: parses valid buffer and works with BVH', () => {
  const triCount = 1;
  const HEADER = 4 + 4 + 4 + 6 * 4; // 36
  const buf = Buffer.alloc(HEADER + triCount * 9 * 4);

  buf.writeUInt32LE(0x47425153, 0); // magic
  buf.writeUInt32LE(1, 4);           // version
  buf.writeUInt32LE(triCount, 8);    // 1 triangle
  // bounds
  buf.writeFloatLE(0, 12); buf.writeFloatLE(0, 16); buf.writeFloatLE(-1, 20);
  buf.writeFloatLE(1000, 24); buf.writeFloatLE(1000, 28); buf.writeFloatLE(1, 32);
  // triangle: horizontal at z=0
  const view = new DataView(buf.buffer, buf.byteOffset + HEADER);
  const pts = [0, 0, 0,  1000, 0, 0,  0, 1000, 0];
  for (let i = 0; i < 9; i++) view.setFloat32(i * 4, pts[i], true);

  const geo = SDKMeshGeometry.fromBuffer(buf);
  assert.equal(geo.source, 'sdk');

  // Should block a downward ray
  const hit = geo.raycast({ x: 100, y: 100, z: 500 }, { x: 0, y: 0, z: -1 }, 1000);
  assert.ok(hit !== null, 'should hit the triangle');
  assert.ok(Math.abs(hit!.t - 500) < 0.1);

  // Should block segment through triangle
  assert.equal(
    geo.segmentClear({ x: 100, y: 100, z: 500 }, { x: 100, y: 100, z: -500 }),
    false
  );

  // Should clear segment above triangle
  assert.equal(
    geo.segmentClear({ x: 100, y: 100, z: 200 }, { x: 100, y: 100, z: 50 }),
    true
  );
});
