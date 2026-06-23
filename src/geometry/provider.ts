/**
 * Source-agnostic interface for building LOS / raycast queries against
 * structural geometry. Implemented by SDKMeshGeometry (real 3D mesh from
 * the Squad SDK) and NullGeometry (pass-through when no geometry is loaded).
 *
 * See docs/CQB_SDK_GEOMETRY.md for the full pipeline.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BVH, type RayHit, type Vec3 } from './bvh.js';

export type { Vec3, RayHit };

export interface GeometryProvider {
  readonly source: 'sdk' | 'null';
  readonly bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };

  /** true when the straight segment a→b is unobstructed by buildings. */
  segmentClear(a: Vec3, b: Vec3): boolean;

  /** Nearest building hit along origin+dir within maxDistCm, or null. */
  raycast(origin: Vec3, dir: Vec3, maxDistCm: number): RayHit | null;
}

// ─── Null provider (no geometry loaded) ─────────────────────────────────────

export class NullGeometry implements GeometryProvider {
  readonly source = 'null' as const;
  readonly bounds = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  segmentClear(_a: Vec3, _b: Vec3): boolean { return true; }
  raycast(_origin: Vec3, _dir: Vec3, _maxDistCm: number): RayHit | null { return null; }
}

// ─── SDK mesh geometry (loads geometry.bin SQBG/1) ───────────────────────────

/**
 * SQBG/1 binary layout (little-endian):
 *   [0]   char[4]        magic "SQBG"
 *   [4]   uint32         version = 1
 *   [8]   uint32         triangleCount N
 *   [12]  float32[6]     bounds: minX,minY,minZ,maxX,maxY,maxZ (cm)
 *   [36]  float32[9*N]   triangles: ax,ay,az, bx,by,bz, cx,cy,cz (world cm)
 */
const MAGIC = 0x47425153; // "SQBG" as little-endian uint32
const VERSION = 1;
const HEADER_BYTES = 4 + 4 + 4 + 6 * 4; // 36

export class SDKMeshGeometry implements GeometryProvider {
  readonly source = 'sdk' as const;
  readonly bounds: GeometryProvider['bounds'];
  private readonly bvh: BVH;

  private constructor(verts: Float32Array, bounds: GeometryProvider['bounds']) {
    this.bounds = bounds;
    this.bvh = new BVH(verts);
  }

  segmentClear(a: Vec3, b: Vec3): boolean { return this.bvh.segmentClear(a, b); }
  raycast(origin: Vec3, dir: Vec3, maxDistCm: number): RayHit | null { return this.bvh.raycast(origin, dir, maxDistCm); }

  static fromBuffer(buf: Buffer): SDKMeshGeometry {
    if (buf.length < HEADER_BYTES) throw new Error('geometry.bin: too short');
    const magic = buf.readUInt32LE(0);
    if (magic !== MAGIC) throw new Error(`geometry.bin: bad magic 0x${magic.toString(16)}`);
    const version = buf.readUInt32LE(4);
    if (version !== VERSION) throw new Error(`geometry.bin: unsupported version ${version}`);
    const triCount = buf.readUInt32LE(8);
    const bounds = {
      minX: buf.readFloatLE(12), minY: buf.readFloatLE(16), minZ: buf.readFloatLE(20),
      maxX: buf.readFloatLE(24), maxY: buf.readFloatLE(28), maxZ: buf.readFloatLE(32)
    };
    const expectedBytes = HEADER_BYTES + triCount * 9 * 4;
    if (buf.length < expectedBytes) throw new Error(`geometry.bin: expected ${expectedBytes} B, got ${buf.length}`);
    const verts = new Float32Array(buf.buffer, buf.byteOffset + HEADER_BYTES, triCount * 9);
    return new SDKMeshGeometry(Float32Array.from(verts), bounds);
  }
}

// ─── loader ──────────────────────────────────────────────────────────────────

/**
 * Try to load `web/assets/maps/<assetKey>/geometry.bin`.
 * Returns NullGeometry if the file is absent (non-fatal).
 */
export async function tryLoadGeometry(assetKey: string): Promise<GeometryProvider> {
  if (!assetKey) return new NullGeometry();
  const file = path.resolve(process.cwd(), 'web/assets/maps', assetKey, 'geometry.bin');
  try {
    const buf = await fs.readFile(file);
    return SDKMeshGeometry.fromBuffer(buf);
  } catch {
    return new NullGeometry();
  }
}

/** Synchronous variant (for use in non-async contexts). */
export function tryLoadGeometrySync(assetKey: string): GeometryProvider {
  if (!assetKey) return new NullGeometry();
  const file = path.resolve(process.cwd(), 'web/assets/maps', assetKey, 'geometry.bin');
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const buf = readFileSync(file);
    return SDKMeshGeometry.fromBuffer(buf);
  } catch {
    return new NullGeometry();
  }
}
