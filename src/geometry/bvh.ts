/**
 * Bounding-Volume Hierarchy over a triangle soup for fast ray/segment queries.
 *
 * All coordinates are in the same world-cm frame as PlayerPos telemetry.
 * A triangle is 9 floats [ax,ay,az, bx,by,bz, cx,cy,cz].
 */

export interface Vec3 { x: number; y: number; z: number; }
export interface RayHit { /** Ray parameter t (distance from origin). */ t: number; point: Vec3; triIndex: number; }

interface AABB { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number; }

interface BVHNode {
  box: AABB;
  left?: BVHNode;
  right?: BVHNode;
  /** leaf: triangle indices in this node */
  tris?: number[];
}

const LEAF_MAX = 8; // max triangles per leaf

// ─── build ───────────────────────────────────────────────────────────────────

export class BVH {
  private readonly verts: Float32Array;
  private root: BVHNode;

  constructor(verts: Float32Array) {
    if (verts.length % 9 !== 0) throw new Error('BVH: vertex array length must be multiple of 9');
    this.verts = verts;
    const count = verts.length / 9;
    const indices = Array.from({ length: count }, (_, i) => i);
    this.root = buildNode(verts, indices);
  }

  /**
   * Returns the nearest intersection along the ray (origin + t*dir, t ∈ [0, maxT]).
   * `maxT` is in the same unit as the coordinates (cm).
   */
  raycast(origin: Vec3, dir: Vec3, maxT: number): RayHit | null {
    return raycastNode(this.root, this.verts, origin, dir, maxT);
  }

  /**
   * Returns true if the segment from `a` to `b` is unobstructed by any triangle.
   */
  segmentClear(a: Vec3, b: Vec3): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return true;
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    return raycastNode(this.root, this.verts, a, dir, len) === null;
  }
}

// ─── node construction ───────────────────────────────────────────────────────

function buildNode(verts: Float32Array, tris: number[]): BVHNode {
  const box = computeAABB(verts, tris);
  if (tris.length <= LEAF_MAX) return { box, tris };

  // Split on the longest axis at the median centroid
  const axis = longestAxis(box);
  const centroids = tris.map(i => centroid(verts, i, axis));
  const median = select(centroids, Math.floor(tris.length / 2));

  const left: number[] = [], right: number[] = [];
  for (let k = 0; k < tris.length; k++) {
    (centroids[k] <= median ? left : right).push(tris[k]);
  }
  // Guard against degenerate splits
  if (!left.length || !right.length) return { box, tris };

  return {
    box,
    left: buildNode(verts, left),
    right: buildNode(verts, right)
  };
}

function computeAABB(verts: Float32Array, tris: number[]): AABB {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const i of tris) {
    const base = i * 9;
    for (let v = 0; v < 3; v++) {
      const x = verts[base + v * 3], y = verts[base + v * 3 + 1], z = verts[base + v * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function longestAxis(b: AABB): 0 | 1 | 2 {
  const dx = b.maxX - b.minX, dy = b.maxY - b.minY, dz = b.maxZ - b.minZ;
  return dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;
}

function centroid(verts: Float32Array, triIdx: number, axis: 0 | 1 | 2): number {
  const base = triIdx * 9;
  return (verts[base + axis] + verts[base + 3 + axis] + verts[base + 6 + axis]) / 3;
}

/** Quickselect for median in O(n) average time. */
function select(arr: number[], k: number): number {
  const a = arr.slice();
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo - 1, j = hi + 1;
    while (true) {
      do i++; while (a[i] < pivot);
      do j--; while (a[j] > pivot);
      if (i >= j) break;
      [a[i], a[j]] = [a[j], a[i]];
    }
    if (j < k) lo = j + 1; else hi = j;
  }
  return a[k];
}

// ─── ray/AABB intersection ───────────────────────────────────────────────────

function rayAABB(box: AABB, o: Vec3, inv: Vec3, maxT: number): boolean {
  const tx1 = (box.minX - o.x) * inv.x, tx2 = (box.maxX - o.x) * inv.x;
  const ty1 = (box.minY - o.y) * inv.y, ty2 = (box.maxY - o.y) * inv.y;
  const tz1 = (box.minZ - o.z) * inv.z, tz2 = (box.maxZ - o.z) * inv.z;
  const tmin = Math.max(Math.min(tx1, tx2), Math.min(ty1, ty2), Math.min(tz1, tz2), 0);
  const tmax = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2), Math.max(tz1, tz2), maxT);
  return tmin <= tmax;
}

// ─── Möller–Trumbore ray-triangle intersection ───────────────────────────────

const EPS = 1e-9;

function rayTri(verts: Float32Array, triIdx: number, o: Vec3, d: Vec3): number | null {
  const base = triIdx * 9;
  const ax = verts[base], ay = verts[base + 1], az = verts[base + 2];
  const e1x = verts[base + 3] - ax, e1y = verts[base + 4] - ay, e1z = verts[base + 5] - az;
  const e2x = verts[base + 6] - ax, e2y = verts[base + 7] - ay, e2z = verts[base + 8] - az;

  const hx = d.y * e2z - d.z * e2y;
  const hy = d.z * e2x - d.x * e2z;
  const hz = d.x * e2y - d.y * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < EPS) return null;

  const inv = 1 / det;
  const sx = o.x - ax, sy = o.y - ay, sz = o.z - az;
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < 0 || u > 1) return null;

  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
  if (v < 0 || u + v > 1) return null;

  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > EPS ? t : null;
}

function raycastNode(node: BVHNode, verts: Float32Array, o: Vec3, d: Vec3, maxT: number): RayHit | null {
  const inv: Vec3 = {
    x: d.x === 0 ? Infinity : 1 / d.x,
    y: d.y === 0 ? Infinity : 1 / d.y,
    z: d.z === 0 ? Infinity : 1 / d.z
  };
  return _traverse(node, verts, o, d, inv, maxT);
}

function _traverse(node: BVHNode, verts: Float32Array, o: Vec3, d: Vec3, inv: Vec3, maxT: number): RayHit | null {
  if (!rayAABB(node.box, o, inv, maxT)) return null;
  if (node.tris) {
    let best: RayHit | null = null;
    for (const i of node.tris) {
      const t = rayTri(verts, i, o, d);
      if (t !== null && t <= maxT && (best === null || t < best.t)) {
        best = {
          t,
          triIndex: i,
          point: { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t }
        };
        maxT = t; // shrink search window
      }
    }
    return best;
  }
  const l = node.left ? _traverse(node.left, verts, o, d, inv, maxT) : null;
  if (l) maxT = l.t;
  const r = node.right ? _traverse(node.right, verts, o, d, inv, maxT) : null;
  return r ?? l;
}
