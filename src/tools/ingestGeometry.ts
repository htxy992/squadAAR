/**
 * OBJ → geometry.bin (SQBG/1) converter.
 *
 * Usage:
 *   npm run ingest:geometry -- <assetKey> <export.obj> [instances.json] [--transform=identity]
 *
 * Supported --transform values (comma-separate to compose):
 *   identity, x_negate, y_negate, z_negate, xy_swap, xz_swap, yz_swap, scale_0.01, scale_100
 *
 * Output:
 *   web/assets/maps/<assetKey>/geometry.bin      (SQBG/1 binary)
 *   web/assets/maps/<assetKey>/geometry.meta.json
 *
 * See docs/CQB_SDK_GEOMETRY.md for the full pipeline.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAGIC = 0x47425153; // "SQBG" little-endian uint32
const VERSION = 1;
const HEADER_BYTES = 4 + 4 + 4 + 6 * 4; // 36

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const assetKey = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const positional = args.filter(a => !a.startsWith('--'));
const [, objPathArg, manifestPathArg] = positional;
const transformArg = (args.find(a => a.startsWith('--transform='))?.slice('--transform='.length) ?? 'identity');

if (!assetKey || !objPathArg) {
  console.error('Usage: npm run ingest:geometry -- <assetKey> <export.obj> [instances.json] [--transform=<...>]');
  console.error('');
  console.error('  assetKey      map key (e.g. "kohat") — determines output directory');
  console.error('  export.obj    world-space OBJ from Unreal "File → Export Selected"');
  console.error('  instances.json  optional provenance manifest from export_squad_geometry.py');
  console.error('  --transform   coordinate remap (default: identity)');
  process.exit(1);
}

// ─── OBJ parser ──────────────────────────────────────────────────────────────

function parseOBJ(text: string): Float32Array {
  const rawVerts: number[] = [];
  const triData: number[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('v ')) {
      // vertex: v x y z [w]
      const parts = line.split(/\s+/);
      rawVerts.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
    } else if (line.startsWith('f ')) {
      // face: vertex indices 1-based, negative = relative from end
      const parts = line.split(/\s+/).slice(1);
      const totalVerts = rawVerts.length / 3;
      const idx = parts.map(p => {
        const vi = parseInt(p.split('/')[0], 10);
        return vi < 0 ? totalVerts + vi : vi - 1; // to 0-based
      }).filter(i => i >= 0 && i < totalVerts);

      if (idx.length < 3) continue;
      // polygon fan triangulation
      for (let i = 1; i < idx.length - 1; i++) {
        const [a, b, c] = [idx[0], idx[i], idx[i + 1]];
        const va = a * 3, vb = b * 3, vc = c * 3;
        triData.push(
          rawVerts[va],     rawVerts[va + 1], rawVerts[va + 2],
          rawVerts[vb],     rawVerts[vb + 1], rawVerts[vb + 2],
          rawVerts[vc],     rawVerts[vc + 1], rawVerts[vc + 2]
        );
      }
    }
  }

  return new Float32Array(triData);
}

// ─── coordinate transforms ────────────────────────────────────────────────────

type XFn = (x: number, y: number, z: number) => [number, number, number];

function composeTransforms(spec: string): XFn {
  const steps: XFn[] = spec.split(',').map(s => {
    switch (s.trim()) {
      case 'identity':   return (x, y, z) => [x, y, z];
      case 'x_negate':   return (x, y, z) => [-x, y, z];
      case 'y_negate':   return (x, y, z) => [x, -y, z];
      case 'z_negate':   return (x, y, z) => [x, y, -z];
      case 'xy_swap':    return (x, y, z) => [y, x, z];
      case 'xz_swap':    return (x, y, z) => [z, y, x];
      case 'yz_swap':    return (x, y, z) => [x, z, y];
      case 'scale_0.01': return (x, y, z) => [x * 0.01, y * 0.01, z * 0.01];
      case 'scale_100':  return (x, y, z) => [x * 100, y * 100, z * 100];
      default:
        console.warn(`  Warning: unknown transform "${s.trim()}" — ignored`);
        return (x, y, z) => [x, y, z];
    }
  });
  return (x, y, z) => {
    let cur: [number, number, number] = [x, y, z];
    for (const fn of steps) cur = fn(...cur);
    return cur;
  };
}

function applyTransform(verts: Float32Array, spec: string): Float32Array {
  if (spec === 'identity') return verts;
  const xfn = composeTransforms(spec);
  const out = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    const [x, y, z] = xfn(verts[i], verts[i + 1], verts[i + 2]);
    out[i] = x; out[i + 1] = y; out[i + 2] = z;
  }
  return out;
}

// ─── bounds ──────────────────────────────────────────────────────────────────

interface Bounds { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number; }

function computeBounds(verts: Float32Array): Bounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

// ─── write SQBG/1 ────────────────────────────────────────────────────────────

function writeGeometryBin(verts: Float32Array, bounds: Bounds): Buffer {
  const triCount = verts.length / 9;
  const totalBytes = HEADER_BYTES + triCount * 9 * 4;
  const buf = Buffer.allocUnsafe(totalBytes);
  buf.writeUInt32LE(MAGIC, 0);
  buf.writeUInt32LE(VERSION, 4);
  buf.writeUInt32LE(triCount, 8);
  buf.writeFloatLE(bounds.minX, 12);
  buf.writeFloatLE(bounds.minY, 16);
  buf.writeFloatLE(bounds.minZ, 20);
  buf.writeFloatLE(bounds.maxX, 24);
  buf.writeFloatLE(bounds.maxY, 28);
  buf.writeFloatLE(bounds.maxZ, 32);
  const view = new DataView(buf.buffer, buf.byteOffset + HEADER_BYTES);
  for (let i = 0; i < verts.length; i++) {
    view.setFloat32(i * 4, verts[i], /* little-endian */ true);
  }
  return buf;
}

// ─── main ────────────────────────────────────────────────────────────────────

console.log(`SquadAAR geometry converter — ${assetKey}`);
console.log(`  OBJ:       ${objPathArg}`);
console.log(`  manifest:  ${manifestPathArg ?? '(none)'}`);
console.log(`  transform: ${transformArg}`);
console.log('');

const objText = await fs.readFile(path.resolve(objPathArg), 'utf8');
console.log(`Parsing OBJ (${(objText.length / 1024 / 1024).toFixed(1)} MB) ...`);
let verts = parseOBJ(objText);
const triCount = verts.length / 9;
console.log(`  → ${triCount.toLocaleString()} triangles from ${(verts.length / 3).toLocaleString()} vertex references`);

if (triCount === 0) {
  console.error('No triangles found — check OBJ file and try again.');
  process.exit(1);
}

verts = applyTransform(verts, transformArg);
const bounds = computeBounds(verts);
const spanX = ((bounds.maxX - bounds.minX) / 100).toFixed(0);
const spanY = ((bounds.maxY - bounds.minY) / 100).toFixed(0);
const spanZ = ((bounds.maxZ - bounds.minZ) / 100).toFixed(0);
console.log(`  bounds: X [${bounds.minX.toFixed(0)}, ${bounds.maxX.toFixed(0)}]  Y [${bounds.minY.toFixed(0)}, ${bounds.maxY.toFixed(0)}]  Z [${bounds.minZ.toFixed(0)}, ${bounds.maxZ.toFixed(0)}] cm`);
console.log(`  span:   ${spanX} × ${spanY} × ${spanZ} m`);

// Read optional instances.json for provenance
interface Manifest {
  mapKey?: string; sourceLayer?: string; sdkVersion?: string;
  exportedAt?: string; filters?: unknown; counts?: unknown;
}
let manifest: Manifest = {};
if (manifestPathArg) {
  try {
    manifest = JSON.parse(await fs.readFile(path.resolve(manifestPathArg), 'utf8'));
    const c = (manifest as any).counts;
    if (c) console.log(`  manifest: ${c.instances ?? '?'} instances, ${c.uniqueMeshes ?? '?'} unique meshes`);
  } catch (err) {
    console.warn(`  Warning: could not read instances.json — provenance incomplete (${err})`);
  }
}

const outDir = path.resolve(process.cwd(), 'web/assets/maps', assetKey);
await fs.mkdir(outDir, { recursive: true });

const binData = writeGeometryBin(verts, bounds);
const binPath = path.join(outDir, 'geometry.bin');
await fs.writeFile(binPath, binData);
console.log(`\nWrote  ${binPath}  (${(binData.length / 1024 / 1024).toFixed(2)} MB)`);

const meta = {
  format: 'SQBG/1',
  mapKey: manifest.mapKey ?? assetKey,
  assetKey,
  sourceLayer: manifest.sourceLayer ?? null,
  sdkVersion: manifest.sdkVersion ?? null,
  exportedAt: manifest.exportedAt ?? new Date().toISOString(),
  convertedAt: new Date().toISOString(),
  units: 'cm',
  frame: 'unreal-world (same as PlayerPos telemetry)',
  coordinateTransform: transformArg,
  triangleCount: triCount,
  bounds,
  filters: manifest.filters ?? null,
  verified: { method: 'minimap-overlay + LOS spot-check', killsChecked: 0, status: 'PENDING' }
};
const metaPath = path.join(outDir, 'geometry.meta.json');
await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
console.log(`Wrote  ${metaPath}`);

console.log(`\nVerification checklist (docs/CQB_SDK_GEOMETRY.md §7):`);
console.log(`  [ ] Minimap overlay: building footprints align with minimap`);
console.log(`  [ ] Z sanity: roofs above floors, floors match DEM terrain`);
console.log(`  [ ] LOS spot-check: open kills → segmentClear=true, walls → false`);
console.log(`  When passing: set geometry.meta.json verified.status = "PASS"`);
